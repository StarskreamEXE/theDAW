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
   budget has exactly two exceptions, each named in :data:`SIZE_ALLOWLIST`
   with its reason. A third response does grow with the library -- ``GET
   /entries`` with no parameters, the documented pre-paging shape -- and is
   pinned as it is by its own test rather than allowlisted away.
3. **The invariant, not the stopwatch.** A machine's speed is not a
   guarantee; a trace callback is. The paged list, its count, the id list,
   the facets and every lineage-scale route must not execute a single
   statement that names a blob column, with exactly two documented
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
TIME_BUDGET_SECONDS = 1.5

#: The ONLY routes allowed past :data:`SIZE_BUDGET_BYTES`, each with the
#: reason it is allowed. Both are documented, both are deliberate, and
#: nothing else may join without a line here.
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


#: The exception set, explicit and closed. Anything else that names a blob
#: column inside a list route is a regression.
_BLOB_READ_EXCEPTIONS = (
    ("the paged list's own row read", _is_paged_list_row_read),
    ("the single-entry GET", _is_single_entry_read),
)


def _blob_offenders(statements: list[str]) -> list[str]:
    """Statements that open a blob column and are not one of the exceptions."""
    offenders: list[str] = []
    for statement in statements:
        lowered = _normalise(statement)
        if not any(column in lowered for column in BLOB_COLUMNS):
            continue
        if any(matches(lowered) for _, matches in _BLOB_READ_EXCEPTIONS):
            continue
        offenders.append(lowered[:400])
    return offenders


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
#: own test (``test_the_unpaged_entries_list_is_still_a_full_dump``) and the
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


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def scale_library(tmp_path_factory: pytest.TempPathFactory) -> Iterator[ScaleLibrary]:
    """The 20,000-entry library, built once for the whole module."""
    root = tmp_path_factory.mktemp("library-at-scale")
    built = build_scale_library(root)
    try:
        yield built
    finally:
        built.close()
        remove_database(built.db_path)


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
            try:
                yield test_client
            finally:
                store = library_router_module._store
                database = getattr(store, "db", None)
                if database is not None:
                    database.close()
                library_router_module._store = None


@contextmanager
def _traced(store_db: Any) -> Iterator[list[str]]:
    """Every statement every connection involved issues.

    The lineage-scale routes open their OWN read-only connection, so watching
    only the store's would watch an empty room -- the same reason
    ``tests/test_lineagescale.py`` patches ``sqlite3.connect``.
    """
    statements: list[str] = []
    real_connect = sqlite3.connect

    def traced_connect(*args: Any, **kwargs: Any) -> sqlite3.Connection:
        conn = real_connect(*args, **kwargs)
        conn.set_trace_callback(statements.append)
        return conn

    shared = store_db._conn  # noqa: SLF001 - the store's own connection
    shared.set_trace_callback(statements.append)
    sqlite3.connect = traced_connect  # type: ignore[assignment]
    try:
        yield statements
    finally:
        sqlite3.connect = real_connect  # type: ignore[assignment]
        shared.set_trace_callback(None)


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


# ---------------------------------------------------------------------------
# The whole-library graph, pinned as it is
# ---------------------------------------------------------------------------


def test_the_whole_library_graph_is_still_unbounded(client: TestClient) -> None:
    """``/_graph/all`` is the route that crashed LEARN, and it is unchanged.

    The fix shipped a new surface (``/api/lineage-scale``) next to it rather
    than capping this one, so the honest thing for a guard to do is pin what
    this route DOES: one node per entry, and a body that scales with the
    library. If it ever grows a cap, this test fails and the allowlist entry
    above comes out with it.
    """
    response = client.get(f"{LIBRARY_PREFIX}/_graph/all")
    assert response.status_code < 500
    body = response.json()
    nodes = body.get("nodes")
    assert isinstance(nodes, list)
    _MEASURED["_graph/all::nodes"] = (0.0, len(nodes), response.status_code)
    assert len(nodes) >= ENTRIES, (
        f"/_graph/all returned {len(nodes)} nodes for {ENTRIES} entries. If a "
        "cap or a page was added, that is good news -- update this test and "
        "drop the SIZE_ALLOWLIST entry."
    )


# ---------------------------------------------------------------------------
# 3: the machine-independent guarantee
# ---------------------------------------------------------------------------


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
    assert any("from entries" in _normalise(s) for s in statements), (
        "no statement touched the entries table; the routes cannot have run"
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


def test_the_unpaged_entries_list_is_still_a_full_dump(
    client: TestClient, scale_library: ScaleLibrary
) -> None:
    """``GET /entries`` with no parameters returns the whole kind, as designed.

    The router documents this on purpose: it is byte-for-byte the endpoint
    that predates paging, for callers that predate paging. It is also the
    third response on this surface whose size is the library's size -- 21 MB
    at 20,000 entries, so ~200 MB at the real 194,508. Pinned, not fixed:
    changing the default is a product decision, not a test's. If a cap or a
    default limit ever lands, this test fails and says so.
    """
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
    assert size > SIZE_BUDGET_BYTES, (
        "the unpaged list is no longer a full dump -- good news; update this "
        "test, and consider whether the paged probe still needs its "
        "_QUERY_DEFAULTS entry"
    )


def test_a_provider_filtered_page_costs_what_an_unfiltered_one_costs(
    client: TestClient,
) -> None:
    """The regression in its own terms: the filter that took 13.3 s.

    A ratio, not an absolute, so the assertion means the same thing on a
    laptop and on CI. The old rule was ~130x.
    """
    plain = f"{LIBRARY_PREFIX}/entries?limit=200"
    filtered = f"{LIBRARY_PREFIX}/entries?limit=200&provider={RARE_PROVIDER}"
    client.get(plain)
    client.get(filtered)

    started = time.perf_counter()
    assert client.get(plain).status_code == 200
    plain_seconds = time.perf_counter() - started

    started = time.perf_counter()
    assert client.get(filtered).status_code == 200
    filtered_seconds = time.perf_counter() - started

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
