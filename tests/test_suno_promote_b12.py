"""T06 SUNO PROMOTE fixes (batch 12).

Nothing here reads the user's real cache or writes the user's real library:
every fixture lives under ``tmp_path``, mirroring the fixture discipline in
``tests/test_suno_promote.py``.

Covers:

* L1 -- ``--dry-run`` must not open the library database read-write. It must
  not create the library folder/db at all against a target that does not yet
  exist, and it must not touch (mutate) an existing library database's file
  contents either.
* L2 -- a dry run's lineage pass must resolve a parent against the id THIS
  run would create, not only against ids a *previous* real run already
  committed receipts for.
* F12 -- the legacy title-dedupe importer moved to ``deprecated/`` and is
  gone from ``scripts/``.
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import uuid
from pathlib import Path
from typing import Any, Iterable, Optional

import pytest

from backend.modules.library import suno_promote, suno_stage
from backend.modules.library.store import LibraryStore

REPO_ROOT = Path(__file__).resolve().parents[1]
PROMOTE_SCRIPT = REPO_ROOT / "scripts" / "promote_suno_stage.py"
OLD_INGEST_SCRIPT = REPO_ROOT / "scripts" / "ingest_suno_cache.py"


# ---------------------------------------------------------------------------
# Fixture helpers (duplicated locally on purpose -- own tests only)
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
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"promote-b12-test/{n}"))


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
    source = _write_jsonl(tmp_path / f"{name}.jsonl", records)
    stage_root = tmp_path / f"stage-{name}"
    report = suno_stage.stage_cache(source, stage_root, media_root=media_root)
    assert report.complete, report.status
    return stage_root


def _load_script(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def store(tmp_path: Path) -> LibraryStore:
    return LibraryStore(tmp_path / "library")


# ---------------------------------------------------------------------------
# L1: dry run opens the library DB read-only
# ---------------------------------------------------------------------------


def test_dry_run_does_not_create_a_library_that_does_not_exist_yet(
    tmp_path: Path,
):
    """A --dry-run against a fresh target must not mkdir the library root or
    create library.db -- opening it read-write today does both."""
    songs = [_song(_clip_id(1))]
    stage_root = _stage(tmp_path, songs)
    library_root = tmp_path / "library-never-touched"
    assert not library_root.exists()

    cli = _load_script(PROMOTE_SCRIPT, "promote_b12_fresh_dry")
    code = cli.main(
        [
            "--stage-root",
            str(stage_root),
            "--library-root",
            str(library_root),
            "--dry-run",
        ]
    )
    assert code == 0
    assert not library_root.exists(), (
        "dry run created the library folder/db; it must open read-only "
        "(or not open a non-existent target at all)"
    )


def test_dry_run_does_not_mutate_an_existing_library_db_file(
    tmp_path: Path, store: LibraryStore
):
    """A --dry-run against a real, already-populated library must not change
    a single byte of library.db, and must not leave new WAL/journal sidecar
    files (or any other new file) in the library directory -- CLI path."""
    suno_promote.promote_stage(
        _stage(tmp_path, [_song(_clip_id(2))], name="seed"), store
    )
    db_path = store.db.path
    library_dir = db_path.parent
    # Close the seeding connection first: WAL frames a still-open writer
    # holds are not part of "what a dry run must leave alone" -- they are
    # this run's own writes, still pending their own checkpoint.
    store.db.close()

    before_bytes = db_path.read_bytes()
    before_listing = sorted(
        (p.name, p.stat().st_size) for p in library_dir.iterdir() if p.is_file()
    )

    songs = [_song(_clip_id(3)), _song(_clip_id(4))]
    stage_root = _stage(tmp_path, songs, name="dry")
    cli = _load_script(PROMOTE_SCRIPT, "promote_b12_existing_dry")
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

    after_bytes = db_path.read_bytes()
    after_listing = sorted(
        (p.name, p.stat().st_size) for p in library_dir.iterdir() if p.is_file()
    )
    assert after_bytes == before_bytes, "dry run mutated library.db bytes"
    assert after_listing == before_listing, (
        "dry run changed the library directory's file listing: "
        f"before={before_listing!r} after={after_listing!r}"
    )


def test_dry_run_does_not_leave_wal_sidecars_via_promote_stage_directly(
    tmp_path: Path, store: LibraryStore
):
    """Item 1, non-CLI path: opening library.db mode=ro for the first time
    (no reader has ever opened it before) must not create -shm/-wal either."""
    suno_promote.promote_stage(
        _stage(tmp_path, [_song(_clip_id(21))], name="seed"), store
    )
    db_path = store.db.path
    library_dir = db_path.parent
    store.db.close()

    before_listing = sorted(p.name for p in library_dir.iterdir() if p.is_file())

    target = suno_promote.open_promotion_target(store.root, dry_run=True)
    try:
        report = suno_promote.promote_stage(
            _stage(tmp_path, [_song(_clip_id(22))], name="dry2"),
            target,
            dry_run=True,
        )
    finally:
        target.close()

    assert report.created == 1
    after_listing = sorted(p.name for p in library_dir.iterdir() if p.is_file())
    assert after_listing == before_listing, (
        f"read-only open left new files: before={before_listing!r} "
        f"after={after_listing!r}"
    )


def test_dry_run_still_reports_correct_counts_against_a_real_library(
    tmp_path: Path, store: LibraryStore
):
    """Read-only must not mean blind: a dry run still has to see what is
    already in the library to tell created from unchanged."""
    seed_songs = [_song(_clip_id(5))]
    suno_promote.promote_stage(_stage(tmp_path, seed_songs, name="seed"), store)
    assert store.db.count_entries() == 1

    # Same song again (unchanged) plus one truly new song.
    songs = [_song(_clip_id(5)), _song(_clip_id(6))]
    stage_root = _stage(tmp_path, songs, name="mix")
    report = suno_promote.promote_stage(stage_root, store, dry_run=True)

    assert report.dry_run is True
    assert report.created == 1
    assert report.unchanged == 1
    # still untouched
    assert store.db.count_entries() == 1


# ---------------------------------------------------------------------------
# L2: dry run resolves lineage against ids the run would itself create
# ---------------------------------------------------------------------------


def test_dry_run_resolves_a_parent_the_same_run_would_create(
    tmp_path: Path, store: LibraryStore
):
    """Parent and child are staged together and neither exists in the
    library yet. A dry run must not call the parent unresolved just because
    it never persisted a receipt for it."""
    parent, child = _clip_id(10), _clip_id(11)
    songs = [
        _song(parent),
        _song(child, metadata={"duration": 10.0, "cover_audio_id": parent}),
    ]
    stage_root = _stage(tmp_path, songs)

    report = suno_promote.promote_stage(stage_root, store, dry_run=True)

    assert report.lineage_edges == 1
    assert report.lineage_unresolved == 0
    # still a dry run: nothing was actually written
    assert store.db.count_entries() == 0


def test_dry_run_still_reports_a_truly_unresolved_parent(
    tmp_path: Path, store: LibraryStore
):
    """A parent that is neither staged in this run nor already promoted must
    still come back unresolved -- the fix must not over-correct to zero."""
    child, ghost_parent = _clip_id(12), _clip_id(13)
    songs = [_song(child, metadata={"cover_audio_id": ghost_parent})]
    stage_root = _stage(tmp_path, songs)

    report = suno_promote.promote_stage(stage_root, store, dry_run=True)

    assert report.lineage_edges == 1
    assert report.lineage_unresolved == 1


def test_dry_run_resolves_a_parent_already_promoted_by_an_earlier_real_run(
    tmp_path: Path, store: LibraryStore
):
    """Regression guard: resolving against ids from a prior real run (via the
    staging receipts, persisted in the SAME resumable stage_root) must keep
    working after the fix."""
    parent, child = _clip_id(14), _clip_id(15)
    stage_root = tmp_path / "stage-resumable"
    suno_stage.stage_cache(
        _write_jsonl(tmp_path / "parent.jsonl", [_song(parent)]), stage_root
    )
    suno_promote.promote_stage(stage_root, store)  # real run: parent promoted

    suno_stage.stage_cache(
        _write_jsonl(
            tmp_path / "child.jsonl",
            [_song(child, metadata={"cover_audio_id": parent})],
        ),
        stage_root,
    )
    report = suno_promote.promote_stage(stage_root, store, dry_run=True)

    assert report.lineage_edges == 1
    assert report.lineage_unresolved == 0


# ---------------------------------------------------------------------------
# F12: the legacy title-dedupe importer is retired
# ---------------------------------------------------------------------------


def test_the_legacy_ingest_script_moved_to_deprecated() -> None:
    """Item 2: ``deprecated/`` is git-ignored, so it does not exist on a
    fresh clone/CI checkout -- only assert the old path is gone, never that
    the new one exists."""
    assert not OLD_INGEST_SCRIPT.exists(), (
        "scripts/ingest_suno_cache.py should have moved to deprecated/"
    )


# ---------------------------------------------------------------------------
# Item 3: a locked staging database must not be read as "unresolved"
# ---------------------------------------------------------------------------


class _RaisingConnection:
    """Stands in for a stage db connection whose query always fails."""

    def __init__(self, error: sqlite3.OperationalError) -> None:
        self._error = error

    def execute(self, *_args: Any, **_kwargs: Any) -> Any:
        raise self._error


def test_promoted_parents_reraises_a_locked_database_instead_of_swallowing_it() -> None:
    connection = _RaisingConnection(sqlite3.OperationalError("database is locked"))
    with pytest.raises(sqlite3.OperationalError, match="locked"):
        suno_promote._promoted_parents(connection, [("suno", "some-id")], set())


def test_promoted_parents_still_swallows_an_actually_missing_promotions_table() -> None:
    """Regression guard: the ONE operational error that stays benign."""
    connection = _RaisingConnection(
        sqlite3.OperationalError("no such table: promotions")
    )
    resolved_id = suno_stage.asset_id("suno", "some-id")

    result = suno_promote._promoted_parents(
        connection, [("suno", "some-id")], {resolved_id}
    )

    # run_resolved's own match must still come through even though the DB
    # query itself failed with the one error that is not a real problem.
    assert result == {("suno", "some-id")}


def test_a_truly_locked_stage_database_fails_the_dry_run_loudly(
    tmp_path: Path,
) -> None:
    """End-to-end: an actual OS-level lock on the real ``promotions`` table
    must surface, not silently turn every lineage edge into an external
    label."""
    db_path = tmp_path / "locktest.sqlite3"
    setup = sqlite3.connect(db_path)
    setup.execute("CREATE TABLE promotions (asset_id TEXT, outcome TEXT)")
    setup.commit()
    setup.close()

    locker = sqlite3.connect(db_path, timeout=0)
    locker.execute("BEGIN EXCLUSIVE")
    try:
        reader = sqlite3.connect(db_path, timeout=0)
        try:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                suno_promote._promoted_parents(reader, [("suno", "x")], set())
        finally:
            reader.close()
    finally:
        locker.rollback()
        locker.close()


# ---------------------------------------------------------------------------
# Item 4: a missing/empty library.db with entry folders still on disk
# ---------------------------------------------------------------------------


def test_dry_run_matches_a_real_run_when_library_db_is_gone_but_entries_remain(
    tmp_path: Path,
):
    """A real LibraryStore auto-reindexes from disk when its DB is empty; a
    dry run's read-only summaries must see the same thing, without writing
    anything."""
    library_root = tmp_path / "library"
    seed_store = LibraryStore(library_root)
    kept, new_song = _clip_id(60), _clip_id(61)
    suno_promote.promote_stage(_stage(tmp_path, [_song(kept)], name="seed"), seed_store)
    seed_store.db.close()

    # Simulate the DB having gone missing (deleted, never restored from
    # backup, ...) while the entry folder written for `kept` remains.
    (library_root / "library.db").unlink()
    for sidecar in library_root.glob("library.db-*"):
        sidecar.unlink()
    assert (library_root / kept / "metadata.json").is_file()

    stage_root = _stage(tmp_path, [_song(kept), _song(new_song)], name="mix")

    dry_target = suno_promote.open_promotion_target(library_root, dry_run=True)
    try:
        dry_report = suno_promote.promote_stage(stage_root, dry_target, dry_run=True)
    finally:
        dry_target.close()

    real_store = LibraryStore(library_root)  # triggers the real auto-reindex
    real_report = suno_promote.promote_stage(stage_root, real_store)

    assert dry_report.created == real_report.created == 1
    assert dry_report.unchanged == real_report.unchanged == 1


# ---------------------------------------------------------------------------
# Item 5: an older library.db missing columns this version expects
# ---------------------------------------------------------------------------


def test_dry_run_refuses_cleanly_against_an_old_schema_library_db(tmp_path: Path):
    library_root = tmp_path / "library"
    library_root.mkdir(parents=True)
    db_path = library_root / "library.db"
    connection = sqlite3.connect(db_path)
    # Only `id`: none of the columns entries_summary_for's SELECT names.
    connection.execute("CREATE TABLE entries (id TEXT PRIMARY KEY)")
    connection.execute("INSERT INTO entries (id) VALUES ('some-entry')")
    connection.commit()
    connection.close()

    target = suno_promote.ReadOnlyLibraryTarget(library_root)
    try:
        with pytest.raises(suno_promote.PromotionRefused, match="migrate"):
            target.db.entries_summary_for(["some-entry"])
    finally:
        target.close()


# ---------------------------------------------------------------------------
# Item 6: free space cannot be measured at all (e.g. a drive that is gone)
# ---------------------------------------------------------------------------


def test_promote_stage_refuses_cleanly_when_free_space_cannot_be_measured(
    tmp_path: Path, store: LibraryStore, monkeypatch: pytest.MonkeyPatch
):
    def _boom(_path: Path) -> Any:
        raise OSError("no such drive")

    monkeypatch.setattr(suno_promote.shutil, "disk_usage", _boom)
    stage_root = _stage(tmp_path, [_song(_clip_id(70))])

    with pytest.raises(suno_promote.PromotionRefused, match="free space"):
        suno_promote.promote_stage(stage_root, store)


# ---------------------------------------------------------------------------
# Item 7: a UNC library root must not produce a broken sqlite URI
# ---------------------------------------------------------------------------


def test_read_only_sqlite_uri_refuses_a_unc_path() -> None:
    unc_path = Path("\\\\example-host\\share\\library\\library.db")
    assert unc_path.drive.startswith("\\\\"), "fixture is not actually UNC"
    with pytest.raises(ValueError, match="UNC"):
        suno_stage.read_only_sqlite_uri(unc_path)


# ---------------------------------------------------------------------------
# Item 8: SunoJob's dry run must not read through the shared, writable store
# ---------------------------------------------------------------------------


def test_sunojob_dry_run_never_reads_through_the_shared_store_connection(
    tmp_path: Path, store: LibraryStore, monkeypatch: pytest.MonkeyPatch
):
    suno_promote.promote_stage(
        _stage(tmp_path, [_song(_clip_id(80))], name="seed"), store
    )

    def _forbidden(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError(
            "dry run read through the shared store's own live connection"
        )

    monkeypatch.setattr(store.db, "entries_summary_for", _forbidden)

    stage_root = _stage(tmp_path, [_song(_clip_id(81))], name="dry")
    job = suno_promote.SunoJob("job-item8", "suno-promote", {})
    suno_promote.run_promote_job(job, store, stage_root=stage_root, dry_run=True)

    assert job.status == "done", job.errors
    assert job.report is not None
    assert job.report["created"] == 1


# ---------------------------------------------------------------------------
# Item 9: ReadOnlyLibraryTarget, used directly, covering the lineage cases
# ---------------------------------------------------------------------------


def test_read_only_library_target_directly_resolves_a_parent_from_this_run(
    tmp_path: Path,
):
    parent, child = _clip_id(90), _clip_id(91)
    songs = [
        _song(parent),
        _song(child, metadata={"cover_audio_id": parent}),
    ]
    stage_root = _stage(tmp_path, songs)
    library_root = tmp_path / "unwritten-library"

    target = suno_promote.ReadOnlyLibraryTarget(library_root)
    assert isinstance(target.db, suno_promote._ReadOnlyEntrySummaries)
    try:
        report = suno_promote.promote_stage(stage_root, target, dry_run=True)
    finally:
        target.close()

    assert report.lineage_edges == 1
    assert report.lineage_unresolved == 0
    assert not library_root.exists()


def test_read_only_library_target_directly_leaves_a_deferred_parent_unresolved(
    tmp_path: Path,
):
    """A parent staged in this same dry run but deferred (no local audio, no
    audio_url) never gets promoted -- its child's edge must stay unresolved,
    not be treated as resolved just because the parent appeared in this
    run's pages."""
    parent, child = _clip_id(92), _clip_id(93)
    songs = [
        _song(parent, audio_url=""),
        _song(child, metadata={"cover_audio_id": parent}),
    ]
    stage_root = _stage(tmp_path, songs)
    library_root = tmp_path / "unwritten-library-2"

    target = suno_promote.ReadOnlyLibraryTarget(library_root)
    try:
        report = suno_promote.promote_stage(stage_root, target, dry_run=True)
    finally:
        target.close()

    assert report.deferred_no_media == 1
    assert report.lineage_edges == 1
    assert report.lineage_unresolved == 1


# ---------------------------------------------------------------------------
# Follow-up 1: the UNC check runs before is_file(), not after
# ---------------------------------------------------------------------------


def test_read_only_library_target_refuses_a_unc_root_with_no_db_there_either() -> None:
    """A UNC root that has no library.db at it yet must refuse just as
    loudly as one that does -- the check must not be gated behind
    ``is_file()`` finding nothing and quietly falling back to "empty"."""
    unc_root = Path("\\\\example-host\\share\\library")
    assert unc_root.drive.startswith("\\\\"), "fixture is not actually UNC"
    with pytest.raises(suno_promote.PromotionRefused, match="UNC"):
        suno_promote.ReadOnlyLibraryTarget(unc_root)


def test_open_promotion_target_refuses_a_unc_root_for_a_dry_run() -> None:
    unc_root = Path("\\\\example-host\\share\\library2")
    with pytest.raises(suno_promote.PromotionRefused, match="UNC"):
        suno_promote.open_promotion_target(unc_root, dry_run=True)


# ---------------------------------------------------------------------------
# Follow-up 2: a writer appearing mid-dry-run invalidates the counts
# ---------------------------------------------------------------------------


def test_dry_run_refuses_when_a_wal_sidecar_appears_mid_run(
    tmp_path: Path, store: LibraryStore
):
    """An immutable=1 read assumes the file will not change out from under
    it. If a -wal sidecar shows up while the dry run is still going, the
    counts it already collected cannot be trusted -- refuse instead of
    reporting them."""
    suno_promote.promote_stage(
        _stage(tmp_path, [_song(_clip_id(130))], name="seed"), store
    )
    library_root = store.root
    store.db.close()  # checkpoint: no -wal sidecar should remain

    wal_path = library_root / "library.db-wal"
    assert not wal_path.is_file(), "fixture assumption: no -wal at dry run open"

    stage_root = _stage(tmp_path, [_song(_clip_id(131))], name="dry")
    target = suno_promote.open_promotion_target(library_root, dry_run=True)
    assert target.db._opened_immutable, "fixture assumption: opened immutable"

    def _simulate_concurrent_writer(_progress: Any) -> None:
        # A real writer would leave a non-empty -wal; the sidecar's mere
        # existence is what the fix checks for.
        wal_path.write_bytes(b"\x00" * 32)

    try:
        with pytest.raises(suno_promote.PromotionRefused, match="dry run"):
            suno_promote.promote_stage(
                stage_root,
                target,
                dry_run=True,
                on_batch=_simulate_concurrent_writer,
            )
    finally:
        target.close()
        wal_path.unlink(missing_ok=True)


def test_dry_run_does_not_refuse_when_no_writer_appears(
    tmp_path: Path, store: LibraryStore
):
    """Regression guard: an ordinary dry run, with nothing changing
    concurrently, must not trip the new check."""
    suno_promote.promote_stage(
        _stage(tmp_path, [_song(_clip_id(132))], name="seed"), store
    )
    library_root = store.root
    store.db.close()

    stage_root = _stage(tmp_path, [_song(_clip_id(133))], name="dry")
    target = suno_promote.open_promotion_target(library_root, dry_run=True)
    try:
        report = suno_promote.promote_stage(stage_root, target, dry_run=True)
    finally:
        target.close()

    assert report.created == 1


# ---------------------------------------------------------------------------
# Follow-up 3: the CLI closes its target, and refuses cleanly on a missing
# drive for a real (non-dry) run
# ---------------------------------------------------------------------------


def test_cli_closes_the_target_for_a_real_run(tmp_path: Path):
    from backend.modules.library.db import LibraryDB

    close_calls: list[Any] = []
    original_close = LibraryDB.close

    def _tracking_close(self: Any) -> None:
        close_calls.append(self)
        original_close(self)

    LibraryDB.close = _tracking_close  # type: ignore[method-assign]
    try:
        stage_root = _stage(tmp_path, [_song(_clip_id(140))])
        library_root = tmp_path / "lib-close-check"
        cli = _load_script(PROMOTE_SCRIPT, "promote_b12_close_check_real")
        code = cli.main(
            ["--stage-root", str(stage_root), "--library-root", str(library_root)]
        )
    finally:
        LibraryDB.close = original_close  # type: ignore[method-assign]

    assert code == 0
    assert len(close_calls) == 1


def test_cli_closes_the_target_for_a_dry_run(tmp_path: Path):
    close_calls: list[Any] = []
    original_close = suno_promote._ReadOnlyEntrySummaries.close

    def _tracking_close(self: Any) -> None:
        close_calls.append(self)
        original_close(self)

    suno_promote._ReadOnlyEntrySummaries.close = _tracking_close  # type: ignore[method-assign]
    try:
        stage_root = _stage(tmp_path, [_song(_clip_id(141))])
        library_root = tmp_path / "lib-close-check-dry"
        cli = _load_script(PROMOTE_SCRIPT, "promote_b12_close_check_dry")
        code = cli.main(
            [
                "--stage-root",
                str(stage_root),
                "--library-root",
                str(library_root),
                "--dry-run",
            ]
        )
    finally:
        suno_promote._ReadOnlyEntrySummaries.close = original_close  # type: ignore[method-assign]

    assert code == 0
    assert len(close_calls) == 1


def test_cli_refuses_cleanly_on_a_missing_drive_for_a_real_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    stage_root = _stage(tmp_path, [_song(_clip_id(142))])
    library_root = tmp_path / "lib-missing-drive"

    def _boom(_root: Path) -> LibraryStore:
        raise OSError("no such drive")

    monkeypatch.setattr(suno_promote, "LibraryStore", _boom)
    cli = _load_script(PROMOTE_SCRIPT, "promote_b12_missing_drive")
    code = cli.main(
        ["--stage-root", str(stage_root), "--library-root", str(library_root)]
    )

    assert code == cli.REFUSED_EXIT_CODE
    err = capsys.readouterr().err
    assert "Refused" in err
    assert "no such drive" in err


# ---------------------------------------------------------------------------
# Follow-up 4: a zero-byte library.db is reported, not refused
# ---------------------------------------------------------------------------


def test_dry_run_reports_and_counts_a_zero_byte_library_db_as_new(tmp_path: Path):
    library_root = tmp_path / "library"
    library_root.mkdir(parents=True)
    (library_root / "library.db").write_bytes(b"")
    stage_root = _stage(tmp_path, [_song(_clip_id(150))])

    target = suno_promote.open_promotion_target(library_root, dry_run=True)
    try:
        report = suno_promote.promote_stage(stage_root, target, dry_run=True)
    finally:
        target.close()

    assert report.created == 1
    assert any("is empty" in message for message in report.errors), report.errors


def test_zero_byte_library_db_matches_a_real_run(tmp_path: Path):
    library_root = tmp_path / "library"
    library_root.mkdir(parents=True)
    (library_root / "library.db").write_bytes(b"")
    stage_root = _stage(tmp_path, [_song(_clip_id(151))])

    dry_target = suno_promote.open_promotion_target(library_root, dry_run=True)
    try:
        dry_report = suno_promote.promote_stage(stage_root, dry_target, dry_run=True)
    finally:
        dry_target.close()

    real_store = LibraryStore(library_root)  # sqlite3 initializes the 0-byte file
    real_report = suno_promote.promote_stage(stage_root, real_store)

    assert dry_report.created == real_report.created == 1


def test_an_actually_corrupt_library_db_still_refuses(tmp_path: Path):
    """Not the same as follow-up 4's 0-byte case -- garbage bytes are
    corruption, not "not yet created", and must still refuse."""
    library_root = tmp_path / "library"
    library_root.mkdir(parents=True)
    (library_root / "library.db").write_bytes(b"not a real sqlite file" * 10)

    with pytest.raises(suno_promote.PromotionRefused):
        suno_promote.ReadOnlyLibraryTarget(library_root)
