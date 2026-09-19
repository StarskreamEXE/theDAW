"""Promoting a staged Suno catalog into the real library.

Nothing here reads the user's real cache or writes the user's real library:
every fixture lives under ``tmp_path``, the staging database is built by
``suno_stage`` from synthetic JSONL, and the "audio" is a handful of bytes.
No network, no model weights.

The properties under test are the ones that make a 200,000-song promotion safe
to point at a library somebody already uses: songs are identified by provider
id (ten "Neon Rain"s are ten entries), an entry the OLD importer wrote is
updated rather than duplicated, anything the user touched survives the update,
a song with neither local audio nor a URL is deferred and named instead of
silently dropped, lineage is a second pass that can run twice, an interrupt
followed by a re-run lands on the same library, a second full run is a no-op,
``--dry-run`` writes nothing at all, and the source audio is never opened.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import sqlite3
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Iterable, Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router as library_router_module
from backend.modules.library import suno_promote, suno_stage
from backend.modules.library.store import LibraryStore

REPO_ROOT = Path(__file__).resolve().parents[1]
INGEST_SCRIPT = REPO_ROOT / "scripts" / "ingest_suno_cache.py"
PROMOTE_SCRIPT = REPO_ROOT / "scripts" / "promote_suno_stage.py"


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _song(song_id: str, **fields: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "id": song_id,
        "title": f"Song {song_id[:6]}",
        "status": "complete",
        "audio_url": f"https://cdn.example.invalid/{song_id}.mp3",
        "created_at": "2026-01-01T00:00:00Z",
        "metadata": {
            "duration": 123.5,
            "style": "synthwave",
            "description": "a prompt",
            "lyrics": "la la la",
        },
        "tags": ["synth", "night"],
        "model_name": "chirp-v5",
    }
    record.update(fields)
    return record


def _clip_id(n: int) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"promote-test/{n}"))


def _write_jsonl(path: Path, records: Iterable[Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return path


def _stage(
    tmp_path: Path,
    records: Iterable[Any],
    *,
    media_root: Optional[Path] = None,
    name: str = "cache",
) -> Path:
    """Stage ``records`` and return the stage root."""
    source = _write_jsonl(tmp_path / f"{name}.jsonl", records)
    stage_root = tmp_path / f"stage-{name}"
    report = suno_stage.stage_cache(source, stage_root, media_root=media_root)
    assert report.complete, report.status
    return stage_root


def _media(root: Path, song_id: str, payload: bytes = b"ID3\x04\x00\x00fake") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{song_id}.mp3"
    path.write_bytes(payload)
    return path


@pytest.fixture
def store(tmp_path: Path) -> LibraryStore:
    return LibraryStore(tmp_path / "library")


def _entry_meta(store: LibraryStore, entry_id: str) -> dict[str, Any]:
    return json.loads(
        (store.root / entry_id / "metadata.json").read_text(encoding="utf-8")
    )


def _load_script(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# Identity and mapping
# ---------------------------------------------------------------------------


def test_entry_id_reuses_the_provider_id_so_old_entries_match() -> None:
    clip = _clip_id(1)
    assert suno_promote.entry_id_for("suno", clip) == clip


def test_entry_id_is_filesystem_safe_for_a_hostile_provider_id() -> None:
    for hostile in ("../../etc/passwd", "a/b", "CON", "", "x" * 400, "Mixed-CASE"):
        entry_id = suno_promote.entry_id_for("suno", hostile)
        assert "/" not in entry_id and "\\" not in entry_id
        assert entry_id not in (".", "..")
        assert 0 < len(entry_id) <= 80
        assert entry_id == entry_id.lower()


def test_entry_ids_never_collide_across_the_two_id_spaces() -> None:
    minted = suno_promote.entry_id_for("suno", "a/b")
    # A verbatim id can never take the minted shape: '~' is not in the safe set.
    assert "~" in minted
    assert suno_promote.entry_id_for("suno", minted) != minted


def test_ten_same_title_songs_become_ten_entries(tmp_path: Path, store: LibraryStore):
    songs = [_song(_clip_id(i), title="Neon Rain") for i in range(10)]
    report = suno_promote.promote_stage(_stage(tmp_path, songs), store)

    assert report.created == 10
    assert store.db.count_entries() == 10
    titles = {row["title"] for row in store.db.list_entries()}
    assert titles == {"Neon Rain"}


def test_untitled_song_gets_a_readable_placeholder_not_a_drop(
    tmp_path: Path, store: LibraryStore
):
    clip = _clip_id(11)
    report = suno_promote.promote_stage(
        _stage(tmp_path, [_song(clip, title="")]), store
    )

    assert report.created == 1
    row = store.db.get_entry(clip)
    assert row is not None
    assert clip[:8] in row["title"]


def test_unknown_duration_and_created_at_stay_unknown(
    tmp_path: Path, store: LibraryStore
):
    clip = _clip_id(12)
    song = _song(clip, created_at="not a date", metadata={"style": "x"})
    suno_promote.promote_stage(_stage(tmp_path, [song]), store)

    meta = _entry_meta(store, clip)
    assert "duration" not in meta
    assert meta["created_at"] == ""
    assert meta["timestamp"] == ""


def test_local_audio_is_referenced_in_place_and_never_opened(
    tmp_path: Path, store: LibraryStore
):
    clip = _clip_id(13)
    media_root = tmp_path / "media"
    audio = _media(media_root, clip)
    before = (audio.read_bytes(), audio.stat().st_mtime_ns)

    stage_root = _stage(tmp_path, [_song(clip)], media_root=media_root)
    suno_promote.promote_stage(stage_root, store)

    meta = _entry_meta(store, clip)
    assert meta["source_path"] == str(audio.resolve())
    assert "cdn_audio_url" not in meta or meta.get("source_path")
    # The source is byte-for-byte untouched, and nothing was copied in.
    assert (audio.read_bytes(), audio.stat().st_mtime_ns) == before
    assert sorted(p.name for p in (store.root / clip).iterdir()) == ["metadata.json"]


def test_remote_only_song_is_promoted_on_its_cdn_url(
    tmp_path: Path, store: LibraryStore
):
    clip = _clip_id(14)
    suno_promote.promote_stage(_stage(tmp_path, [_song(clip)]), store)
    meta = _entry_meta(store, clip)
    assert meta["cdn_audio_url"].endswith(f"{clip}.mp3")
    assert "source_path" not in meta
    assert store.get_entry(clip) is not None


def test_song_with_neither_audio_nor_url_is_deferred_and_listed(
    tmp_path: Path, store: LibraryStore
):
    good, orphan = _clip_id(15), _clip_id(16)
    songs = [_song(good), _song(orphan, audio_url="")]
    report = suno_promote.promote_stage(_stage(tmp_path, songs), store)

    assert report.created == 1
    assert report.deferred_no_media == 1
    listed = {item["external_id"] for item in report.deferred}
    assert listed == {orphan}
    assert store.db.get_entry(orphan) is None
    assert not (store.root / orphan).exists()
    # It stays in staging, ready for a later run that finds its audio.
    with sqlite3.connect(suno_stage.stage_db_path(_stage_root_of(report))) as conn:
        (count,) = conn.execute(
            "SELECT COUNT(*) FROM staged_assets WHERE external_id = ?", (orphan,)
        ).fetchone()
    assert count == 1


def _stage_root_of(report: suno_promote.PromotionReport) -> Path:
    return Path(report.stage_root)


def test_raw_provider_record_and_ids_are_kept_in_metadata(
    tmp_path: Path, store: LibraryStore
):
    clip = _clip_id(17)
    suno_promote.promote_stage(_stage(tmp_path, [_song(clip)]), store)

    meta = _entry_meta(store, clip)
    assert meta["provider_id"] == clip
    assert meta["suno_id"] == clip
    assert meta["source"] == "suno"
    assert meta["suno_raw"]["id"] == clip
    assert meta["lyrics"] == "la la la"
    assert meta["style"] == "synthwave"
    assert meta["prompt"] == "a prompt"
    assert meta["model"] == "chirp-v5"
    assert "synth" in meta["tags"]


def test_signed_urls_are_sanitized_before_they_reach_the_library(
    tmp_path: Path, store: LibraryStore
):
    clip = _clip_id(18)
    song = _song(
        clip,
        audio_url=f"https://cdn.example.invalid/{clip}.mp3?token=deadbeef&Expires=1",
    )
    suno_promote.promote_stage(_stage(tmp_path, [song]), store)
    assert "deadbeef" not in json.dumps(_entry_meta(store, clip))


# ---------------------------------------------------------------------------
# Updating, not duplicating
# ---------------------------------------------------------------------------


def test_an_entry_from_the_old_importer_is_updated_not_duplicated(
    tmp_path: Path, store: LibraryStore
):
    clip = _clip_id(20)
    song = _song(clip)
    ingest = _load_script(INGEST_SCRIPT, "ingest_for_promote_test")
    assert ingest.ingest([song], store.root) == 1
    store.reindex()
    assert store.db.count_entries() == 1

    report = suno_promote.promote_stage(_stage(tmp_path, [song]), store)

    assert (report.created, report.updated) == (0, 1)
    assert store.db.count_entries() == 1
    assert _entry_meta(store, clip)["suno_revision"]


def test_an_old_entry_with_no_db_row_is_updated_not_overwritten(
    tmp_path: Path, store: LibraryStore
):
    """The old importer wrote folders straight to disk, bypassing the DB.

    If one was never reindexed there is no row to find it by, and the naive
    answer -- "no row, so this is a new song" -- would write straight over
    whatever the user had done to it.
    """
    clip = _clip_id(70)
    song = _song(clip)
    ingest = _load_script(INGEST_SCRIPT, "ingest_unindexed")
    assert ingest.ingest([song], store.root) == 1

    meta_path = store.root / clip / "metadata.json"
    stale = json.loads(meta_path.read_text(encoding="utf-8"))
    stale.update({"favorite": True, "notes": "keep me", "title": "Handmade"})
    stale["tags"] = [*stale["tags"], "mine"]
    meta_path.write_text(json.dumps(stale), encoding="utf-8")
    assert store.db.get_entry(clip) is None, "the fixture must leave the DB blind"

    report = suno_promote.promote_stage(_stage(tmp_path, [song]), store)

    assert (report.created, report.updated) == (0, 1)
    meta = _entry_meta(store, clip)
    assert meta["favorite"] is True
    assert meta["notes"] == "keep me"
    assert meta["title"] == "Handmade"
    assert "mine" in meta["tags"]
    assert meta["suno_revision"]


def test_user_edits_survive_an_update(tmp_path: Path, store: LibraryStore):
    clip = _clip_id(21)
    song = _song(clip)
    stage_root = _stage(tmp_path, [song])
    suno_promote.promote_stage(stage_root, store)

    store.update_entry(
        clip,
        {
            "favorite": True,
            "rating": "like",
            "notes": "best one",
            "tags": ["mine", "synth"],
            "title": "My Own Name",
        },
    )

    # A changed staged revision forces a real update.
    changed = _song(clip, title="Song renamed upstream", status="streaming")
    stage_root2 = _stage(tmp_path, [changed], name="cache2")
    report = suno_promote.promote_stage(stage_root2, store)
    assert report.updated == 1

    meta = _entry_meta(store, clip)
    assert meta["favorite"] is True
    assert meta["rating"] == "like"
    assert meta["notes"] == "best one"
    assert "mine" in meta["tags"]
    assert meta["title"] == "My Own Name"

    row = store.db.get_entry(clip)
    assert row["favorite"] == 1 and row["notes"] == "best one"
    assert row["title"] == "My Own Name"


def test_a_title_the_user_never_touched_follows_the_provider(
    tmp_path: Path, store: LibraryStore
):
    clip = _clip_id(22)
    suno_promote.promote_stage(_stage(tmp_path, [_song(clip, title="First")]), store)
    suno_promote.promote_stage(
        _stage(tmp_path, [_song(clip, title="Second")], name="c2"), store
    )
    assert store.db.get_entry(clip)["title"] == "Second"


def test_same_revision_is_skipped_as_unchanged(tmp_path: Path, store: LibraryStore):
    clip = _clip_id(23)
    stage_root = _stage(tmp_path, [_song(clip)])
    suno_promote.promote_stage(stage_root, store)
    written = (store.root / clip / "metadata.json").stat().st_mtime_ns

    # A fresh stage root holding the identical record: same content hash.
    second = suno_promote.promote_stage(
        _stage(tmp_path, [_song(clip)], name="same"), store
    )
    assert (second.created, second.updated, second.unchanged) == (0, 0, 1)
    assert (store.root / clip / "metadata.json").stat().st_mtime_ns == written


def test_a_second_full_run_changes_nothing(tmp_path: Path, store: LibraryStore):
    songs = [_song(_clip_id(30 + i)) for i in range(25)]
    stage_root = _stage(tmp_path, songs)
    first = suno_promote.promote_stage(stage_root, store)
    revision = store.db.library_revision()

    second = suno_promote.promote_stage(stage_root, store)

    assert first.created == 25
    assert (second.created, second.updated, second.failed) == (0, 0, 0)
    assert second.unchanged == 25
    assert store.db.library_revision() == revision
    assert store.db.count_entries() == 25


def test_update_merges_over_the_existing_entry_instead_of_replacing_it(
    tmp_path: Path, store: LibraryStore
):
    """F2a1 / R2-1: the UPDATE branch must not rewrite metadata.json from
    scratch. Everything the entry already has -- including fields
    ``build_metadata`` never produces at all, like a spectrogram cache -- has
    to survive an update byte-for-byte, and an unknown staged duration must
    never stomp a known one, in the file or in the DB row."""
    clip = _clip_id(90)
    stage_root = _stage(tmp_path, [_song(clip)])
    suno_promote.promote_stage(stage_root, store)

    meta_path = store.root / clip / "metadata.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["duration"] = 183.4
    meta["spectrogram_paths"] = {"peaks": "peaks.bin"}
    meta["saved_at"] = "2026-02-01T00:00:00Z"
    meta["filename"] = "handmade-name.mp3"
    meta["file_size_bytes"] = 999999
    meta["source_path"] = "Z:/somewhere/handmade.mp3"
    meta_path.write_text(json.dumps(meta), encoding="utf-8")

    # A truly new revision (forces the update branch) whose OWN duration
    # is unknown -- must not overwrite the 183.4 already on the entry.
    changed = _song(
        clip, title="Retitled upstream", status="streaming", metadata={"style": "x"}
    )
    stage_root2 = _stage(tmp_path, [changed], name="cache2")
    report = suno_promote.promote_stage(stage_root2, store)
    assert report.updated == 1

    updated = _entry_meta(store, clip)
    assert updated["duration"] == 183.4
    assert updated["spectrogram_paths"] == {"peaks": "peaks.bin"}
    assert updated["saved_at"] == "2026-02-01T00:00:00Z"
    assert updated["filename"] == "handmade-name.mp3"
    assert updated["file_size_bytes"] == 999999
    assert updated["source_path"] == "Z:/somewhere/handmade.mp3"
    # Provider-owned keys were still refreshed.
    assert updated["title"] == "Retitled upstream"
    assert updated["style"] == "x"

    row = store.db.get_entry(clip)
    assert row["duration_sec"] == 183.4


def test_unparsable_metadata_is_left_untouched_and_reported(
    tmp_path: Path, store: LibraryStore
):
    """F2a1 / R2-1 (deferral half): a metadata.json that cannot be parsed as
    JSON must not be overwritten by the update branch -- the song is skipped
    and the reason lands in the report instead."""
    clip = _clip_id(91)
    stage_root = _stage(tmp_path, [_song(clip)])
    suno_promote.promote_stage(stage_root, store)

    meta_path = store.root / clip / "metadata.json"
    meta_path.write_text("{not valid json", encoding="utf-8")
    before = meta_path.read_text(encoding="utf-8")

    changed = _song(clip, title="Should never land", status="streaming")
    stage_root2 = _stage(tmp_path, [changed], name="cache2")
    report = suno_promote.promote_stage(stage_root2, store)

    assert report.updated == 0
    assert report.failed == 1
    assert any("not valid JSON" in message for message in report.errors)
    assert meta_path.read_text(encoding="utf-8") == before


def test_entry_dir_refuses_a_symlinked_entry_id_that_escapes_the_root(
    tmp_path: Path,
) -> None:
    """F2a1 / R2-3: containment has to be decided on the RESOLVED path, not a
    string prefix -- an entry id that names a symlink pointing outside the
    library root must be refused before anything is written through it."""
    root = (tmp_path / "library").resolve()
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    link = root / "escapeid"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:  # Windows without dev mode
        pytest.skip(f"cannot create a symlink here: {exc}")

    root_normcase = os.path.normcase(str(root))
    with pytest.raises(suno_promote.PromotionRefused):
        suno_promote._entry_dir(root, root_normcase, "escapeid")


def test_entry_dir_refuses_a_symlinked_entry_id_that_resolves_to_the_root(
    tmp_path: Path,
) -> None:
    """F2a1 rework, R1 audit finding 2: the containment check must not special
    case ``resolved == root`` -- the library root is not inside itself, so an
    entry id that is a symlink pointing AT the root has to be refused exactly
    like one pointing further outside it. The old ``resolved != root`` clause
    let this one through."""
    root = (tmp_path / "library").resolve()
    root.mkdir()
    link = root / "escapeid"
    try:
        link.symlink_to(root, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:  # Windows without dev mode
        pytest.skip(f"cannot create a symlink here: {exc}")

    root_normcase = os.path.normcase(str(root))
    with pytest.raises(suno_promote.PromotionRefused):
        suno_promote._entry_dir(root, root_normcase, "escapeid")


def test_this_file_carries_no_banned_words() -> None:
    """F2a1 rework, R1 audit finding 1: the banned word must never reappear
    in this file's source, comments included."""
    source = Path(__file__).read_text(encoding="utf-8")
    assert "genuinely" not in source.lower()


# ---------------------------------------------------------------------------
# Lineage
# ---------------------------------------------------------------------------


def test_lineage_becomes_typed_relations_and_keeps_unresolved_parents(
    tmp_path: Path, store: LibraryStore
):
    parent, child, ghost = _clip_id(60), _clip_id(61), _clip_id(62)
    songs = [
        _song(parent),
        _song(
            child,
            metadata={
                "duration": 10.0,
                "cover_audio_id": parent,
                "mashup_clip_ids": [ghost],
            },
        ),
    ]
    report = suno_promote.promote_stage(_stage(tmp_path, songs), store)

    kinds = {
        (r["from_id"], r["to_id"], r["kind"])
        for r in store.db.list_relations(from_id=child)
    }
    assert (child, parent, "cover_of") in kinds
    assert (child, f"suno:{ghost}", "mashup_source") in kinds
    assert report.lineage_edges >= 2
    assert report.lineage_unresolved >= 1


def test_lineage_is_idempotent_on_a_re_run(tmp_path: Path, store: LibraryStore):
    parent, child = _clip_id(63), _clip_id(64)
    songs = [_song(parent), _song(child, metadata={"cover_audio_id": parent})]
    stage_root = _stage(tmp_path, songs)
    suno_promote.promote_stage(stage_root, store)
    before = len(store.db.list_relations())
    suno_promote.promote_stage(stage_root, store)
    assert len(store.db.list_relations()) == before


def test_a_lineage_cycle_does_not_hang(tmp_path: Path, store: LibraryStore):
    a, b = _clip_id(65), _clip_id(66)
    songs = [
        _song(a, metadata={"cover_audio_id": b}),
        _song(b, metadata={"cover_audio_id": a}),
    ]
    report = suno_promote.promote_stage(_stage(tmp_path, songs), store)
    assert report.created == 2
    assert len(store.db.list_relations()) == 2


# ---------------------------------------------------------------------------
# Resumability
# ---------------------------------------------------------------------------


def test_an_interrupted_promotion_resumes_to_the_same_library(
    tmp_path: Path, store: LibraryStore
):
    songs = [_song(_clip_id(100 + i)) for i in range(40)]
    stage_root = _stage(tmp_path, songs)

    stops = {"n": 0}

    def should_stop() -> bool:
        stops["n"] += 1
        return stops["n"] >= 2

    partial = suno_promote.promote_stage(
        stage_root, store, batch_size=10, should_stop=should_stop
    )
    assert partial.status == "cancelled"
    assert 0 < store.db.count_entries() < 40

    resumed = suno_promote.promote_stage(stage_root, store, batch_size=10)
    assert resumed.status == "complete"
    assert store.db.count_entries() == 40
    assert partial.created + resumed.created == 40

    # And the run after that is a no-op.
    final = suno_promote.promote_stage(stage_root, store, batch_size=10)
    assert (final.created, final.updated) == (0, 0)


def test_a_lost_receipt_is_reconciled_instead_of_double_counted(
    tmp_path: Path, store: LibraryStore
):
    """A crash between the library write and its receipt must not re-create."""
    songs = [_song(_clip_id(140 + i)) for i in range(5)]
    stage_root = _stage(tmp_path, songs)
    suno_promote.promote_stage(stage_root, store)

    with sqlite3.connect(suno_stage.stage_db_path(stage_root)) as conn:
        conn.execute("DELETE FROM promotions")
        conn.commit()

    again = suno_promote.promote_stage(stage_root, store)
    assert (again.created, again.updated) == (0, 0)
    assert again.unchanged == 5
    assert store.db.count_entries() == 5


def test_progress_is_reported_per_batch(tmp_path: Path, store: LibraryStore):
    songs = [_song(_clip_id(160 + i)) for i in range(30)]
    seen: list[suno_promote.PromotionProgress] = []
    suno_promote.promote_stage(
        _stage(tmp_path, songs), store, batch_size=10, on_batch=seen.append
    )
    assert len(seen) == 3
    assert [p.seen for p in seen] == [10, 20, 30]
    assert seen[-1].created == 30
    payload = seen[-1].to_dict()
    assert payload["records_per_second"] >= 0
    assert payload["total"] == 30
    assert payload["eta_seconds"] == pytest.approx(0.0, abs=1e-6)


# ---------------------------------------------------------------------------
# Safety rails
# ---------------------------------------------------------------------------


def test_dry_run_writes_absolutely_nothing(tmp_path: Path, store: LibraryStore):
    songs = [_song(_clip_id(200 + i)) for i in range(6)]
    songs.append(_song(_clip_id(206), audio_url=""))
    stage_root = _stage(tmp_path, songs)
    stage_db = suno_stage.stage_db_path(stage_root)
    stage_digest = hashlib.sha256(stage_db.read_bytes()).hexdigest()
    revision = store.db.library_revision()

    report = suno_promote.promote_stage(stage_root, store, dry_run=True)

    assert report.dry_run is True
    assert report.created == 6
    assert report.deferred_no_media == 1
    assert store.db.count_entries() == 0
    assert store.db.library_revision() == revision
    assert list(store.root.glob("*/metadata.json")) == []
    assert not (store.root / "backups").exists()
    assert hashlib.sha256(stage_db.read_bytes()).hexdigest() == stage_digest


def test_a_backup_is_taken_before_the_first_batch(tmp_path: Path, store: LibraryStore):
    suno_promote.promote_stage(_stage(tmp_path, [_song(_clip_id(220))]), store)
    assert store.db.count_entries() == 1

    report = suno_promote.promote_stage(
        _stage(tmp_path, [_song(_clip_id(221))], name="c2"), store
    )
    backup = Path(report.backup_path)
    assert backup.parent == store.root / "backups"
    assert backup.name.startswith("pre-suno-import-")
    with sqlite3.connect(backup) as conn:
        (count,) = conn.execute("SELECT COUNT(*) FROM entries").fetchone()
    assert count == 1


def test_no_backup_for_an_empty_library(tmp_path: Path, store: LibraryStore):
    report = suno_promote.promote_stage(_stage(tmp_path, [_song(_clip_id(230))]), store)
    assert report.backup_path is None
    assert not (store.root / "backups").exists()


def test_a_short_drive_is_refused_before_anything_is_written(
    tmp_path: Path, store: LibraryStore, monkeypatch
):
    stage_root = _stage(tmp_path, [_song(_clip_id(240 + i)) for i in range(4)])

    monkeypatch.setattr(
        suno_promote.shutil,
        "disk_usage",
        lambda _p: shutil._ntuple_diskusage(total=1 << 30, used=1 << 30, free=1024),
    )
    with pytest.raises(suno_promote.PromotionRefused) as excinfo:
        suno_promote.promote_stage(stage_root, store)

    assert "free" in str(excinfo.value).lower()
    assert store.db.count_entries() == 0
    assert list(store.root.glob("*/metadata.json")) == []


def test_a_stage_root_that_is_not_a_staging_database_is_refused(
    tmp_path: Path, store: LibraryStore
):
    bogus = tmp_path / "bogus"
    bogus.mkdir()
    with pytest.raises(suno_promote.PromotionRefused):
        suno_promote.promote_stage(bogus, store)


def test_a_stage_root_inside_the_library_is_refused(
    tmp_path: Path, store: LibraryStore
):
    inside = store.root / "stage"
    stage_root = _stage(tmp_path, [_song(_clip_id(250))])
    shutil.copytree(stage_root, inside)
    with pytest.raises(suno_promote.PromotionRefused):
        suno_promote.promote_stage(inside, store)


# ---------------------------------------------------------------------------
# Scale (bounded so the suite stays fast)
# ---------------------------------------------------------------------------


def test_five_thousand_songs_promote_in_batches(tmp_path: Path, store: LibraryStore):
    count = 5000
    songs = (_song(_clip_id(1_000_000 + i)) for i in range(count))
    stage_root = _stage(tmp_path, songs)

    started = time.perf_counter()
    report = suno_promote.promote_stage(stage_root, store, batch_size=1000)
    elapsed = time.perf_counter() - started

    assert report.created == count
    assert store.db.count_entries() == count
    print(f"\n[promote] {count} entries in {elapsed:.1f}s ({count / elapsed:,.0f}/s)")
    assert elapsed < 60.0, f"{count} entries took {elapsed:.1f}s"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@pytest.fixture
def client_with_root(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "library"))
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app)


def _drain(client: TestClient, job_id: str) -> dict[str, Any]:
    """Run a queued job the way the background consumer would, then re-read it.

    The idle-gated background queue does not turn in the test process, so the
    suite drives the job itself -- the same shape ``tests/test_library_bulk.py``
    uses for an async folder import.
    """
    from backend.modules.library.store import get_import_jobs

    job = get_import_jobs().get(job_id)
    assert job is not None, f"job {job_id} was never registered"
    detail = job.detail
    if job.kind == "suno-stage":
        suno_promote.run_stage_job(
            job,
            cache_path=Path(detail["cache_path"]),
            stage_root=Path(detail["stage_root"]),
            media_root=Path(detail["media_root"]) if detail["media_root"] else None,
        )
    else:
        suno_promote.run_promote_job(
            job,
            library_router_module.get_store(),
            stage_root=Path(detail["stage_root"]),
            dry_run=bool(detail["dry_run"]),
        )
    return client.get(f"/api/library/import-jobs/{job_id}").json()


def test_stage_endpoint_runs_a_job_visible_through_import_jobs(
    client_with_root: TestClient, tmp_path: Path
):
    cache = _write_jsonl(tmp_path / "cache.jsonl", [_song(_clip_id(300))])
    body = client_with_root.post(
        "/api/library/suno/stage",
        json={"cache_path": str(cache), "stage_root": str(tmp_path / "st")},
    ).json()
    assert body["status_url"].endswith(body["job_id"])
    queued = client_with_root.get(body["status_url"]).json()
    assert queued["kind"] == "suno-stage"

    done = _drain(client_with_root, body["job_id"])
    assert done["status"] == "done"
    assert done["kind"] == "suno-stage"
    assert done["seen"] == 1

    report = client_with_root.get(
        "/api/library/suno/stage-report", params={"stage_root": str(tmp_path / "st")}
    ).json()
    assert report["distinct_identities"] == 1
    assert report["media_remote_only"] == 1
    assert report["promotable"] == 1


def test_promote_endpoint_runs_a_job_and_fills_the_library(
    client_with_root: TestClient, tmp_path: Path
):
    stage_root = _stage(tmp_path, [_song(_clip_id(310)), _song(_clip_id(311))])
    body = client_with_root.post(
        "/api/library/suno/promote", json={"stage_root": str(stage_root)}
    ).json()
    done = _drain(client_with_root, body["job_id"])

    assert done["status"] == "done"
    assert done["kind"] == "suno-promote"
    assert done["created"] == 2
    assert done["report"]["created"] == 2
    listed = client_with_root.get("/api/library/entries").json()["entries"]
    assert len(listed) == 2


def test_promote_endpoint_honours_dry_run(client_with_root: TestClient, tmp_path: Path):
    stage_root = _stage(tmp_path, [_song(_clip_id(320))])
    body = client_with_root.post(
        "/api/library/suno/promote",
        json={"stage_root": str(stage_root), "dry_run": True},
    ).json()
    done = _drain(client_with_root, body["job_id"])
    assert done["report"]["dry_run"] is True
    assert client_with_root.get("/api/library/entries").json()["entries"] == []


def test_promote_job_can_be_cancelled_through_the_shared_endpoint(
    client_with_root: TestClient, tmp_path: Path
):
    stage_root = _stage(tmp_path, [_song(_clip_id(330))])
    body = client_with_root.post(
        "/api/library/suno/promote", json={"stage_root": str(stage_root)}
    ).json()
    cancelled = client_with_root.delete(
        f"/api/library/import-jobs/{body['job_id']}"
    ).json()
    assert cancelled["status"] == "cancelled"

    done = _drain(client_with_root, body["job_id"])
    assert done["status"] == "cancelled"
    assert client_with_root.get("/api/library/entries").json()["entries"] == []


def test_endpoints_refuse_paths_that_do_not_exist_or_sit_in_the_library(
    client_with_root: TestClient, tmp_path: Path
):
    library = library_router_module.get_store().root
    missing = client_with_root.post(
        "/api/library/suno/stage", json={"cache_path": str(tmp_path / "nope.jsonl")}
    )
    assert missing.status_code == 400

    inside = client_with_root.post(
        "/api/library/suno/stage",
        json={
            "cache_path": str(_write_jsonl(tmp_path / "c.jsonl", [])),
            "stage_root": str(library / "inside"),
        },
    )
    assert inside.status_code == 400

    assert (
        client_with_root.get(
            "/api/library/suno/stage-report",
            params={"stage_root": str(tmp_path / "nowhere")},
        ).status_code
        == 400
    )

    assert (
        client_with_root.post(
            "/api/library/suno/promote", json={"stage_root": str(tmp_path / "nowhere")}
        ).status_code
        == 400
    )


def test_stage_report_route_is_not_shadowed_by_the_entry_route(
    client_with_root: TestClient, tmp_path: Path
):
    """`/suno/stage-report` must not be read as `/{entry_id}/bundle`-style."""
    response = client_with_root.get(
        "/api/library/suno/stage-report", params={"stage_root": str(tmp_path / "x")}
    )
    assert response.status_code == 400
    assert "stage" in response.json()["detail"].lower()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def test_cli_prints_the_report_and_exits_zero(
    tmp_path: Path, store: LibraryStore, capsys
):
    stage_root = _stage(tmp_path, [_song(_clip_id(400))])
    cli = _load_script(PROMOTE_SCRIPT, "promote_suno_stage_under_test")
    code = cli.main(
        ["--stage-root", str(stage_root), "--library-root", str(store.root)]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["created"] == 1


def test_cli_dry_run_exits_zero_and_writes_nothing(
    tmp_path: Path, store: LibraryStore, capsys
):
    stage_root = _stage(tmp_path, [_song(_clip_id(401))])
    cli = _load_script(PROMOTE_SCRIPT, "promote_suno_stage_dry")
    code = cli.main(
        [
            "--stage-root",
            str(stage_root),
            "--library-root",
            str(store.root),
            "--dry-run",
        ]
    )
    assert code == 0
    assert json.loads(capsys.readouterr().out)["dry_run"] is True
    assert list(Path(store.root).glob("*/metadata.json")) == []


def test_cli_refuses_a_bad_stage_root_with_exit_one(tmp_path: Path, capsys):
    cli = _load_script(PROMOTE_SCRIPT, "promote_suno_stage_refuse")
    code = cli.main(
        [
            "--stage-root",
            str(tmp_path / "nothing"),
            "--library-root",
            str(tmp_path / "lib"),
        ]
    )
    assert code == 1
    assert capsys.readouterr().err.strip()


def test_cli_returns_130_when_interrupted(tmp_path: Path, store: LibraryStore, capsys):
    stage_root = _stage(tmp_path, [_song(_clip_id(410 + i)) for i in range(20)])
    cli = _load_script(PROMOTE_SCRIPT, "promote_suno_stage_interrupt")
    stop = cli.StopRequest()
    stop.request()
    code = cli.main(
        [
            "--stage-root",
            str(stage_root),
            "--library-root",
            str(store.root),
            "--batch-size",
            "5",
        ],
        should_stop=stop,
    )
    assert code == cli.INTERRUPTED_EXIT_CODE
    capsys.readouterr()
