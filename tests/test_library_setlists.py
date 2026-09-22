"""``GET /api/library/setlists`` lists bundled sets; it does not write.

The route scans ``<data>/performance-sets/<Set>/performance.json`` for the DJ
tab, and it used to *register* every audio file it found as a library entry on
the way -- ``store.register_reference`` per track, one committed write each,
plus a sidecar file rewritten in the user's own folder -- on a GET the frontend
fires on startup. ``tests/test_library_api_at_scale.py`` caught it: the read
sweep moved ``library_revision`` 11 -> 36.

Listing and registering are now two routes. The GET reports whatever the
sidecar already knows (``entryId: null`` for a file that has never been
registered -- a shape the frontend's ``SetlistEntry`` already allows), and
``POST /setlists/{set_id}/register`` -- the open action -- does the writing.
The set id is a hash of the *timeline* (file names, labels, cue points), not of
the entry ids, so it survives registration and the frontend keeps merging by
id.

Every path here is under ``tmp_path``: no test reads the developer's own
``data/performance-sets``.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router as library_router_module

PREFIX = "/api/library"
SIDECAR = ".thedaw-import.json"


def _write_set(root: Path, name: str, tracks: int = 2) -> Path:
    """One performance set on disk: N playable files plus the timeline."""
    set_dir = root / name
    set_dir.mkdir(parents=True)
    spec: list[dict[str, Any]] = []
    for index in range(tracks):
        fname = f"track{index}.wav"
        (set_dir / fname).write_bytes(b"RIFF\x00\x00\x00\x00WAVEdata")
        spec.append(
            {
                "file": fname,
                "title": f"Track {index}",
                "cue_in_s": float(index),
                "mix_out_s": 30.0 + index,
            }
        )
    (set_dir / "performance.json").write_text(
        json.dumps({"name": name, "tracks": spec}), encoding="utf-8"
    )
    return set_dir


@pytest.fixture
def perf_sets(tmp_path: Path) -> Path:
    """``<data>/performance-sets``, redirected into the test's own tree."""
    root = tmp_path / "data" / "performance-sets"
    root.mkdir(parents=True)
    return root


@pytest.fixture
def client(tmp_path: Path, perf_sets: Path) -> Iterator[TestClient]:
    """The real library router over a throwaway data + library root."""
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
        patch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "library"))
        patch.setattr(library_router_module, "_store", None)
        app = FastAPI()
        app.include_router(library_router_module.router, prefix=PREFIX)
        with TestClient(app) as test_client:
            try:
                yield test_client
            finally:
                store = library_router_module._store
                database = getattr(store, "db", None)
                if database is not None:
                    database.close()
                library_router_module._store = None


def _revision() -> int:
    return library_router_module.get_store().db.library_revision()


def _get_setlists(client: TestClient) -> list[dict[str, Any]]:
    response = client.get(f"{PREFIX}/setlists")
    assert response.status_code == 200, response.text[:400]
    body = response.json()
    return sorted(body["setlists"], key=lambda item: item["name"])


def test_the_listing_lists_unregistered_sets_without_writing(
    client: TestClient, perf_sets: Path
) -> None:
    """The startup GET must be a read. Nothing committed, nothing on disk."""
    _write_set(perf_sets, "NIGHT RIDE", tracks=2)
    _write_set(perf_sets, "TEST SET", tracks=3)
    before = _revision()

    setlists = _get_setlists(client)

    assert [s["name"] for s in setlists] == ["NIGHT RIDE", "TEST SET"]
    assert [len(s["entries"]) for s in setlists] == [2, 3]
    assert all(entry["entryId"] is None for s in setlists for entry in s["entries"]), (
        "a set nobody has opened must list with no entry ids, not register itself"
    )
    # The shape the frontend reads is otherwise unchanged.
    first = setlists[0]["entries"][0]
    assert first["label"] == "Track 0"
    assert first["kind"] == "audio"
    assert first["perf"] == {"cueIn": 0.0, "mixOut": 30.0}
    assert setlists[0]["notes"] == "Imported performance set (Z-AutoDJ)"

    assert _revision() == before, "the setlists listing committed a write"
    assert not list(perf_sets.rglob(SIDECAR)), (
        "the listing rewrote a sidecar in the user's own set folder"
    )


def test_opening_a_set_registers_it_once_and_is_idempotent(
    client: TestClient, perf_sets: Path
) -> None:
    """The open action is where the writes belong -- and only the first time."""
    set_dir = _write_set(perf_sets, "NIGHT RIDE", tracks=2)
    listed = _get_setlists(client)[0]
    set_id = listed["id"]
    before = _revision()

    response = client.post(f"{PREFIX}/setlists/{set_id}/register")
    assert response.status_code == 200, response.text[:400]
    registered = response.json()["setlist"]

    assert registered["id"] == set_id, (
        "the id is hashed from the timeline, so registering must not rename "
        "the set out from under the frontend's merge-by-id"
    )
    entry_ids = [entry["entryId"] for entry in registered["entries"]]
    assert all(isinstance(value, str) and value for value in entry_ids)
    assert len(set(entry_ids)) == 2
    assert [entry["label"] for entry in registered["entries"]] == [
        "Track 0",
        "Track 1",
    ]
    assert _revision() > before, "the open action never registered anything"
    sidecar = json.loads((set_dir / SIDECAR).read_text(encoding="utf-8"))
    assert sidecar == {"track0.wav": entry_ids[0], "track1.wav": entry_ids[1]}

    after_first = _revision()
    again = client.post(f"{PREFIX}/setlists/{set_id}/register")
    assert again.status_code == 200, again.text[:400]
    assert [e["entryId"] for e in again.json()["setlist"]["entries"]] == entry_ids
    assert _revision() == after_first, (
        "opening the same set twice registered its tracks twice"
    )

    relisted = _get_setlists(client)[0]
    assert relisted["id"] == set_id
    assert [entry["entryId"] for entry in relisted["entries"]] == entry_ids
    assert _revision() == after_first, "the listing wrote after registration"


def test_registering_a_set_that_is_not_there_is_a_404(client: TestClient) -> None:
    response = client.post(f"{PREFIX}/setlists/zad-nope-00000000/register")
    assert response.status_code == 404


def test_two_clients_opening_the_same_set_register_each_file_once(
    client: TestClient, perf_sets: Path
) -> None:
    """Two tabs, one set, one entry per file.

    Both callers read the same empty sidecar, so without a claim on the file
    they each call ``register_reference`` and the library grows a second copy
    of every track -- invisible until the user sees each one twice. The route
    holds a per-folder lock, and the store refuses to register a
    ``source_path`` it already has, so the loser of the race reuses the
    winner's entries.
    """
    _write_set(perf_sets, "NIGHT RIDE", tracks=3)
    set_id = _get_setlists(client)[0]["id"]

    start = threading.Barrier(2)
    answers: list[Any] = []
    failures: list[BaseException] = []

    def register() -> None:
        try:
            start.wait(timeout=10)
            answers.append(client.post(f"{PREFIX}/setlists/{set_id}/register"))
        except BaseException as exc:  # noqa: BLE001 - re-raised below
            failures.append(exc)

    threads = [threading.Thread(target=register) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert not failures, failures
    assert [a.status_code for a in answers] == [200, 200]
    per_call = [
        [entry["entryId"] for entry in a.json()["setlist"]["entries"]] for a in answers
    ]
    assert per_call[0] == per_call[1], "the two callers registered different entries"
    assert len(set(per_call[0])) == 3

    listing = client.get(f"{PREFIX}/entries?limit=100")
    assert listing.status_code == 200, listing.text[:400]
    body = listing.json()
    assert body["total"] == 3, (
        f"{body['total']} entries for 3 files: the same file was registered twice"
    )
    store = library_router_module.get_store()
    assert len(store.db.registered_source_paths()) == 3


def test_the_register_route_refuses_a_cross_site_caller(
    client: TestClient, perf_sets: Path
) -> None:
    """It writes, so it carries the same guard as ``/import-folder``."""
    _write_set(perf_sets, "NIGHT RIDE", tracks=2)
    set_id = _get_setlists(client)[0]["id"]

    refused = client.post(
        f"{PREFIX}/setlists/{set_id}/register",
        headers={"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"},
    )

    assert refused.status_code == 403
    assert _revision() == _revision(), "sanity"
    assert not list(perf_sets.rglob(SIDECAR)), "a refused caller still registered"


def test_the_404_does_not_echo_the_id_back(client: TestClient) -> None:
    response = client.post(f"{PREFIX}/setlists/zad-%3Cscript%3E-1/register")
    assert response.status_code == 404
    assert "script" not in response.text
