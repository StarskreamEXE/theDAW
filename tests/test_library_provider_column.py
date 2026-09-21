"""The resolved ``entries.provider`` column.

``provider=<slug>`` used to be answered by a SQL rule whose first arm was a
``json_extract`` over ``metadata_json``. Evaluating that for a filtered list or
count makes SQLite read every row's metadata, and the user's real rows carry
their provider's own record at ~34 KB each: measured on that library (194,508
entries) ``GET /entries?provider=suno&limit=200`` took 13.3 s where an
unfiltered page took 0.10 s. The repo's own budget tests never saw it, because
their synthetic rows have a two-byte metadata blob.

These tests pin the replacement: the half of the rule that needs an entry's
metadata is resolved ONCE, by whichever writer is already holding that
metadata, into an indexed column; the other half stays the ``(model, source)``
fallback; and every query -- the page, its count, the id list and the facet --
compares or groups on the two together, so no two of them can file one row
under different slugs.

Every fixture is synthetic. No entry id, model, provider or path below names
anything in anyone's library.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import pytest

from backend.modules.library import db as db_module
from backend.modules.library.db import (
    SCHEMA_VERSION,
    EntryFilters,
    LibraryDB,
    infer_provider,
    resolved_provider_slug,
)
from backend.modules.library.store import LibraryStore

#: Budgets the ticket sets, on the realistic fixture below.
PAGE_BUDGET_MS = 150.0
FACET_BUDGET_MS = 300.0

#: The realistic fixture. 60,000 rows whose ``metadata_json`` is padded to ~8 KB
#: each -- ~480 MB of blob, which is what the old rule had to read per filtered
#: page and what the repo's other perf fixtures (a two-byte blob) do not have.
PERF_ROWS = 60_000
PERF_BLOB_BYTES = 8 * 1024

_PAD_CHUNK = "lorem ipsum dolor sit amet consectetur adipiscing elit "

#: A slug carried by ~10 of the 60,000 rows. Invented for this file.
RARE_SLUG = "quiet-shelf"


def _payload(entry_id: str, **overrides) -> dict:
    payload: dict = {
        "id": entry_id,
        "kind": "audio",
        "title": entry_id,
        "model": "medium",
        "source": "generate",
        "duration": 1.0,
        "audio_filename": "output.wav",
        "timestamp": "2026-09-21T00:00:00Z",
        "metadata_json": {},
    }
    payload.update(overrides)
    return payload


def _seed_entry(root: Path, entry_id: str, meta: dict) -> Path:
    """One flat on-disk entry, the layout an import leaves behind."""
    entry_dir = root / entry_id
    entry_dir.mkdir(parents=True, exist_ok=True)
    (entry_dir / "audio.mp3").write_bytes(b"")
    payload = {
        "id": entry_id,
        "filename": "audio.mp3",
        "audio_filename": "audio.mp3",
        "mime_type": "audio/mpeg",
        "title": entry_id,
        "model": "medium",
        "source": "generate",
        "duration": 1.0,
        "tags": [],
        "saved_at": 1700000000.0,
    }
    payload.update(meta)
    (entry_dir / "metadata.json").write_text(json.dumps(payload), encoding="utf-8")
    return entry_dir


def _column(db: LibraryDB, entry_id: str):
    row = db._conn.execute(
        "SELECT provider FROM entries WHERE id = ?", (entry_id,)
    ).fetchone()
    return row["provider"] if row else None


def _indexes(conn: sqlite3.Connection) -> set[str]:
    return {
        str(r[0])
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index'"
        ).fetchall()
    }


def _row_dump(conn: sqlite3.Connection, columns: str) -> list[tuple]:
    return [
        tuple(r) for r in conn.execute(f"SELECT {columns} FROM entries ORDER BY id")
    ]


def _traced(db: LibraryDB, run) -> list[str]:
    """Every SQL statement ``run()`` executes, expanded with its parameters."""
    seen: list[str] = []
    db._conn.set_trace_callback(seen.append)
    try:
        run()
    finally:
        db._conn.set_trace_callback(None)
    return seen


def _plan(conn: sqlite3.Connection, sql: str) -> list[str]:
    return [str(r[-1]) for r in conn.execute("EXPLAIN QUERY PLAN " + sql).fetchall()]


# ---------------------------------------------------------------------------
# The migration
# ---------------------------------------------------------------------------


@pytest.fixture
def v8_library(tmp_path: Path) -> Path:
    """A library written by the build BEFORE the column existed, then closed.

    The migration list is truncated only while this database is being created
    and is restored before the fixture returns, so the test that follows opens
    it with the real, current build -- which is the upgrade being tested.
    """
    current = db_module._MIGRATIONS
    db_module._MIGRATIONS = current[:-1]
    try:
        db = LibraryDB(tmp_path / "library.db")
        assert db.schema_version() == SCHEMA_VERSION - 1
        _seed_v8_rows(db)
    finally:
        db_module._MIGRATIONS = current
    db.close()
    return tmp_path / "library.db"


def _seed_v8_rows(db: LibraryDB) -> None:
    # Written with the INSERT that build issued -- it cannot name a column
    # that does not exist yet, which is also the point of the last test below.
    db._conn.executemany(
        "INSERT INTO entries (id, kind, title, model, source, created_at, "
        "updated_at, metadata_json) VALUES (?, 'audio', ?, ?, ?, 1.0, 1.0, ?)",
        [
            (
                "old_labeled",
                "old_labeled",
                "medium",
                "generate",
                '{"provider": "bandcamp"}',
            ),
            ("old_legacy", "old_legacy", "medium", "import", '{"suno_id": "s-01"}'),
            ("old_plain", "old_plain", "medium", "generate", "{}"),
            ("old_udio", "old_udio", "udio-1", "import", "{}"),
        ],
    )
    db._conn.commit()


def test_the_migration_adds_the_column_and_its_indexes_without_touching_a_row(
    v8_library: Path,
):
    """Additive and O(1) in rows: the schema gains a column and three indexes,
    and not one existing row is rewritten.

    ``ADD COLUMN`` with no default only rewrites the schema -- SQLite reads a
    record that is short of the new column back as NULL -- so this costs the
    same on an empty library and on 200,000 entries, and it never opens one
    row's metadata. That is the whole reason there is no backfill.
    """
    old = sqlite3.connect(str(v8_library))
    old.row_factory = sqlite3.Row
    columns = (
        "id, kind, title, prompt, negative_prompt, model, duration_sec, steps, "
        "cfg, seed, mime, audio_filename, file_size_bytes, source, favorite, "
        "rating, notes, timestamp, created_at, updated_at, analysis_status, "
        "stems_status, midi_status, metadata_json, play_count, last_played_at"
    )
    before = _row_dump(old, columns)
    assert "provider" not in {r[1] for r in old.execute("PRAGMA table_info(entries)")}
    old.close()

    db = LibraryDB(v8_library)
    assert db.schema_version() == SCHEMA_VERSION
    assert _row_dump(db._conn, columns) == before
    assert {r[1] for r in db._conn.execute("PRAGMA table_info(entries)")} >= {
        "provider"
    }
    # Nothing was resolved: the migration wrote no row, so every pre-existing
    # entry is still unresolved and still answered by the fallback.
    assert _column(db, "old_labeled") is None
    assert _column(db, "old_legacy") is None
    assert {
        "idx_entries_provider",
        "idx_entries_provider_created",
        "idx_entries_provider_any_kind",
        "idx_entries_facet_provider",
    } <= _indexes(db._conn)
    db.close()


def test_the_migration_is_idempotent_and_a_fresh_library_is_born_with_it(
    v8_library: Path, tmp_path: Path
):
    """Re-opening runs nothing a second time, and a brand new database is
    already at the current schema rather than migrating into it."""
    first = LibraryDB(v8_library)
    dump = _row_dump(first._conn, "id, provider, metadata_json")
    first.close()
    again = LibraryDB(v8_library)
    assert again.schema_version() == SCHEMA_VERSION
    assert _row_dump(again._conn, "id, provider, metadata_json") == dump
    again.close()

    fresh = LibraryDB(tmp_path / "fresh.db")
    assert fresh.schema_version() == SCHEMA_VERSION
    assert {
        "idx_entries_provider",
        "idx_entries_provider_created",
        "idx_entries_provider_any_kind",
        "idx_entries_facet_provider",
    } <= _indexes(fresh._conn)
    fresh.close()


def test_a_build_that_does_not_know_the_column_still_reads_and_writes(
    v8_library: Path,
):
    """The column is nullable with no default, so the statements an older build
    issues -- which name every column except this one -- still work against a
    migrated database."""
    LibraryDB(v8_library).close()
    old = sqlite3.connect(str(v8_library))
    old.row_factory = sqlite3.Row
    old.execute(
        "INSERT INTO entries (id, kind, title, model, source, created_at, "
        "updated_at, metadata_json) VALUES ('from_old', 'audio', 'x', 'medium', "
        "'import', 1.0, 1.0, '{}')"
    )
    old.commit()
    row = dict(old.execute("SELECT * FROM entries WHERE id='from_old'").fetchone())
    assert row["provider"] is None
    old.close()

    db = LibraryDB(v8_library)
    # ... and the row an older build wrote is filed under the fallback, which
    # is the answer it has always had.
    assert "from_old" in set(db.list_entry_ids(EntryFilters(provider="import"), 10))
    db.close()


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------


def test_every_upsert_resolves_the_column_from_the_metadata_it_writes(tmp_path: Path):
    """One choke point: the column is derived inside ``_entry_row``, so every
    writer that upserts a row fills it without knowing it exists."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_payload("a", metadata_json={"provider": "Bandcamp"}))
    db.upsert_entries_bulk(
        [
            _payload("b", source="import", metadata_json={"suno_id": "s-02"}),
            _payload("c", metadata_json={"tags": ["sunoid:s-03"]}),
            _payload("d", model="udio-1", source="import"),
        ]
    )
    # Stored lowercase and bounded, from the metadata, never from the columns.
    assert _column(db, "a") == "bandcamp"
    assert _column(db, "b") == "suno"
    assert _column(db, "c") == "suno"
    # Nothing in d's METADATA names a provider, so the column stays unresolved
    # and the fallback answers for it.
    assert _column(db, "d") is None
    assert set(db.list_entry_ids(EntryFilters(provider="udio"), 10)) == {"d"}
    db.close()


def test_an_upsert_carries_the_column_with_the_metadata_it_replaces(tmp_path: Path):
    """A re-upsert that changes the metadata changes the column in the same
    statement, so the two can never describe different providers."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_payload("a", metadata_json={"provider": "bandcamp"}))
    assert _column(db, "a") == "bandcamp"
    db.upsert_entry(_payload("a", metadata_json={"provider": "soundcloud"}))
    assert _column(db, "a") == "soundcloud"
    assert set(db.list_entry_ids(EntryFilters(provider="soundcloud"), 10)) == {"a"}
    assert db.list_entry_ids(EntryFilters(provider="bandcamp"), 10) == []
    db.close()


def test_the_metadata_write_through_resolves_the_column_in_the_same_write(
    tmp_path: Path,
):
    """``set_entry_metadata`` is the read path's narrow, metadata-only write
    (T08). It writes the column beside the blob in one statement: a label the
    read path just recorded has to be a label the filter answers to, which is
    the entire reason that method exists."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_payload("a", source="import"))
    assert _column(db, "a") is None
    before = db.library_revision()

    assert db.set_entry_metadata({"a": {"provider": "bandcamp"}}) == 1

    assert _column(db, "a") == "bandcamp"
    assert set(db.list_entry_ids(EntryFilters(provider="bandcamp"), 10)) == {"a"}
    # Still not an edit: no revision bump, no updated_at move.
    assert db.library_revision() == before
    db.close()


def test_an_import_and_a_reindex_resolve_the_column_from_disk(tmp_path: Path):
    """The store's two metadata-owning writers. ``reindex()`` re-reads every
    ``metadata.json`` by design -- it is the user-invoked repair path -- so it
    resolves the column for the rows it rebuilds, without being a new walk."""
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    _seed_entry(root, "labeled", {"provider": "bandcamp", "provider_label": "Bandcamp"})
    _seed_entry(root, "legacy", {"source": "import", "suno_id": "s-04"})
    _seed_entry(root, "plain", {"model": "medium", "source": "generate"})
    store = LibraryStore(root)  # opening auto-reindexes
    assert store.db is not None
    assert _column(store.db, "labeled") == "bandcamp"
    assert _column(store.db, "legacy") == "suno"
    assert _column(store.db, "plain") is None

    # A hand-repaired metadata.json is picked up by the repair path.
    (root / "plain" / "metadata.json").write_text(
        json.dumps({"id": "plain", "audio_filename": "audio.mp3", "provider": "udio"}),
        encoding="utf-8",
    )
    store.reindex()
    assert _column(store.db, "plain") == "udio"


# ---------------------------------------------------------------------------
# Never overwrite
# ---------------------------------------------------------------------------


def test_filling_never_overwrites_a_provider_the_row_already_has(tmp_path: Path):
    """The same never-overwrite rule the metadata blob lives under, spelled in
    the UPDATE's own WHERE clause so two threads racing on one row cannot both
    win with different values."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_payload("a", metadata_json={"provider": "bandcamp"}))
    db.upsert_entry(_payload("b", source="import"))

    assert db.fill_entry_providers({"a": "soundcloud", "b": "suno"}) == 1

    assert _column(db, "a") == "bandcamp"
    assert _column(db, "b") == "suno"
    # And a second call for the same rows writes nothing at all.
    assert db.fill_entry_providers({"a": "soundcloud", "b": "udio"}) == 0
    assert _column(db, "b") == "suno"
    db.close()


# ---------------------------------------------------------------------------
# Lazy resolution, and what the user sees before it happens
# ---------------------------------------------------------------------------


@pytest.fixture
def older_library(tmp_path: Path) -> LibraryStore:
    """A library whose rows were labeled BEFORE the column existed: the answer
    is in each ``metadata.json``, the column is NULL."""
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    _seed_entry(root, "shop", {"source": "import", "provider": "bandcamp"})
    _seed_entry(root, "legacy", {"source": "import", "suno_id": "s-05"})
    _seed_entry(root, "plain", {"source": "generate", "model": "medium"})
    store = LibraryStore(root)
    assert store.db is not None
    store.db._conn.execute("UPDATE entries SET provider = NULL")
    store.db._conn.commit()
    return store


def test_an_unresolved_row_is_filtered_counted_and_faceted_under_one_slug(
    older_library: LibraryStore,
):
    """What the user sees between "column NULL" and "column filled".

    The row is returned by, counted in and faceted under the SAME slug at every
    moment -- the fallback's, before; its metadata's, after -- because all
    three read one expression. The answer changes; it is never split, and no
    entry is ever returned under two slugs.
    """
    db = older_library.db
    assert db is not None

    def agree() -> dict[str, int]:
        facet = {
            row["value"]: row["count"]
            for row in db.facet_counts(EntryFilters(), ["provider"])["provider"]
        }
        seen: dict[str, list[str]] = {}
        for slug, count in facet.items():
            ids = db.list_entry_ids(EntryFilters(provider=slug), 100)
            assert (
                count
                == len(ids)
                == db.count_entries_filtered(EntryFilters(provider=slug))
            ), slug
            for entry_id in ids:
                seen.setdefault(entry_id, []).append(slug)
        assert all(len(slugs) == 1 for slugs in seen.values()), seen
        assert sum(facet.values()) == 3
        return facet

    # Before: the fallback answers. 'shop' is filed under 'import' (its source)
    # even though its metadata says bandcamp -- consistently, in all three.
    assert agree() == {"import": 2, "stable-audio": 1}

    older_library.list_entries_page(EntryFilters(), limit=10)

    # After: the metadata's answer, in all three.
    assert agree() == {"bandcamp": 1, "suno": 1, "stable-audio": 1}


def test_the_first_read_resolves_an_older_row_and_the_second_writes_nothing(
    older_library: LibraryStore,
):
    """Resolution is once per row and then free: the second view of the same
    page issues no UPDATE at all, because there is nothing left unresolved."""
    db = older_library.db
    assert db is not None

    first = _traced(
        db, lambda: older_library.list_entries_page(EntryFilters(), limit=10)
    )
    assert _column(db, "shop") == "bandcamp"
    assert _column(db, "legacy") == "suno"
    # 'plain' names no provider, so there is nothing to resolve for it and it
    # is not written on this read or any later one.
    assert _column(db, "plain") is None
    assert any("UPDATE entries SET provider" in sql for sql in first)

    second = _traced(
        db, lambda: older_library.list_entries_page(EntryFilters(), limit=10)
    )
    assert not any("UPDATE entries SET provider" in sql for sql in second)


def test_a_provider_filtered_page_never_refiles_its_own_rows(
    older_library: LibraryStore,
):
    """A page chosen by SQL under one slug must not be relabeled underneath the
    user's cursor -- rows would vanish from the result set as it is read and
    ``total`` would disagree with the rows. Same rule the read-time provider
    upgrade follows (``router._attach_analysis``)."""
    db = older_library.db
    assert db is not None
    traced = _traced(
        db,
        lambda: older_library.list_entries_page(
            EntryFilters(provider="import"), limit=10
        ),
    )
    assert not any("UPDATE entries SET provider" in sql for sql in traced)
    assert _column(db, "shop") is None


# ---------------------------------------------------------------------------
# No query opens the blob
# ---------------------------------------------------------------------------


def test_the_filtered_list_count_ids_and_facet_never_open_metadata_json(
    tmp_path: Path,
):
    """The structural guarantee, which does not depend on machine speed.

    Every statement these four issue is captured and checked for the column
    whose size is the defect, and every plan is checked for an index rather
    than a table scan. The page row itself still RETURNS ``metadata_json`` --
    the record needs its tags and lyrics -- but no predicate, group key or sort
    key reads it, so the cost is 200 rows rather than the whole library.
    """
    db = LibraryDB(tmp_path / "library.db", enable_fts=False)
    db.upsert_entries_bulk(
        [
            _payload(f"e{i:03d}", metadata_json={"provider": "bandcamp"})
            for i in range(20)
        ]
    )
    filters = EntryFilters(kinds=frozenset({"audio"}), provider="bandcamp")
    operations = {
        "page": lambda: db.list_entries_page(filters, limit=200),
        "count": lambda: db.count_entries_filtered(filters),
        "ids": lambda: db.list_entry_ids(filters, 5000),
        "facet": lambda: db.facet_counts(filters, ["provider"]),
    }
    for label, run in operations.items():
        for sql in _traced(db, run):
            assert "metadata_json" not in sql, (label, sql)
            plan = " | ".join(_plan(db._conn, sql))
            assert "metadata_json" not in plan, (label, plan)
    db.close()


# ---------------------------------------------------------------------------
# The budget, on realistic rows
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def realistic_db(tmp_path_factory) -> LibraryDB:
    """60,000 entries whose metadata is padded to ~8 KB each.

    This is the fixture the defect needs: at two bytes of metadata per row --
    what every other perf fixture in this repo uses -- reading every row's
    blob is free and a rule that does it looks fast. ``enable_fts=False``
    because nothing here searches; the full-text index would only lengthen the
    build.
    """
    path = tmp_path_factory.mktemp("provider_perf") / "library.db"
    db = LibraryDB(path, enable_fts=False)
    models = ["medium", "small", "suno", "udio-1", "riffusion", "gemini-music"]
    sources = ["generate", "import", "studio", "folder"]
    pad = {
        f"raw_field_{i}": _PAD_CHUNK
        for i in range(PERF_BLOB_BYTES // len(_PAD_CHUNK) + 1)
    }

    def payloads():
        for i in range(PERF_ROWS):
            meta = dict(pad)
            if i % 3 == 0:
                meta["provider"] = "bandcamp"
            # A RARE slug: the worst case for a filter that cannot seek, since
            # a scan runs to the end of the table before it has 200 rows.
            elif i % 6007 == 1:
                meta["provider"] = RARE_SLUG
            yield _payload(
                f"e{i:07d}",
                kind="audio" if i % 10 else "video",
                model=models[i % len(models)],
                source=sources[(i // 7) % len(sources)],
                metadata_json=meta,
            )

    assert db.upsert_entries_bulk(payloads(), batch=2000) == PERF_ROWS
    assert 0 < db.count_entries_filtered(EntryFilters(provider=RARE_SLUG)) < 20
    yield db
    db.close()
    # ~0.75 GB, and pytest keeps the last three basetemp roots. Removed here so
    # nothing accumulates even when a caller forgets to clean the basetemp.
    for suffix in ("", "-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)


def _ms(run) -> float:
    start = time.perf_counter()
    run()
    return (time.perf_counter() - start) * 1000


#: ``(label, kinds, slug)``. ``kinds=None`` is the ``?kind=all`` tab, which
#: ``router._KIND_FILTERS`` maps to no ``e.kind`` clause at all -- so the
#: leading column of ``idx_entries_provider_created`` is unconstrained and the
#: page cannot seek. A RARE slug is that shape's worst case: the scan runs the
#: longest before it has 200 rows or reaches the end.
BUDGET_CASES = [
    ("audio/common", frozenset({"audio"}), "bandcamp"),
    ("audio/suno", frozenset({"audio"}), "suno"),
    ("audio/import", frozenset({"audio"}), "import"),
    ("audio/rare", frozenset({"audio"}), RARE_SLUG),
    ("all/common", None, "bandcamp"),
    ("all/rare", None, RARE_SLUG),
]


@pytest.mark.parametrize(
    "label,kinds,slug", BUDGET_CASES, ids=[case[0] for case in BUDGET_CASES]
)
def test_a_provider_filtered_page_and_its_count_stay_inside_the_budget(
    realistic_db: LibraryDB, label: str, kinds, slug: str
):
    filters = EntryFilters(kinds=kinds, provider=slug)
    page_ms = _ms(lambda: realistic_db.list_entries_page(filters, limit=200))
    count_ms = _ms(lambda: realistic_db.count_entries_filtered(filters))
    assert page_ms < PAGE_BUDGET_MS, f"{label} page took {page_ms:.1f}ms"
    assert count_ms < PAGE_BUDGET_MS, f"{label} count took {count_ms:.1f}ms"


def test_the_provider_facet_stays_inside_its_budget(realistic_db: LibraryDB):
    for filters in (
        EntryFilters(kinds=frozenset({"audio"})),
        EntryFilters(),
        EntryFilters(kinds=frozenset({"audio"}), favorite=False),
    ):
        facet_ms = _ms(lambda: realistic_db.facet_counts(filters, ["provider"]))
        assert facet_ms < FACET_BUDGET_MS, f"facet took {facet_ms:.1f}ms"


def test_the_filtered_page_is_an_index_seek_at_sixty_thousand_realistic_rows(
    realistic_db: LibraryDB,
):
    """The plan, not the clock: an indexed SEEK on the resolved expression for
    the page, its count and the id list, and a covering index for the facet.

    An expression index is matched textually-after-resolution, so a drift
    between :data:`~.db.PROVIDER_SQL` and the expression migration 9 declares
    would be SILENT -- the queries stay correct and go 60,000 rows slower.
    This is what notices.
    """
    filters = EntryFilters(kinds=frozenset({"audio"}), provider="bandcamp")
    plans = {
        "page": _traced(realistic_db, lambda: realistic_db.list_entries_page(filters)),
        "count": _traced(
            realistic_db, lambda: realistic_db.count_entries_filtered(filters)
        ),
        "ids": _traced(
            realistic_db, lambda: realistic_db.list_entry_ids(filters, 5000)
        ),
        "facet": _traced(
            realistic_db, lambda: realistic_db.facet_counts(filters, ["provider"])
        ),
    }
    for label, statements in plans.items():
        for sql in statements:
            plan = " | ".join(_plan(realistic_db._conn, sql))
            assert "SCAN e" not in plan, (label, plan)
            if label == "facet":
                assert "idx_entries_facet_provider" in plan, plan
            else:
                assert "idx_entries_provider_created" in plan, (label, plan)

    # The "all" tab sends no kind, so the index above cannot seek -- its
    # leading column is unconstrained. The kind-less twin is what keeps that
    # page a seek instead of a scan to the end of the table.
    any_kind = _traced(
        realistic_db,
        lambda: realistic_db.list_entries_page(EntryFilters(provider=RARE_SLUG)),
    )
    for sql in any_kind:
        plan = " | ".join(_plan(realistic_db._conn, sql))
        assert "idx_entries_provider_any_kind" in plan, plan
        assert "SCAN e" not in plan, plan


def test_the_counts_agree_with_the_filter_on_every_slug_at_scale(
    realistic_db: LibraryDB,
):
    """The invariant the facet used to break, checked on the big table: for
    every slug the facet reports, the filter returns exactly that many rows."""
    filters = EntryFilters(kinds=frozenset({"audio"}))
    facet = realistic_db.facet_counts(filters, ["provider"])["provider"]
    assert facet
    for row in facet:
        assert (
            realistic_db.count_entries_filtered(
                EntryFilters(kinds=frozenset({"audio"}), provider=row["value"])
            )
            == row["count"]
        ), row
    audio = realistic_db.count_entries_filtered(filters)
    assert sum(row["count"] for row in facet) == audio


def test_the_python_fold_and_the_sql_expression_are_one_rule(realistic_db: LibraryDB):
    """``infer_provider`` is the twin of the fallback, and the facet's fold of
    ``COALESCE(column, fallback)`` is the twin of ``PROVIDER_SQL``. Checked
    against SQL's own answer for every distinct triple in the table."""
    rows = realistic_db._conn.execute(
        "SELECT DISTINCT provider AS p, model AS m, source AS s FROM entries"
    ).fetchall()
    assert rows
    for row in rows:
        sql_answer = realistic_db._conn.execute(
            f"SELECT {db_module.PROVIDER_SQL} AS v FROM entries e "
            "WHERE e.provider IS ? AND e.model = ? AND e.source = ? LIMIT 1",
            (row["p"], row["m"], row["s"]),
        ).fetchone()["v"]
        assert (row["p"] or infer_provider(row["m"], row["s"])) == sql_answer
        assert resolved_provider_slug({"provider": row["p"]} if row["p"] else {}) == (
            row["p"] or None
        )
