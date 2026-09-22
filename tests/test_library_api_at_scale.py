"""The library API, priced on a library the size of a real one.

Two features passed every test in this repository and then broke on the user's
library (194,508 entries, ~34 KB of ``metadata_json`` a row, 475,174
relations): the provider filter read every row's blob (13.3 s for one page)
and the LEARN tab fetched the whole lineage graph (128 MB, then a crash).
Every existing fixture writes a two-byte metadata blob, so at that weight a
query that reads every row looks free.

This module is the guard that would have caught both. It drives the real
routers over :mod:`tests.library_scale_fixture` -- 20,000 entries, ~8 KB of
metadata each, ~50,000 relations -- and holds them to three rules:

1. **Every GET answers.** Enumerated from ``app.routes``, not from a list
   someone has to remember to extend, so a route added tomorrow is measured
   tomorrow. Status under 500, response under
   :data:`SIZE_BUDGET_BYTES`, wall time under :data:`TIME_BUDGET_SECONDS`.
2. **Nothing whole-library is allowed to grow with the library.** The size
   budget's exceptions are named in :data:`SIZE_ALLOWLIST`, each with its
   reason. One more response does grow with the library -- ``GET /entries``
   with no parameters, the documented pre-paging shape -- and rather than
   being allowlisted away it keeps its own test, which asserts the shape we
   WANT under a strict xfail, so the day it improves the build says "good
   news, remove the marker" instead of going red.
3. **The invariant, not the stopwatch.** A machine's speed is not a
   guarantee; a trace callback is. The paged list, its count, the id list,
   the facets and every lineage-scale route must not execute a single
   statement that opens a blob -- either by naming a blob column or by
   selecting every column of ``entries`` -- outside the documented
   exceptions (:data:`_BLOB_READ_EXCEPTIONS`).

Rule 3 is the one that bites on a fast machine, and it is the one that caught
the planted regression: putting ``json_extract(e.metadata_json, '$.provider')``
back into ``PROVIDER_SQL`` fails
``test_the_list_routes_never_open_a_blob_column`` on this fixture whatever the
hardware does.

Every id, title, provider slug and path here is invented by the fixture
module. Nothing reads, writes or names anything in anyone's library.
"""

from __future__ import annotations

import os
import re
import shutil
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.assets import router as assets_router_module
from backend.modules.library import router as library_router_module
from backend.modules.lineagescale import router as lineagescale_router_module
from tests.library_scale_fixture import (
    COMMON_ID,
    ENTRIES,
    HUB_ID,
    RARE_PROVIDER,
    STEM_ID,
    ScaleLibrary,
    build_scale_library,
    database_bytes,
    remove_database,
)

LIBRARY_PREFIX = "/api/library"
LINEAGE_PREFIX = "/api/lineage-scale"
ASSETS_PREFIX = "/api/assets"
PREFIXES = (LIBRARY_PREFIX, LINEAGE_PREFIX, ASSETS_PREFIX)

#: No whole-library response may exceed this. The LEARN crash was a 128 MB
#: body; 2 MB is already far more than any single view can draw.
SIZE_BUDGET_BYTES = 2 * 1024 * 1024

#: Wall time per route. Deliberately loose -- this is a smoke ceiling for a
#: route that has gone quadratic, not a benchmark. The real guarantee is the
#: trace test below, which does not depend on how fast this machine is.
#: A route that has gone quadratic on this fixture takes tens of seconds, so
#: 5 s costs the ceiling no teeth and leaves room for a 2-vCPU CI runner,
#: where ``/_graph/all`` (886 ms here) and a cold ``/rankings`` are the slow
#: pair. ``THEDAW_SCALE_TIME_BUDGET`` raises it on a machine that needs more.
TIME_BUDGET_SECONDS = float(os.environ.get("THEDAW_SCALE_TIME_BUDGET", "5.0"))

#: The ONLY routes allowed past :data:`SIZE_BUDGET_BYTES`, each with the
#: reason it is allowed. Every one is documented, every one is deliberate,
#: and nothing else may join without a line here.
SIZE_ALLOWLIST: dict[str, str] = {
    f"{LIBRARY_PREFIX}/_graph/all": (
        "the pre-LEARN whole-library graph: one node per entry by design, "
        "which is exactly the shape that crashed the browser at 194,508 -- "
        "pinned by its own test below rather than capped here"
    ),
    f"{LIBRARY_PREFIX}/entries/ids": (
        "a bare id list the client needs in full for select-all; 20,000 ids "
        "at ~14 bytes is ~0.3 MB, and it carries no per-entry payload that "
        "could grow"
    ),
    f"{LIBRARY_PREFIX}/{{entry_id}}/bundle": (
        "a zip of one entry AND the vendored Unity package: its size is a "
        "function of what is checked into this repository, not of how big "
        "the library is, so holding it to the library budget would measure "
        "the wrong thing -- the allowlist ceiling still holds it to a size"
    ),
}

#: A ceiling for the two allowlisted routes anyway, so 'unbounded' still
#: cannot mean 'unbounded'. Sized off this fixture, which is a tenth of the
#: real library.
ALLOWLIST_SIZE_CEILING_BYTES = 64 * 1024 * 1024

#: Columns that hold a blob a query must never open. ``metadata_json`` is the
#: one that cost 13.3 s; the rest are the same mistake waiting on the
#: analysis tables.
BLOB_COLUMNS = (
    "metadata_json",
    "raw_json",
    "embedded_tags_json",
    "beats_json",
    "semantic_tags_json",
)

#: The routes rule 3 covers: everything whose cost must be independent of how
#: fat a row is.
LIST_ROUTE_PATHS = (
    f"{LIBRARY_PREFIX}/entries?limit=50",
    f"{LIBRARY_PREFIX}/entries?limit=50&provider={RARE_PROVIDER}",
    f"{LIBRARY_PREFIX}/entries?limit=50&sort=plays_desc",
    f"{LIBRARY_PREFIX}/entries?limit=50&favorite=true",
    f"{LIBRARY_PREFIX}/entries/ids",
    f"{LIBRARY_PREFIX}/entries/facets?fields=model,provider,source,kind",
    f"{LIBRARY_PREFIX}/entries/facets?fields=provider&provider={RARE_PROVIDER}",
    f"{LINEAGE_PREFIX}/summary",
    f"{LINEAGE_PREFIX}/rankings",
    f"{LINEAGE_PREFIX}/{HUB_ID}/neighbourhood",
    f"{LINEAGE_PREFIX}/{HUB_ID}/relatives?direction=down",
)


def _normalise(statement: str) -> str:
    return " ".join(statement.lower().split())


def _is_paged_list_row_read(statement: str) -> bool:
    """The paged list's OWN row read: the page's ~50 rows, and only those.

    ``LibraryDB`` projects chosen metadata keys (lyrics, and friends) for the
    ids already on the page with ``json_extract(metadata_json, ?) AS j<n>``.
    That is bounded by the page size, not by the table, which is the whole
    distinction this exception draws.
    """
    return "json_extract(metadata_json" in statement and " as j" in statement


def _is_single_entry_read(statement: str) -> bool:
    """The single-entry GET: one row, by id, blob and all.

    ``GET /entries/{id}`` exists to return an entry's metadata. Reading one
    row's blob is the request, not a leak.
    """
    return "from entries" in statement and "where id =" in statement


#: ``SELECT *`` or ``SELECT <alias>.*``. ``count(*)`` and a named column
#: list both fail to match, which is the point.
_ENTRIES_STAR_RE = re.compile(r"select\s+(?:[a-z_][a-z_0-9]*\.)?\*")


def _selects_every_entries_column(statement: str) -> bool:
    """A statement that reads every column of ``entries`` without saying so.

    ``LibraryDB.list_entries`` (``SELECT * FROM entries ORDER BY created_at
    DESC``), ``list_entries_filtered`` and ``list_entries_page`` (``SELECT
    e.* FROM entries e``) all carry ``metadata_json`` back for every row they
    touch, and none of them names it -- so a rule matching column names alone
    cannot see them, and a facet or a count quietly routed through
    ``list_entries()`` would read 20,000 blobs and pass.
    """
    return "from entries" in statement and bool(_ENTRIES_STAR_RE.search(statement))


def _is_paged_star_row_read(statement: str) -> bool:
    """The paged list's whole-row read, bounded by its own ``LIMIT``.

    ``list_entries_page`` is ``SELECT e.* ... LIMIT ? OFFSET ?``: whole rows,
    blob and all, for the page's ~50 ids. The ``LIMIT`` is the entire reason
    it is allowed, so this exception requires one -- ``list_entries()``'s
    unbounded ``SELECT * FROM entries`` carries none and stays an offender.
    """
    return _selects_every_entries_column(statement) and "limit" in statement


#: The exception set, explicit and closed. Anything else that opens a blob
#: inside a list route is a regression.
_BLOB_READ_EXCEPTIONS = (
    ("the paged list's own row read", _is_paged_list_row_read),
    ("the single-entry GET", _is_single_entry_read),
    ("the paged list's bounded whole-row read", _is_paged_star_row_read),
)


def _blob_offenders(statements: list[str]) -> list[str]:
    """Statements that open a blob and are not one of the exceptions.

    "Open a blob" is either naming one of :data:`BLOB_COLUMNS` or selecting
    every column of ``entries``, which reads ``metadata_json`` without ever
    naming it.
    """
    offenders: list[str] = []
    for statement in statements:
        lowered = _normalise(statement)
        opens_blob = any(
            column in lowered for column in BLOB_COLUMNS
        ) or _selects_every_entries_column(lowered)
        if not opens_blob:
            continue
        if any(matches(lowered) for _, matches in _BLOB_READ_EXCEPTIONS):
            continue
        offenders.append(lowered[:400])
    return offenders


#: The two whole-table passes ``_StatsCache.get`` runs, verbatim as the trace
#: callback sees them once normalised. That cache is a module singleton, so a
#: warm slot skips both passes -- and a trace test that only checks "no blob
#: column" then passes having exercised nothing at all. The trace test
#: asserts both of these appeared.
LINEAGE_STATS_STREAMS = (
    "select from_id, to_id, kind from relations",
    "select id, created_at from entries",
)


# ---------------------------------------------------------------------------
# The app, and the routes enumerated out of it
# ---------------------------------------------------------------------------


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(library_router_module.router, prefix=LIBRARY_PREFIX)
    app.include_router(lineagescale_router_module.router, prefix=LINEAGE_PREFIX)
    app.include_router(assets_router_module.router, prefix=ASSETS_PREFIX)
    return app


def _walk_get_paths(routes: Any, prefix: str) -> Iterator[str]:
    """Every GET path under ``routes``, following FastAPI's lazy includes.

    A modern ``include_router`` leaves ONE wrapper object in ``app.routes``
    holding the original router, not the expanded routes, so a walk that only
    reads ``route.path`` finds four ``/docs`` entries and nothing else.
    """
    for route in routes:
        included = getattr(route, "original_router", None)
        if included is not None:
            context = getattr(route, "include_context", None)
            inner_prefix = prefix + (getattr(context, "prefix", "") or "")
            yield from _walk_get_paths(included.routes, inner_prefix)
            continue
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", None) or frozenset()
        if path and "GET" in methods:
            yield prefix + path


def _get_route_templates() -> tuple[str, ...]:
    paths = set(_walk_get_paths(_build_app().routes, ""))
    return tuple(sorted(p for p in paths if p.startswith(PREFIXES)))


#: Path parameters, resolved to ids the fixture actually has. ``entry_id``
#: gets two -- an ordinary song and the hub -- because a fan of hundreds is
#: the shape a per-song route can go quadratic on. The rest are ids no
#: library has, so those routes answer 404, which is a perfectly good
#: sub-500 answer and still prices the lookup.
_PARAM_VALUES: dict[str, tuple[str, ...]] = {
    "entry_id": (COMMON_ID, HUB_ID),
    "stem_id": (STEM_ID,),
    "job_id": ("scale-no-such-import-job",),
    "asset_id": ("scale-no-such-asset",),
}


#: Query strings the enumerated probe sends, and the only one there is.
#: ``GET /entries`` with no parameters at all is documented in the router as
#: the pre-paging shape: every entry of the kind, for callers older than
#: paging. Probing it bare would measure that legacy dump instead of the
#: paged list every current client asks for -- so the dump gets pinned by its
#: own test (``test_the_unpaged_entries_list_is_not_a_full_dump``) and the
#: enumerated probe asks the way the app asks.
#: ``/entries/facets`` is the other one: ``fields`` is required, so a bare
#: probe is a 422 that measures the validator instead of the four
#: whole-library GROUP BYs this route is the reason to be afraid of.
_QUERY_DEFAULTS: dict[str, str] = {
    f"{LIBRARY_PREFIX}/entries": "limit=200",
    f"{LIBRARY_PREFIX}/entries/facets": "fields=model,provider,source,kind",
}


def _fill(template: str) -> list[str]:
    """Every concrete path ``template`` stands for, or [] if it needs an id
    this module has no value for -- which fails ``test_every_get_route_has_an
    _id_to_probe_with`` rather than skipping quietly."""
    filled = [template]
    for name, values in _PARAM_VALUES.items():
        token = "{" + name + "}"
        if not any(token in path for path in filled):
            continue
        filled = [path.replace(token, value) for path in filled for value in values]
    if "{" in "".join(filled):
        return []
    query = _QUERY_DEFAULTS.get(template)
    if query:
        filled = [f"{path}?{query}" for path in filled]
    return filled


ROUTE_TEMPLATES = _get_route_templates()
ROUTE_CASES = tuple(
    (template, path) for template in ROUTE_TEMPLATES for path in _fill(template)
)

#: Filled in by the budget test, printed by the report at the end. A plain
#: dict, because the tests run in file order in one process.
_MEASURED: dict[str, tuple[float, int, int]] = {}

#: The library revision as it stood before the first probe, recorded by the
#: client fixture so ``test_the_read_probes_did_not_write`` can prove that no
#: GET in the sweep committed anything.
_REVISION_AT_START: list[int] = []


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def scale_library(tmp_path_factory: pytest.TempPathFactory) -> Iterator[ScaleLibrary]:
    """The 20,000-entry library, built once for the whole module.

    The build is inside the ``try``: it opens a ~400 MB database well before
    it has finished filling it, so a raise past that point must still close
    the handle and delete the file. The 20,000-directory disk tree goes in
    the same ``finally`` -- ``remove_database`` only ever knew about the
    database -- rather than waiting for whoever clears the basetemp.
    """
    root = tmp_path_factory.mktemp("library-at-scale")
    built: ScaleLibrary | None = None
    try:
        built = build_scale_library(root)
        yield built
    finally:
        if built is not None:
            built.close()
            remove_database(built.db_path)
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture(scope="module")
def client(scale_library: ScaleLibrary) -> Iterator[TestClient]:
    """The real routers, over the fixture's root.

    One warm-up request before anything is measured: the first request builds
    the store, which opens the database and may backfill an index. That cost
    is real but it is a cold-start cost, and charging it to whichever route
    happens to be alphabetically first would make the budgets meaningless.
    """
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("theDAW_GENERATIONS_DIR", str(scale_library.root))
        patch.setattr(library_router_module, "_store", None)
        with TestClient(_build_app()) as test_client:
            test_client.get(f"{LIBRARY_PREFIX}/summary")
            _REVISION_AT_START.append(
                library_router_module.get_store().db.library_revision()
            )
            try:
                yield test_client
            finally:
                store = library_router_module._store
                database = getattr(store, "db", None)
                if database is not None:
                    database.close()
                library_router_module._store = None


@pytest.fixture(autouse=True)
def _clear_lineage_stats_cache() -> Iterator[None]:
    """The lineage stats cache is module-level on purpose: the whole point of
    it is that the second request does not repeat the first one's two
    whole-table passes. Which means no test here may inherit another's
    answer -- the parametrised sweep asks ``/summary`` and ``/rankings`` long
    before the trace test runs. Mirrors ``tests/test_lineagescale.py``'s
    ``_clear_stats_cache``."""
    lineagescale_router_module._stats_cache.clear()
    yield
    lineagescale_router_module._stats_cache.clear()


@contextmanager
def _traced(store_db: Any) -> Iterator[list[str]]:
    """Every statement every connection involved issues.

    The lineage-scale routes open their OWN read-only connection, so watching
    only the store's would watch an empty room -- the same reason
    ``tests/test_lineagescale.py`` patches ``sqlite3.connect``.

    The lineage stats cache is cleared on the way in as well as by the
    autouse fixture, so a route probed EARLIER IN THE SAME TEST cannot warm
    it either. Without this the trace saw a cache hit -- a signature query
    and a few bounded reads -- and the strongest test in this module was
    proving nothing whatever about ``/summary`` or ``/rankings``.
    """
    lineagescale_router_module._stats_cache.clear()
    statements: list[str] = []
    opened: list[sqlite3.Connection] = []
    real_connect = sqlite3.connect

    def traced_connect(*args: Any, **kwargs: Any) -> sqlite3.Connection:
        conn = real_connect(*args, **kwargs)
        conn.set_trace_callback(statements.append)
        opened.append(conn)
        return conn

    shared = store_db._conn  # noqa: SLF001 - the store's own connection
    shared.set_trace_callback(statements.append)
    sqlite3.connect = traced_connect  # type: ignore[assignment]
    try:
        yield statements
    finally:
        sqlite3.connect = real_connect  # type: ignore[assignment]
        shared.set_trace_callback(None)
        # A connection opened under the patch keeps appending to this list
        # for as long as it lives, which would leak one test's
        # instrumentation into the next one's trace.
        for conn in opened:
            try:
                conn.set_trace_callback(None)
            except sqlite3.ProgrammingError:
                pass  # closed already by whoever opened it


# ---------------------------------------------------------------------------
# 1 + 2: every GET answers, and nothing grows with the library
# ---------------------------------------------------------------------------


def test_the_fixture_is_actually_heavy(scale_library: ScaleLibrary) -> None:
    """A guard on a thin fixture guards nothing.

    This is the assertion the two shipped regressions needed: if the blob
    weight ever drops back to a couple of bytes a row, every budget below
    passes for the wrong reason.
    """
    assert scale_library.entries == ENTRIES
    assert scale_library.relations > 45_000
    assert scale_library.blob_bytes / scale_library.entries > 7_000
    assert scale_library.stems > 0
    assert scale_library.midis > 0


def test_every_get_route_has_an_id_to_probe_with() -> None:
    """Enumeration is the point: a route added with a new path parameter must
    fail here, not vanish from the guard."""
    assert ROUTE_TEMPLATES, "no GET routes were enumerated from app.routes"
    unprobed = [t for t in ROUTE_TEMPLATES if not _fill(t)]
    assert not unprobed, f"no id value for {unprobed}; add one to _PARAM_VALUES"


@pytest.mark.parametrize(
    ("template", "path"), ROUTE_CASES, ids=[path for _, path in ROUTE_CASES]
)
def test_every_get_route_answers_within_budget(
    client: TestClient, template: str, path: str
) -> None:
    started = time.perf_counter()
    response = client.get(path)
    elapsed = time.perf_counter() - started
    size = len(response.content)
    _MEASURED[path] = (elapsed, size, response.status_code)

    assert response.status_code < 500, response.text[:400]
    if template in SIZE_ALLOWLIST:
        assert size < ALLOWLIST_SIZE_CEILING_BYTES, (
            f"{template} is allowlisted for {SIZE_ALLOWLIST[template]}, "
            f"but {size} bytes is past even the allowlist ceiling"
        )
    else:
        assert size <= SIZE_BUDGET_BYTES, (
            f"{path} returned {size} bytes for {ENTRIES} entries. Either it "
            "grows with the library -- the LEARN crash -- or it belongs in "
            "SIZE_ALLOWLIST with a reason."
        )
    assert elapsed < TIME_BUDGET_SECONDS, f"{path} took {elapsed:.3f}s"


def test_the_read_probes_did_not_write(client: TestClient) -> None:
    """Every route the sweep probes is a GET, and a GET must not commit.

    Two of them do work that is not a library read: ``/{entry_id}/bundle``
    runs a notation recovery/register step on its way to zipping, and
    ``/audio/{entry_id}/cover`` can write a poster it had to derive. Whether
    either actually commits against this fixture is not something a reader
    should have to take on trust, so the counter that ``LibraryDB._txn``
    bumps once per committed write is compared across the whole sweep. It
    also means the budgets above all measured the same library.
    """
    assert _REVISION_AT_START, "the client fixture never recorded a revision"
    store = library_router_module.get_store()
    assert store.db.library_revision() == _REVISION_AT_START[0], (
        "a GET committed a write during the probe sweep. A read probe must "
        "not: it makes the sweep order matter, and it means one of these "
        "routes is doing repair work on a page load."
    )


# ---------------------------------------------------------------------------
# The whole-library graph, held to the shape we want
# ---------------------------------------------------------------------------


@pytest.mark.xfail(
    strict=True,
    reason=(
        "``/_graph/all`` is the route that crashed LEARN, and it is "
        "unchanged. The fix shipped a new surface (``/api/lineage-scale``) "
        "next to it rather than capping this one, so this asserts the shape "
        "we WANT -- fewer nodes than the library has entries -- under a "
        "strict xfail. The day a cap or a page lands it xpasses: good news, "
        "remove the marker and drop the SIZE_ALLOWLIST entry. Until then it "
        "is a documented known-bad, not a red build somebody has to edit."
    ),
)
def test_the_whole_library_graph_is_bounded(client: TestClient) -> None:
    """One node per entry is what it does today; this is the desired shape."""
    response = client.get(f"{LIBRARY_PREFIX}/_graph/all")
    assert response.status_code < 500
    body = response.json()
    nodes = body.get("nodes")
    assert isinstance(nodes, list)
    _MEASURED["_graph/all::nodes"] = (0.0, len(nodes), response.status_code)
    assert len(nodes) < ENTRIES


# ---------------------------------------------------------------------------
# 3: the machine-independent guarantee
# ---------------------------------------------------------------------------


def test_the_blob_rule_flags_a_blob_read_and_spares_the_exceptions() -> None:
    """The guard's own guard: :func:`_blob_offenders` over hand-written SQL.

    Every other test here needs a 400 MB fixture to say anything, so the rule
    itself was only ever exercised by planting a regression in the backend by
    hand. These are the statements that matter, written out: the 13.3 s
    provider filter, ``list_entries``'s unbounded ``SELECT *``, an unbounded
    ``SELECT e.*``, and each of the three exceptions.
    """
    offending = [
        "SELECT id, json_extract(e.metadata_json, '$.provider') AS provider "
        "FROM entries e ORDER BY e.created_at DESC",
        "SELECT * FROM entries ORDER BY created_at DESC",
        "SELECT e.* FROM entries e WHERE e.source = ? ORDER BY e.created_at DESC",
    ]
    allowed = [
        # the paged list's projection: bounded by the ids on the page
        "SELECT id, title, CASE WHEN json_valid(metadata_json) THEN "
        "json_extract(metadata_json, ?) END AS j0 FROM entries "
        "WHERE id IN (?, ?)",
        # the single-entry GET
        "SELECT * FROM entries WHERE id = ?",
        # the paged list's own whole-row read
        "SELECT e.* FROM entries e ORDER BY e.created_at DESC LIMIT 50 OFFSET 0",
        # neither names nor selects a blob
        "SELECT COUNT(*) FROM entries",
        "SELECT id, created_at FROM entries",
        "SELECT provider, COUNT(*) FROM entries GROUP BY provider",
    ]
    assert _blob_offenders(offending) == [_normalise(s) for s in offending]
    assert _blob_offenders(allowed) == []


def test_the_list_routes_never_open_a_blob_column(
    client: TestClient, scale_library: ScaleLibrary
) -> None:
    """The invariant behind the 13.3 s page, as SQL rather than a stopwatch.

    Every route here answers about the whole table, so any statement naming a
    blob column reads every row's blob. The exception set is closed and
    documented: the page's own bounded row read, and the single-entry GET.
    """
    store = library_router_module.get_store()
    with _traced(store.db) as statements:
        for path in LIST_ROUTE_PATHS:
            # 200, not "under 500": a route that rejected the probe as a 422
            # runs no SQL at all, and an empty trace proves nothing.
            assert client.get(path).status_code == 200, path

    assert statements, "the trace callback saw nothing, so it proved nothing"
    normalised = [_normalise(s) for s in statements]
    assert any("from entries" in s for s in normalised), (
        "no statement touched the entries table; the routes cannot have run"
    )
    # The lineage routes are the ones a warm cache can hide: with the stats
    # slot already filled they answer from memory, run a signature query and
    # a few bounded entry reads, and a "no blob column" assertion passes
    # having priced nothing. Both whole-table passes must appear.
    for stream in LINEAGE_STATS_STREAMS:
        assert any(stream in s for s in normalised), (
            f"the lineage stats pass never ran: no statement was {stream!r}. "
            "That cache is a module singleton and the sweep above warms it, "
            "so a trace without this proves nothing about /summary or "
            "/rankings -- clear _stats_cache before tracing."
        )
    offenders = _blob_offenders(statements)
    assert not offenders, (
        "a whole-library query opened a blob column, which on the real "
        f"library means reading ~6.6 GB: {offenders[:5]}"
    )


def test_the_single_entry_get_reads_at_most_its_own_row(
    client: TestClient,
) -> None:
    """The one route the blob rule cannot apply to, held to the weaker one.

    ``GET /entries/{id}`` exists to return an entry's metadata, so it is in
    the exception set. Measured on this build it does not use the exception
    at all -- the record is assembled from ``<root>/<id>/metadata.json`` and
    its SQL names no blob column -- but the exception stays, because reading
    ONE row's blob here would be the request rather than a leak. What it may
    never do is open the column across rows, and that is what this asserts.
    """
    store = library_router_module.get_store()
    with _traced(store.db) as statements:
        assert client.get(f"{LIBRARY_PREFIX}/entries/{COMMON_ID}").status_code == 200

    assert statements, "the trace callback saw nothing, so it proved nothing"
    blob_reads = [
        _normalise(s)
        for s in statements
        if any(column in _normalise(s) for column in BLOB_COLUMNS)
    ]
    assert all(_is_single_entry_read(s) for s in blob_reads), [
        s[:200] for s in blob_reads
    ]


@pytest.mark.xfail(
    strict=True,
    reason=(
        "``GET /entries`` with no parameters returns the whole kind, as "
        "designed. The router documents this on purpose: it is byte-for-byte "
        "the endpoint that predates paging, for callers that predate paging. "
        "It is also the third response on this surface whose size is the "
        "library's size -- 21 MB at 20,000 entries, so ~200 MB at the real "
        "194,508. Changing the default is a product decision, not a test's, "
        "so the shape we WANT is what is asserted, under a strict xfail: if "
        "a cap or a default limit ever lands this xpasses and says so, "
        "rather than failing a build for having got better."
    ),
)
def test_the_unpaged_entries_list_is_not_a_full_dump(
    client: TestClient, scale_library: ScaleLibrary
) -> None:
    """The desired shape: the bare list fits inside the size budget."""
    response = client.get(f"{LIBRARY_PREFIX}/entries")
    assert response.status_code == 200
    size = len(response.content)
    body = response.json()
    _MEASURED["/api/library/entries (no params, legacy dump)"] = (
        0.0,
        size,
        response.status_code,
    )
    assert body["count"] > scale_library.entries * 0.9
    assert len(body["entries"]) == body["count"]
    assert size <= SIZE_BUDGET_BYTES


def test_a_provider_filtered_page_costs_what_an_unfiltered_one_costs(
    client: TestClient,
) -> None:
    """The regression in its own terms: the filter that took 13.3 s.

    A ratio, not an absolute, so the assertion means the same thing on a
    laptop and on CI. The old rule was ~130x.

    Best of three each, not one sample apiece: a ratio between two single
    timings is at the mercy of whatever else the runner was doing during one
    of them, and the fastest run of three is the one least polluted by it.
    A route reading 20,000 blobs has no fast run.
    """
    plain = f"{LIBRARY_PREFIX}/entries?limit=200"
    filtered = f"{LIBRARY_PREFIX}/entries?limit=200&provider={RARE_PROVIDER}"

    def fastest_of_three(path: str) -> float:
        best = float("inf")
        for _ in range(3):
            started = time.perf_counter()
            assert client.get(path).status_code == 200, path
            best = min(best, time.perf_counter() - started)
        return best

    client.get(plain)
    client.get(filtered)
    plain_seconds = fastest_of_three(plain)
    filtered_seconds = fastest_of_three(filtered)

    budget = max(plain_seconds * 12.0, 0.4)
    assert filtered_seconds < budget, (
        f"a provider-filtered page took {filtered_seconds:.3f}s against "
        f"{plain_seconds:.3f}s unfiltered; the filter is reading blobs again"
    )


# ---------------------------------------------------------------------------
# What it measured
# ---------------------------------------------------------------------------


def test_zz_report(scale_library: ScaleLibrary) -> None:
    """Not an assertion -- the numbers, so a CI log says what it priced.

    Named to sort last. ``-s`` shows it; without ``-s`` it is silent and
    costs nothing.
    """
    print(
        f"\nfixture: {scale_library.entries} entries, "
        f"{scale_library.relations} relations, "
        f"{scale_library.blob_bytes / 1e6:.1f} MB of metadata_json, "
        f"db {database_bytes(Path(scale_library.db_path)) / 1e6:.1f} MB, "
        f"built in {scale_library.build_seconds:.1f}s"
    )
    for path, (elapsed, size, status) in sorted(_MEASURED.items()):
        print(f"  {elapsed * 1000:8.1f} ms  {size:>10} B  {status}  {path}")
