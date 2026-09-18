"""Loss-free staging of a Suno/Harvester cache (backend.modules.library.suno_stage).

Nothing here touches the user's real cache or the production library: every
fixture is written under ``tmp_path`` and the staging database lives in a
throwaway stage root. No network, no model weights.

The properties under test are the ones the old title-keyed importer broke:
identity is the provider song id (never the title), every observed version of a
record survives, malformed rows are quarantined instead of aborting the import,
media is referenced in place and never copied, and an interrupted run resumes to
exactly the same counts.
"""

from __future__ import annotations

import importlib.util
import io
import json
import signal
import sqlite3
import uuid
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Iterator

import pytest

from backend.modules.library import suno_stage

REPO_ROOT = Path(__file__).resolve().parents[1]
INGEST_SCRIPT = REPO_ROOT / "scripts" / "ingest_suno_cache.py"
STAGE_SCRIPT = REPO_ROOT / "scripts" / "stage_suno_cache.py"


# ---------------------------------------------------------------------------
# Fixtures helpers
# ---------------------------------------------------------------------------


def _song(song_id: str, **fields: Any) -> dict[str, Any]:
    """One API-compatible cache record with sensible defaults."""
    record: dict[str, Any] = {
        "id": song_id,
        "title": f"Song {song_id}",
        "status": "complete",
        "audio_url": f"https://cdn.example.invalid/{song_id}.mp3",
        "created_at": "2026-01-01T00:00:00Z",
        "metadata": {"duration": 123.5, "style": "synthwave"},
    }
    record.update(fields)
    return record


def _write_jsonl(path: Path, records: Iterable[Any]) -> Path:
    lines = [
        record if isinstance(record, str) else json.dumps(record, ensure_ascii=False)
        for record in records
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


@contextmanager
def _connect(stage_root: Path) -> Iterator[sqlite3.Connection]:
    """Read-only-ish reader that always closes, so tmp dirs clean up on Windows."""
    connection = sqlite3.connect(suno_stage.stage_db_path(stage_root))
    connection.row_factory = sqlite3.Row
    try:
        yield connection
    finally:
        connection.close()


def _count(stage_root: Path, table: str) -> int:
    with _connect(stage_root) as connection:
        return int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def _asset(stage_root: Path, external_id: str) -> sqlite3.Row:
    with _connect(stage_root) as connection:
        row = connection.execute(
            "SELECT * FROM staged_assets WHERE external_id=?", (external_id,)
        ).fetchone()
    assert row is not None, f"no staged asset for {external_id}"
    return row


def _uuid(seed: int) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"suno-test-{seed}"))


def _revision_counts_are_consistent(stage_root: Path) -> bool:
    """Every asset's ``revision_count`` equals the revisions actually stored.

    The invariant a rolled-back batch must never break: an asset row and its
    first revision row are written in one transaction, so a crash can leave
    neither but never only one of them.
    """
    with _connect(stage_root) as connection:
        mismatched = connection.execute(
            "SELECT COUNT(*) FROM staged_assets a WHERE a.revision_count <> ("
            " SELECT COUNT(*) FROM asset_revisions r WHERE r.asset_id = a.id)"
        ).fetchone()[0]
    return int(mismatched) == 0


# ---------------------------------------------------------------------------
# Identity: the provider id, never the title
# ---------------------------------------------------------------------------


def test_ten_songs_sharing_one_title_all_survive(tmp_path: Path) -> None:
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [_song(f"id-{index}", title="Neon Rain") for index in range(10)],
    )

    report = suno_stage.stage_cache(source, tmp_path / "stage")

    assert report.accepted == 10
    assert report.distinct_identities == 10
    assert report.same_title_different_id == 10
    assert _count(tmp_path / "stage", "staged_assets") == 10


def test_two_ids_with_the_same_audio_url_stay_two_records(tmp_path: Path) -> None:
    shared = "https://cdn.example.invalid/shared.mp3"
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [_song("id-a", audio_url=shared), _song("id-b", audio_url=shared)],
    )

    report = suno_stage.stage_cache(source, tmp_path / "stage")

    assert report.distinct_identities == 2
    assert _asset(tmp_path / "stage", "id-a")["audio_url"] == shared
    assert _asset(tmp_path / "stage", "id-b")["audio_url"] == shared


def test_changed_content_under_one_id_keeps_two_revisions(tmp_path: Path) -> None:
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [_song("id-a", title="First"), _song("id-a", title="Second")],
    )

    report = suno_stage.stage_cache(source, tmp_path / "stage")

    assert report.distinct_identities == 1
    assert report.revisions == 2
    assert report.accepted == 2
    assert report.duplicate == 0
    with _connect(tmp_path / "stage") as connection:
        titles = {
            json.loads(row["raw_json"])["title"]
            for row in connection.execute("SELECT raw_json FROM asset_revisions")
        }
    assert titles == {"First", "Second"}


def test_identical_record_twice_counts_as_duplicate(tmp_path: Path) -> None:
    source = _write_jsonl(tmp_path / "cache.jsonl", [_song("id-a"), _song("id-a")])

    report = suno_stage.stage_cache(source, tmp_path / "stage")

    assert (report.accepted, report.duplicate, report.revisions) == (1, 1, 1)


def test_empty_title_is_kept(tmp_path: Path) -> None:
    source = _write_jsonl(tmp_path / "cache.jsonl", [_song("id-a", title="")])

    report = suno_stage.stage_cache(source, tmp_path / "stage")

    assert report.accepted == 1
    assert _asset(tmp_path / "stage", "id-a")["title"] == ""
    assert report.same_title_different_id == 0


def test_unicode_titles_and_lyrics_round_trip(tmp_path: Path) -> None:
    title = "Chëṛry 🌸 夜の街"
    lyrics = "Я помню\nчудное мгновенье — ♪"
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [_song("id-a", title=title, metadata={"lyrics": lyrics, "style": "città"})],
    )

    suno_stage.stage_cache(source, tmp_path / "stage")

    row = _asset(tmp_path / "stage", "id-a")
    assert row["title"] == title
    assert row["lyrics"] == lyrics
    assert row["style"] == "città"
    with _connect(tmp_path / "stage") as connection:
        raw = connection.execute("SELECT raw_json FROM asset_revisions").fetchone()[0]
    assert json.loads(raw)["title"] == title


# ---------------------------------------------------------------------------
# Normalized fields
# ---------------------------------------------------------------------------


def test_unknown_duration_stays_null_and_is_never_zero(tmp_path: Path) -> None:
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [
            _song("no-duration", metadata={}),
            _song("zero-duration", metadata={"duration": 0}),
            _song("bad-duration", metadata={"duration": "unknown"}),
            _song("real-duration", metadata={"duration": 61.25}),
        ],
    )

    suno_stage.stage_cache(source, tmp_path / "stage")

    stage_root = tmp_path / "stage"
    assert _asset(stage_root, "no-duration")["duration"] is None
    assert _asset(stage_root, "zero-duration")["duration"] is None
    assert _asset(stage_root, "bad-duration")["duration"] is None
    assert _asset(stage_root, "real-duration")["duration"] == pytest.approx(61.25)


def test_model_name_and_status_are_preserved_verbatim(tmp_path: Path) -> None:
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [_song("id-a", model_name="chirp-v5-Preview", status="streaming")],
    )

    suno_stage.stage_cache(source, tmp_path / "stage")

    row = _asset(tmp_path / "stage", "id-a")
    assert row["model_name"] == "chirp-v5-Preview"
    assert row["status"] == "streaming"


def test_unparseable_created_at_stays_null(tmp_path: Path) -> None:
    source = _write_jsonl(
        tmp_path / "cache.jsonl", [_song("id-a", created_at="last thursday")]
    )

    suno_stage.stage_cache(source, tmp_path / "stage")

    assert _asset(tmp_path / "stage", "id-a")["created_at"] is None


# ---------------------------------------------------------------------------
# Lineage
# ---------------------------------------------------------------------------


def test_cover_whose_parent_appears_last_resolves(tmp_path: Path) -> None:
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [
            _song("child", metadata={"cover_audio_id": "parent"}),
            _song("filler"),
            _song("parent"),
        ],
    )

    report = suno_stage.stage_cache(source, tmp_path / "stage")

    assert report.unresolved_lineage == 0
    with _connect(tmp_path / "stage") as connection:
        edge = connection.execute("SELECT * FROM lineage_edges").fetchone()
    assert edge["child_external_id"] == "child"
    assert edge["parent_external_id"] == "parent"
    assert edge["relation"] == "cover_of"
    assert edge["evidence_path"] == "metadata.cover_audio_id"


def test_multi_parent_mashup_keeps_all_parents(tmp_path: Path) -> None:
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [
            _song("mash", metadata={"mashup_clip_ids": ["p1", "p2", "p3"]}),
            _song("p1"),
            _song("p2"),
        ],
    )

    report = suno_stage.stage_cache(source, tmp_path / "stage")

    with _connect(tmp_path / "stage") as connection:
        rows = connection.execute(
            "SELECT parent_external_id, relation, evidence_path FROM lineage_edges "
            "WHERE child_external_id='mash' ORDER BY parent_external_id"
        ).fetchall()
    assert [row["parent_external_id"] for row in rows] == ["p1", "p2", "p3"]
    assert {row["relation"] for row in rows} == {"mashup_source"}
    assert rows[2]["evidence_path"] == "metadata.mashup_clip_ids[2]"
    # p3 was never staged: the edge stays, the child is never dropped.
    assert report.unresolved_lineage == 1
    assert _asset(tmp_path / "stage", "mash")["external_id"] == "mash"


def test_extend_and_stem_hints_become_typed_edges(tmp_path: Path) -> None:
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [
            _song(
                "child",
                metadata={"continue_clip_id": "root", "stem_from_id": "root"},
                ancestry={"parent_id": "root"},
            ),
            _song("root"),
        ],
    )

    suno_stage.stage_cache(source, tmp_path / "stage")

    with _connect(tmp_path / "stage") as connection:
        relations = {
            row["relation"]
            for row in connection.execute("SELECT relation FROM lineage_edges")
        }
    assert relations == {"extension_of", "stem_of", "derived_from"}


def test_self_referencing_parent_is_not_an_edge(tmp_path: Path) -> None:
    source = _write_jsonl(
        tmp_path / "cache.jsonl", [_song("id-a", metadata={"cover_audio_id": "id-a"})]
    )

    report = suno_stage.stage_cache(source, tmp_path / "stage")

    assert _count(tmp_path / "stage", "lineage_edges") == 0
    assert report.unresolved_lineage == 0


# ---------------------------------------------------------------------------
# Availability and media (reference in place; nothing is copied)
# ---------------------------------------------------------------------------


def test_missing_audio_is_kept_with_an_availability_state(tmp_path: Path) -> None:
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [
            _song("pending", status="submitted", audio_url=None),
            _song("remote", status="complete"),
        ],
    )

    report = suno_stage.stage_cache(source, tmp_path / "stage")

    assert report.accepted == 2
    assert _asset(tmp_path / "stage", "pending")["availability"] == "missing"
    assert _asset(tmp_path / "stage", "remote")["availability"] == "remote-only"
    assert report.media_missing == 1
    assert report.media_remote_only == 1


def test_local_media_matches_on_id_never_on_title(tmp_path: Path) -> None:
    media_root = tmp_path / "media"
    media_root.mkdir()
    matched_id = _uuid(1)
    (media_root / f"Neon Rain - {matched_id}.mp3").write_bytes(b"audio-bytes")
    (media_root / f"{matched_id}.png").write_bytes(b"png-bytes")
    # Same title, different id: the title match must NOT be used.
    (media_root / "Neon Rain.mp3").write_bytes(b"decoy")
    other_id = _uuid(2)
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [
            _song(matched_id, title="Neon Rain"),
            _song(other_id, title="Neon Rain"),
        ],
    )

    report = suno_stage.stage_cache(source, tmp_path / "stage", media_root=media_root)

    assert _asset(tmp_path / "stage", matched_id)["availability"] == "local-verified"
    assert _asset(tmp_path / "stage", other_id)["availability"] == "remote-only"
    assert report.media_local_verified == 1
    assert report.media_remote_only == 1
    with _connect(tmp_path / "stage") as connection:
        kinds = {
            row["kind"]: row["matched_by"]
            for row in connection.execute("SELECT kind, matched_by FROM staged_media")
        }
    assert kinds == {"audio": "id-match", "artwork": "id-match"}
    # Nothing was copied into the stage root.
    assert not list((tmp_path / "stage").rglob("*.mp3"))
    assert (media_root / f"Neon Rain - {matched_id}.mp3").read_bytes() == b"audio-bytes"


def test_manifest_path_that_is_absent_is_local_unverified(tmp_path: Path) -> None:
    media_root = tmp_path / "media"
    media_root.mkdir()
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [_song("id-a", local_audio_path="gone/never-written.mp3")],
    )

    report = suno_stage.stage_cache(source, tmp_path / "stage", media_root=media_root)

    assert _asset(tmp_path / "stage", "id-a")["availability"] == "local-unverified"
    assert report.media_local_unverified == 1


def test_unsafe_relative_media_path_is_rejected(tmp_path: Path) -> None:
    media_root = tmp_path / "media"
    media_root.mkdir()
    (tmp_path / "outside.mp3").write_bytes(b"secret")
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [_song("id-a", local_audio_path="../outside.mp3")],
    )

    report = suno_stage.stage_cache(source, tmp_path / "stage", media_root=media_root)

    # The song survives; only the path is refused.
    assert report.accepted == 1
    assert report.media_rejected == 1
    assert _asset(tmp_path / "stage", "id-a")["availability"] == "remote-only"
    with _connect(tmp_path / "stage") as connection:
        rejection = connection.execute("SELECT * FROM media_rejections").fetchone()
    assert rejection["field"] == "local_audio_path"
    assert "outside" in rejection["value"]
    assert _count(tmp_path / "stage", "staged_media") == 0


def test_resolve_media_path_refuses_escapes(tmp_path: Path) -> None:
    root = tmp_path / "media"
    root.mkdir()

    for bad in ("../escape.mp3", "a/../../escape.mp3", ""):
        with pytest.raises(suno_stage.MediaPathError):
            suno_stage.resolve_media_path(root, bad)
    with pytest.raises(suno_stage.MediaPathError):
        suno_stage.resolve_media_path(root, str(tmp_path / "escape.mp3"))

    assert (
        suno_stage.resolve_media_path(root, "inside/song.mp3")
        == (root / "inside" / "song.mp3").resolve()
    )


# ---------------------------------------------------------------------------
# Quarantine
# ---------------------------------------------------------------------------


def test_malformed_row_is_quarantined_and_later_rows_import(tmp_path: Path) -> None:
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [
            _song("first"),
            "{not json at all",
            json.dumps(["an array, not an object"]),
            json.dumps({"title": "no id here"}),
            _song("last"),
        ],
    )

    report = suno_stage.stage_cache(source, tmp_path / "stage")

    assert report.quarantined == 3
    assert report.accepted == 2
    assert _asset(tmp_path / "stage", "last")["external_id"] == "last"
    with _connect(tmp_path / "stage") as connection:
        rows = connection.execute(
            "SELECT ordinal, reason, raw FROM quarantine ORDER BY ordinal"
        ).fetchall()
    assert [row["ordinal"] for row in rows] == [2, 3, 4]
    assert all(row["reason"] for row in rows)
    assert "not json at all" in rows[0]["raw"]


# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------


def test_secrets_are_stripped_from_the_stored_raw_json(tmp_path: Path) -> None:
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [
            _song(
                "id-a",
                cookie="session=SUPERSECRET",
                audio_url=(
                    "https://cdn.example.invalid/a.mp3"
                    "?token=TOKENSECRET&Signature=SIGSECRET&ok=keepme"
                ),
                metadata={
                    "Authorization": "Bearer BEARERSECRET",
                    "nested": {"refresh_token": "REFRESHSECRET"},
                    "style": "keep this",
                },
            )
        ],
    )

    suno_stage.stage_cache(source, tmp_path / "stage")

    with _connect(tmp_path / "stage") as connection:
        raw = connection.execute("SELECT raw_json FROM asset_revisions").fetchone()[0]
    for secret in (
        "SUPERSECRET",
        "TOKENSECRET",
        "SIGSECRET",
        "BEARERSECRET",
        "REFRESHSECRET",
    ):
        assert secret not in raw
    assert "keep this" in raw
    assert "keepme" in raw
    assert _asset(tmp_path / "stage", "id-a")["style"] == "keep this"


def test_userinfo_is_stripped_from_urls(tmp_path: Path) -> None:
    assert suno_stage.sanitize("https://user:pw@cdn.example.invalid/a.mp3") == (
        "https://cdn.example.invalid/a.mp3"
    )


# ---------------------------------------------------------------------------
# Resume, rerun, reconciliation
# ---------------------------------------------------------------------------


def _mixed_cache(path: Path) -> Path:
    return _write_jsonl(
        path,
        [
            _song("a", title="Twin"),
            _song("b", title="Twin"),
            "{broken",
            _song("c", metadata={"cover_audio_id": "a"}),
            _song("c", metadata={"cover_audio_id": "a"}),
            _song("d", title="Twin", audio_url=None),
            _song("e", metadata={"mashup_clip_ids": ["zz"]}),
            _song("f", title="Solo"),
        ],
    )


def test_report_reconciles(tmp_path: Path) -> None:
    source = _mixed_cache(tmp_path / "cache.jsonl")

    report = suno_stage.stage_cache(source, tmp_path / "stage")

    assert report.seen == 8
    assert report.seen == report.accepted + report.duplicate + report.quarantined
    assert report.reconciles
    assert report.distinct_identities == 6
    assert report.same_title_different_id == 3
    assert report.unresolved_lineage == 1
    assert report.to_dict()["seen"] == 8


def test_interrupted_run_resumes_to_the_same_counts(tmp_path: Path) -> None:
    source = _mixed_cache(tmp_path / "cache.jsonl")
    clean = suno_stage.stage_cache(source, tmp_path / "clean", batch_size=3)

    interrupted = tmp_path / "resumed"
    stops: list[suno_stage.StageProgress] = []

    def stop_after_first_batch(progress: suno_stage.StageProgress) -> None:
        stops.append(progress)
        if len(stops) == 1:
            raise RuntimeError("simulated interruption")

    with pytest.raises(RuntimeError, match="simulated interruption"):
        suno_stage.stage_cache(
            source, interrupted, batch_size=3, on_commit=stop_after_first_batch
        )
    assert _count(interrupted, "staged_assets") < clean.distinct_identities

    resumed = suno_stage.stage_cache(source, interrupted, batch_size=3)

    assert resumed.to_dict() | {"database": ""} == clean.to_dict() | {"database": ""}
    assert _count(interrupted, "asset_revisions") == clean.revisions
    assert _count(interrupted, "staged_assets") == clean.distinct_identities


def test_rerunning_a_finished_import_adds_no_new_records(tmp_path: Path) -> None:
    source = _mixed_cache(tmp_path / "cache.jsonl")
    stage_root = tmp_path / "stage"
    first = suno_stage.stage_cache(source, stage_root)
    before = {
        table: _count(stage_root, table)
        for table in ("staged_assets", "asset_revisions", "lineage_edges", "quarantine")
    }

    second = suno_stage.stage_cache(source, stage_root)

    assert second.to_dict() == first.to_dict()
    assert {
        table: _count(stage_root, table)
        for table in ("staged_assets", "asset_revisions", "lineage_edges", "quarantine")
    } == before


def test_incomplete_run_needs_an_explicit_resume(tmp_path: Path) -> None:
    source = _mixed_cache(tmp_path / "cache.jsonl")
    stage_root = tmp_path / "stage"

    def boom(progress: suno_stage.StageProgress) -> None:
        raise RuntimeError("simulated interruption")

    with pytest.raises(RuntimeError, match="simulated interruption"):
        suno_stage.stage_cache(source, stage_root, batch_size=2, on_commit=boom)

    with pytest.raises(suno_stage.IncompleteRunError):
        suno_stage.stage_cache(source, stage_root, batch_size=2, resume=False)


# ---------------------------------------------------------------------------
# Staging database guards
# ---------------------------------------------------------------------------


def test_refuses_a_database_that_is_not_a_staging_database(tmp_path: Path) -> None:
    stage_root = tmp_path / "stage"
    stage_root.mkdir()
    foreign = sqlite3.connect(suno_stage.stage_db_path(stage_root))
    foreign.execute("CREATE TABLE entries(id TEXT PRIMARY KEY)")
    foreign.commit()
    foreign.close()
    source = _write_jsonl(tmp_path / "cache.jsonl", [_song("id-a")])

    with pytest.raises(suno_stage.StagingDatabaseError):
        suno_stage.stage_cache(source, stage_root)


def test_refuses_to_stage_into_the_source_file(tmp_path: Path) -> None:
    stage_root = tmp_path / "stage"
    stage_root.mkdir()
    source = _write_jsonl(suno_stage.stage_db_path(stage_root), [_song("id-a")])

    with pytest.raises(ValueError):
        suno_stage.stage_cache(source, stage_root)


def test_batch_size_must_be_positive(tmp_path: Path) -> None:
    source = _write_jsonl(tmp_path / "cache.jsonl", [_song("id-a")])

    with pytest.raises(ValueError):
        suno_stage.stage_cache(source, tmp_path / "stage", batch_size=0)


def test_large_json_without_ijson_explains_the_dependency(tmp_path: Path) -> None:
    source = tmp_path / "cache.json"
    source.write_text(
        json.dumps({"songs": [_song("id-a"), _song("id-b")]}), encoding="utf-8"
    )

    if importlib.util.find_spec("ijson") is None:
        with pytest.raises(RuntimeError) as excinfo:
            suno_stage.stage_cache(source, tmp_path / "stage")
        assert "uv add ijson" in str(excinfo.value)
    else:  # pragma: no cover - only when the optional dependency is installed
        report = suno_stage.stage_cache(source, tmp_path / "stage")
        assert report.accepted == 2


# ---------------------------------------------------------------------------
# The old CLI: defect fixes only
# ---------------------------------------------------------------------------


def _load_script(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_ingest_script(name: str = "ingest_suno_cache_under_test") -> Any:
    return _load_script(INGEST_SCRIPT, name)


def test_old_script_dedupes_by_id_not_by_title() -> None:
    ingest = _load_ingest_script()
    songs = [
        {
            "id": f"id-{index}",
            "title": "Neon Rain",
            "status": "complete",
            "audio_url": "https://cdn.example.invalid/a.mp3",
            "created_at": f"2026-01-0{index + 1}T00:00:00Z",
        }
        for index in range(3)
    ]
    songs.append(dict(songs[0], created_at="2026-02-01T00:00:00Z", title="Renamed"))

    selected = ingest.dedupe_by_id(songs, None)

    assert [song["id"] for song in sorted(selected, key=lambda s: s["id"])] == [
        "id-0",
        "id-1",
        "id-2",
    ]
    newest = next(song for song in selected if song["id"] == "id-0")
    assert newest["title"] == "Renamed"


def test_old_script_keeps_untitled_songs() -> None:
    ingest = _load_ingest_script()
    songs = [
        {
            "id": "id-a",
            "title": "",
            "status": "complete",
            "audio_url": "https://cdn.example.invalid/a.mp3",
        }
    ]

    assert [song["id"] for song in ingest.dedupe_by_id(songs, None)] == ["id-a"]


def test_old_script_limit_defaults_to_unbounded() -> None:
    ingest = _load_ingest_script()
    parser_default = ingest.build_parser().parse_args([]).limit

    assert parser_default is None
    songs = [
        {
            "id": f"id-{index}",
            "title": f"Song {index}",
            "status": "complete",
            "audio_url": "https://cdn.example.invalid/a.mp3",
        }
        for index in range(6000)
    ]
    assert len(ingest.dedupe_by_id(songs, None)) == 6000
    assert len(ingest.dedupe_by_id(songs, 10)) == 10


def test_old_script_env_cache_path_is_used(monkeypatch: Any, tmp_path: Path) -> None:
    monkeypatch.setenv("SUNO_CACHE_PATH", str(tmp_path / "from-env.json"))
    ingest = _load_ingest_script("ingest_suno_cache_env")

    assert ingest.DEFAULT_CACHE == tmp_path / "from-env.json"

    monkeypatch.delenv("SUNO_CACHE_PATH")
    fallback = _load_ingest_script("ingest_suno_cache_default").DEFAULT_CACHE

    assert fallback.name == "library_cache_API_COMPATIBLE.json"
    assert fallback.is_absolute()


def test_old_script_never_writes_a_zero_duration(tmp_path: Path) -> None:
    ingest = _load_ingest_script()
    library_root = tmp_path / "library"
    songs = [
        {
            "id": "id-a",
            "title": "No duration",
            "status": "complete",
            "audio_url": "https://cdn.example.invalid/a.mp3",
        },
        {
            "id": "id-b",
            "title": "Has duration",
            "status": "complete",
            "audio_url": "https://cdn.example.invalid/b.mp3",
            "metadata": {"duration": 42.5},
        },
    ]

    assert ingest.ingest(songs, library_root) == 2

    unknown = json.loads((library_root / "id-a" / "metadata.json").read_text("utf-8"))
    known = json.loads((library_root / "id-b" / "metadata.json").read_text("utf-8"))
    assert unknown["duration"] is None
    assert known["duration"] == 42.5


def test_old_script_does_not_pip_install() -> None:
    body = INGEST_SCRIPT.read_text(encoding="utf-8")

    assert "pip" not in body
    assert "subprocess" not in body


# ---------------------------------------------------------------------------
# The staging CLI
# ---------------------------------------------------------------------------


def test_stage_cli_prints_a_reconciled_report(tmp_path: Path, capsys: Any) -> None:
    cli = _load_script(STAGE_SCRIPT, "stage_suno_cache_under_test")
    source = _mixed_cache(tmp_path / "cache.jsonl")

    exit_code = cli.main([str(source), "--stage-root", str(tmp_path / "stage")])

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["totals"] == {
        "seen": 8,
        "accepted": 6,
        "duplicate": 1,
        "quarantined": 1,
        "reconciles": True,
    }
    report = payload["reports"][0]
    assert report["source"] == str(source.resolve())
    assert report["distinct_identities"] == 6
    assert report["reconciles"] is True


def test_stage_cli_stages_several_inputs_into_one_root(
    tmp_path: Path, capsys: Any
) -> None:
    cli = _load_script(STAGE_SCRIPT, "stage_suno_cache_multi")
    first = _write_jsonl(tmp_path / "one.jsonl", [_song("a"), _song("b")])
    second = _write_jsonl(tmp_path / "two.jsonl", [_song("c")])
    stage_root = tmp_path / "stage"

    exit_code = cli.main(
        [
            str(first),
            str(second),
            "--stage-root",
            str(stage_root),
            "--namespace",
            "suno",
        ]
    )

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert len(payload["reports"]) == 2
    assert payload["totals"]["seen"] == 3
    assert payload["reports"][1]["distinct_identities"] == 3
    assert _count(stage_root, "staged_assets") == 3


def test_stage_cli_reports_a_missing_source_without_a_traceback(
    tmp_path: Path, capsys: Any
) -> None:
    cli = _load_script(STAGE_SCRIPT, "stage_suno_cache_missing")

    exit_code = cli.main(
        [str(tmp_path / "nope.jsonl"), "--stage-root", str(tmp_path / "stage")]
    )

    assert exit_code == 1
    assert "nope.jsonl" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Progress reporting (the import wizard reads the same numbers)
# ---------------------------------------------------------------------------


def test_on_commit_carries_the_running_counters(tmp_path: Path) -> None:
    source = _mixed_cache(tmp_path / "cache.jsonl")
    seen: list[suno_stage.StageProgress] = []

    report = suno_stage.stage_cache(
        source, tmp_path / "stage", batch_size=3, on_commit=seen.append
    )

    assert seen, "a batched run must report progress at least once"
    last = seen[-1]
    assert last.seen == last.accepted + last.duplicate + last.quarantined
    assert last.seen == report.seen
    assert last.quarantined == report.quarantined
    assert last.ordinal > 0
    assert last.elapsed_seconds >= 0.0
    assert last.records_per_second >= 0.0
    # Counters only ever move forwards.
    assert [progress.seen for progress in seen] == sorted(
        progress.seen for progress in seen
    )


def test_progress_offers_an_eta_only_when_the_total_is_known(tmp_path: Path) -> None:
    source = _mixed_cache(tmp_path / "cache.jsonl")
    blind: list[suno_stage.StageProgress] = []
    informed: list[suno_stage.StageProgress] = []

    suno_stage.stage_cache(
        source, tmp_path / "blind", batch_size=2, on_commit=blind.append
    )
    suno_stage.stage_cache(
        source,
        tmp_path / "informed",
        batch_size=2,
        on_commit=informed.append,
        total_records=8,
    )

    assert blind and informed
    assert all(progress.eta_seconds is None for progress in blind)
    assert all(progress.total is None for progress in blind)
    assert all(progress.total == 8 for progress in informed)
    # An ETA needs both a total and a rate, and a rate needs measurable elapsed
    # time -- which a handful of records on a 15ms clock may not produce. It is
    # offered exactly when it is knowable, and it is never negative.
    assert all(
        (progress.eta_seconds is not None) == (progress.elapsed_seconds > 0)
        for progress in informed
    )
    assert all(
        progress.eta_seconds >= 0
        for progress in informed
        if progress.eta_seconds is not None
    )


def test_progress_to_dict_exposes_the_derived_numbers() -> None:
    progress = suno_stage.StageProgress(
        ordinal=10,
        seen=10,
        accepted=8,
        duplicate=1,
        quarantined=1,
        elapsed_seconds=2.0,
        total=20,
    )

    payload = progress.to_dict()

    assert payload["records_per_second"] == pytest.approx(5.0)
    assert payload["eta_seconds"] == pytest.approx(2.0)
    assert payload["quarantined"] == 1


# ---------------------------------------------------------------------------
# Interruption: stop at a batch boundary, stay resumable
# ---------------------------------------------------------------------------


def test_should_stop_finishes_the_batch_and_resumes_to_the_same_counts(
    tmp_path: Path,
) -> None:
    source = _mixed_cache(tmp_path / "cache.jsonl")
    clean = suno_stage.stage_cache(source, tmp_path / "clean", batch_size=3)
    stage_root = tmp_path / "stopped"

    stopped = suno_stage.stage_cache(
        source, stage_root, batch_size=3, should_stop=lambda: True
    )

    assert stopped.status == "interrupted"
    assert stopped.interrupted is True
    assert stopped.complete is False
    # The batch in flight was finished, not thrown away.
    assert stopped.seen == 3
    assert stopped.reconciles
    assert _revision_counts_are_consistent(stage_root)
    assert _count(stage_root, "staged_assets") < clean.distinct_identities

    resumed = suno_stage.stage_cache(source, stage_root, batch_size=3)

    assert resumed.status == "complete"
    assert resumed.to_dict() | {"database": ""} == clean.to_dict() | {"database": ""}


def test_an_interrupted_run_still_refuses_a_resume_free_rerun(tmp_path: Path) -> None:
    source = _mixed_cache(tmp_path / "cache.jsonl")
    stage_root = tmp_path / "stage"
    suno_stage.stage_cache(source, stage_root, batch_size=3, should_stop=lambda: True)

    with pytest.raises(suno_stage.IncompleteRunError):
        suno_stage.stage_cache(source, stage_root, batch_size=3, resume=False)


def test_keyboard_interrupt_mid_batch_discards_only_the_partial_batch(
    tmp_path: Path, monkeypatch: Any
) -> None:
    source = _mixed_cache(tmp_path / "cache.jsonl")
    clean = suno_stage.stage_cache(source, tmp_path / "clean", batch_size=3)
    stage_root = tmp_path / "stage"
    real = suno_stage.normalize_record
    calls = {"count": 0}

    def interrupted(raw: Any, namespace: str = "suno") -> Any:
        calls["count"] += 1
        if calls["count"] == 5:
            raise KeyboardInterrupt
        return real(raw, namespace)

    monkeypatch.setattr(suno_stage, "normalize_record", interrupted)

    report = suno_stage.stage_cache(source, stage_root, batch_size=3)

    assert report.status == "interrupted"
    # Ctrl+C landed inside the second batch; only the first one is durable.
    assert report.seen == 3
    assert report.reconciles
    assert _revision_counts_are_consistent(stage_root)

    monkeypatch.undo()
    resumed = suno_stage.stage_cache(source, stage_root, batch_size=3)

    assert resumed.to_dict() | {"database": ""} == clean.to_dict() | {"database": ""}
    assert _count(stage_root, "asset_revisions") == clean.revisions


# ---------------------------------------------------------------------------
# Parser selection
# ---------------------------------------------------------------------------


def test_report_names_the_parser_it_used(tmp_path: Path) -> None:
    source = _write_jsonl(tmp_path / "cache.jsonl", [_song("id-a")])

    report = suno_stage.stage_cache(source, tmp_path / "stage")

    assert report.parser == "jsonl"
    assert suno_stage.parser_name(source) == "jsonl"


def test_load_ijson_picks_a_backend_or_explains_the_dependency() -> None:
    if importlib.util.find_spec("ijson") is None:
        with pytest.raises(RuntimeError) as excinfo:
            suno_stage.load_ijson()
        assert "uv add ijson" in str(excinfo.value)
        assert suno_stage.parser_name(Path("cache.json")) == "ijson:unavailable"
    else:  # pragma: no cover - only when the optional dependency is installed
        module, backend = suno_stage.load_ijson()
        assert hasattr(module, "items")
        assert backend
        assert suno_stage.parser_name(Path("cache.json")) == f"ijson:{backend}"
        # The fastest available backend, not whatever a bare import returns.
        available = [
            name
            for name in suno_stage.IJSON_BACKENDS
            if importlib.util.find_spec(f"ijson.backends.{name}") is not None
        ]
        assert not available or backend == available[0]


# ---------------------------------------------------------------------------
# Sanitizing: the fast paths must redact exactly what the full parse did
# ---------------------------------------------------------------------------


def test_percent_encoded_credential_keys_are_still_redacted() -> None:
    hidden = suno_stage.sanitize("https://cdn.example.invalid/a.mp3?%74oken=SECRET")

    # ``parse_qsl`` unquotes key names, so the escaped spelling is still the
    # ``token`` key -- which is why the fast path refuses to skip a query that
    # contains a percent escape.
    assert "SECRET" not in hidden
    assert "REDACTED" in hidden
    assert hidden.startswith("https://cdn.example.invalid/a.mp3?token=")


def test_a_credential_free_url_survives_verbatim() -> None:
    for url in (
        "https://cdn.example.invalid/a.mp3",
        "https://cdn.example.invalid/a.mp3?v=2&quality=high",
        "http://cdn.example.invalid/path/with%20space.mp3",
    ):
        assert suno_stage.sanitize(url) == url


def test_every_credential_query_key_is_redacted() -> None:
    for key in sorted(suno_stage.SECRET_QUERY_KEYS):
        cleaned = suno_stage.sanitize(f"https://cdn.example.invalid/a?{key}=LEAK")
        assert "LEAK" not in cleaned, key


def test_sanitize_still_handles_mappings_tuples_and_decimals() -> None:
    from collections import OrderedDict

    cleaned = suno_stage.sanitize(
        OrderedDict(
            [
                ("Authorization", "Bearer LEAK"),
                ("depth", (Decimal("2"), Decimal("1.5"))),
                (7, "numeric key"),
            ]
        )
    )

    assert cleaned == {
        "Authorization": suno_stage.REDACTED,
        "depth": [2, 1.5],
        "7": "numeric key",
    }
    assert isinstance(cleaned["depth"][0], int)


def test_secret_key_matching_is_case_and_separator_insensitive() -> None:
    cleaned = suno_stage.sanitize({"Set-Cookie": "LEAK", "API_KEY": "LEAK", "ok": "x"})

    assert cleaned == {
        "Set-Cookie": suno_stage.REDACTED,
        "API_KEY": suno_stage.REDACTED,
        "ok": "x",
    }


# ---------------------------------------------------------------------------
# Scale-shaped behaviour: media index and the grouped title report
# ---------------------------------------------------------------------------


def test_media_index_finds_ids_in_nested_directories(tmp_path: Path) -> None:
    media_root = tmp_path / "media"
    first, second = _uuid(11), _uuid(12)
    (media_root / "ab" / "cd").mkdir(parents=True)
    (media_root / "ab" / "cd" / f"{first}.mp3").write_bytes(b"audio")
    (media_root / "ab" / f"Some Title - {second}.flac").write_bytes(b"audio")
    (media_root / "ab" / f"{second}.png").write_bytes(b"art")
    (media_root / "notes.txt").write_text("ignored", encoding="utf-8")

    index = suno_stage.MediaIndex(media_root)

    assert index.audio_for(first) == (media_root / "ab" / "cd" / f"{first}.mp3")
    assert index.audio_for(second.upper()) is not None
    assert index.artwork_for(second) == (media_root / "ab" / f"{second}.png")
    assert index.audio_for("not-an-id") is None
    assert len(index) >= 3


def test_same_title_report_counts_every_member_of_every_group(tmp_path: Path) -> None:
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [
            _song("a", title="Twin"),
            _song("b", title="Twin"),
            _song("c", title="Twin"),
            _song("d", title="Pair"),
            _song("e", title="Pair"),
            _song("f", title="Alone"),
            _song("g", title=""),
            _song("h", title=""),
        ],
    )

    report = suno_stage.stage_cache(source, tmp_path / "stage")

    # Three "Twin" plus two "Pair"; "Alone" is unique and blank titles never
    # count as a shared title.
    assert report.same_title_different_id == 5


def test_revision_count_tracks_the_revisions_that_exist(tmp_path: Path) -> None:
    source = _write_jsonl(
        tmp_path / "cache.jsonl",
        [
            _song("a", title="One"),
            _song("a", title="Two"),
            _song("a", title="Two"),
            _song("a", title="Three"),
            _song("b"),
        ],
    )

    report = suno_stage.stage_cache(source, tmp_path / "stage")

    assert (report.accepted, report.duplicate) == (4, 1)
    assert _revision_counts_are_consistent(tmp_path / "stage")
    assert _asset(tmp_path / "stage", "a")["revision_count"] == 3
    assert _asset(tmp_path / "stage", "b")["revision_count"] == 1
    with _connect(tmp_path / "stage") as connection:
        revisions = [
            row[0]
            for row in connection.execute(
                "SELECT revision FROM asset_revisions WHERE asset_id=?"
                " ORDER BY revision",
                (suno_stage.asset_id("suno", "a"),),
            )
        ]
    assert revisions == [1, 2, 3]


def test_reporting_indexes_exist_once_the_run_finishes(tmp_path: Path) -> None:
    source = _write_jsonl(tmp_path / "cache.jsonl", [_song("a", title="T")])

    suno_stage.stage_cache(source, tmp_path / "stage")

    with _connect(tmp_path / "stage") as connection:
        indexes = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            )
        }
    assert {"staged_assets_title", "lineage_parent"} <= indexes


def test_staging_database_uses_the_bulk_load_pragmas(tmp_path: Path) -> None:
    source = _write_jsonl(tmp_path / "cache.jsonl", [_song("a")])
    stage_root = tmp_path / "stage"

    suno_stage.stage_cache(source, stage_root)

    with _connect(stage_root) as connection:
        journal = connection.execute("PRAGMA journal_mode").fetchone()[0]
        page_size = connection.execute("PRAGMA page_size").fetchone()[0]
    assert journal.lower() == "wal"
    assert int(page_size) == suno_stage.PAGE_SIZE


def test_foreign_keys_stay_on_when_the_schema_is_already_there(tmp_path: Path) -> None:
    """Reopening skips the schema script; the pragmas must not be skipped too.

    ``PRAGMA foreign_keys`` is per connection, not stored in the file, so a
    resumed run would silently lose referential integrity if it rode on the
    schema script.
    """
    source = _write_jsonl(tmp_path / "cache.jsonl", [_song("a")])
    stage_root = tmp_path / "stage"
    suno_stage.stage_cache(source, stage_root)
    database = suno_stage.stage_db_path(stage_root)

    reopened = suno_stage._open_stage_db(database)
    try:
        enabled = reopened.execute("PRAGMA foreign_keys").fetchone()[0]
        with pytest.raises(sqlite3.IntegrityError):
            reopened.execute(
                "INSERT INTO asset_revisions VALUES('ghost','h',1,'{}','run',1)"
            )
    finally:
        reopened.close()
    assert int(enabled) == 1


# ---------------------------------------------------------------------------
# The staging CLI: progress and a cooperative Ctrl+C
# ---------------------------------------------------------------------------


def test_stage_cli_prints_progress_to_stderr(tmp_path: Path, capsys: Any) -> None:
    cli = _load_script(STAGE_SCRIPT, "stage_suno_cache_progress")
    source = _mixed_cache(tmp_path / "cache.jsonl")

    exit_code = cli.main(
        [
            str(source),
            "--stage-root",
            str(tmp_path / "stage"),
            "--batch-size",
            "2",
            "--progress-seconds",
            "0.001",
            "--expect-records",
            "8",
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 0
    assert "staged" in captured.err
    assert "rec/s" in captured.err
    assert "quarantined" in captured.err
    assert "elapsed" in captured.err
    payload = json.loads(captured.out)
    assert payload["timing"]["interrupted"] is False
    assert payload["totals"]["reconciles"] is True


def test_stage_cli_stays_silent_when_progress_is_disabled(
    tmp_path: Path, capsys: Any
) -> None:
    cli = _load_script(STAGE_SCRIPT, "stage_suno_cache_quiet")
    source = _mixed_cache(tmp_path / "cache.jsonl")

    cli.main(
        [
            str(source),
            "--stage-root",
            str(tmp_path / "stage"),
            "--batch-size",
            "2",
            "--progress-seconds",
            "0",
        ]
    )

    assert capsys.readouterr().err == ""


def test_stage_cli_exits_130_and_leaves_a_resumable_checkpoint(
    tmp_path: Path, capsys: Any
) -> None:
    cli = _load_script(STAGE_SCRIPT, "stage_suno_cache_interrupt")
    source = _mixed_cache(tmp_path / "cache.jsonl")
    stage_root = tmp_path / "stage"
    clean = suno_stage.stage_cache(source, tmp_path / "clean", batch_size=3)
    already_asked = cli.StopRequest(stream=io.StringIO())
    already_asked.request()

    exit_code = cli.main(
        [str(source), "--stage-root", str(stage_root), "--batch-size", "3"],
        stop=already_asked,
    )

    assert exit_code == cli.INTERRUPTED_EXIT_CODE == 130
    captured = capsys.readouterr()
    assert "--resume" in captured.err
    payload = json.loads(captured.out)
    assert payload["timing"]["interrupted"] is True
    assert payload["reports"][0]["status"] == "interrupted"
    assert _revision_counts_are_consistent(stage_root)

    resume_code = cli.main(
        [str(source), "--stage-root", str(stage_root), "--batch-size", "3", "--resume"]
    )

    assert resume_code == 0
    resumed = json.loads(capsys.readouterr().out)["reports"][0]
    assert resumed["status"] == "complete"
    assert resumed["distinct_identities"] == clean.distinct_identities
    assert resumed["seen"] == clean.seen


def test_stop_request_asks_once_then_lets_the_next_interrupt_through() -> None:
    cli = _load_script(STAGE_SCRIPT, "stage_suno_cache_stop_request")
    messages = io.StringIO()
    stop = cli.StopRequest(stream=messages)

    assert stop() is False
    stop.handle(signal.SIGINT, None)
    assert stop() is True
    assert "finishing the current batch" in messages.getvalue()

    with pytest.raises(KeyboardInterrupt):
        stop.handle(signal.SIGINT, None)


def test_stop_request_restores_the_handler_it_replaced() -> None:
    cli = _load_script(STAGE_SCRIPT, "stage_suno_cache_signals")
    stop = cli.StopRequest(stream=io.StringIO())
    before = signal.getsignal(signal.SIGINT)

    stop.install()
    try:
        assert signal.getsignal(signal.SIGINT) is not before
    finally:
        stop.restore()

    assert signal.getsignal(signal.SIGINT) is before
