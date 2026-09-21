"""Provider labeling wired through the store, the router, and the SQL filter.

``backend.modules.library.provider`` decides WHAT a track's provider is;
these tests cover the three places that answer is used:

* the import paths, which store the label and the curated embedded fields,
* the read path, which derives a label for entries that were imported long
  before this feature existed -- without opening a single audio file,
* the list filter, which has to match a newly labeled entry and a legacy
  Suno entry with the same ``provider=suno``.

Every fixture is synthetic: the ids, the handle and the model string below
are invented for this file and name nothing in anyone's library.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router as library_router_module
from backend.modules.library.db import EntryFilters
from backend.modules.library.store import LibraryStore

SUNO_ID = "11111111-2222-3333-4444-555555555555"
PARENT_ID = "99999999-8888-7777-6666-555555555555"
ZERO_ID = "00000000-0000-0000-0000-000000000000"
LEGACY_ID = "12121212-3434-5656-7878-909090909090"


def _tagged_mp3(
    path: Path,
    *,
    txxx: dict[str, str] | None = None,
    album: str = "",
    artist: str = "",
    encoder: str = "",
) -> bytes:
    """A file carrying only ID3 frames -- enough for the tag reader, and not
    a byte of audio. Mirrors the fixture style in ``test_library_tags.py``."""
    from mutagen.id3 import ID3, TALB, TPE1, TSSE, TXXX

    path.write_bytes(b"")
    tags = ID3()
    if album:
        tags.add(TALB(encoding=3, text=[album]))
    if artist:
        tags.add(TPE1(encoding=3, text=[artist]))
    if encoder:
        tags.add(TSSE(encoding=3, text=[encoder]))
    for desc, value in (txxx or {}).items():
        tags.add(TXXX(encoding=3, desc=desc, text=[value]))
    tags.save(str(path))
    return path.read_bytes()


def _suno_bytes(tmp_path: Path, name: str = "song.mp3", **overrides: str) -> bytes:
    """The three identifying frames a real Suno file carries, plus the
    curated ones and a few analytics frames that must never be ingested."""
    txxx = {
        "generator": "suno",
        "suno_id": SUNO_ID,
        "suno_prompt": "a chorus about the tide",
        "suno_style": "dark synthwave",
        "suno_negative_tags": "brass",
        "suno_model_name": "test-model-v1",
        "suno_model_version": "9.9",
        "suno_handle": "neutral-handle",
        "suno_parent_id": PARENT_ID,
        "suno_is_instrumental": "False",
        # Analytics: about how the song did, not about the song.
        "suno_play_count": "4321",
        "suno_upvote_count": "77",
        "suno_popularity_class": "top",
        "suno_skip_rate": "0.5",
    }
    txxx.update(overrides)
    return _tagged_mp3(
        tmp_path / name, txxx=txxx, album="Suno AI", artist="Test Artist"
    )


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
        "prompt": "",
        "model": "medium",
        "source": "generate",
        "duration": 1.0,
        "tags": [],
        "notes": "",
        "saved_at": 1700000000.0,
    }
    payload.update(meta)
    (entry_dir / "metadata.json").write_text(json.dumps(payload), encoding="utf-8")
    return entry_dir


def _read_meta(root: Path, entry_id: str) -> dict:
    return json.loads((root / entry_id / "metadata.json").read_text(encoding="utf-8"))


@pytest.fixture
def client_with_root(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app)


# ---- Import path -----------------------------------------------------------


def test_import_blob_labels_a_suno_file(tmp_path: Path):
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="song.mp3",
        mime_type="audio/mpeg",
    )

    assert record.provider == "suno"
    assert record.provider_label == "Suno"
    assert record.provider_is_ai is True
    assert record.provider_id == SUNO_ID
    # The import stays an import: `source` is untouched by labeling.
    assert record.source == "import"
    assert "suno" in record.tags


def test_import_blob_fills_gaps_from_the_curated_embedded_fields(tmp_path: Path):
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="song.mp3",
        mime_type="audio/mpeg",
    )

    assert record.prompt == "a chorus about the tide"
    assert record.negative_prompt == "brass"
    # The model name is passed through from the file, not the generator slug.
    assert record.model == "test-model-v1"
    # Suno's prompt frame holds the sung words, so a vocal track gets lyrics.
    assert record.lyrics == "a chorus about the tide"

    meta = _read_meta(store.root, record.id)
    assert meta["style"] == "dark synthwave"
    assert meta["model_version"] == "9.9"
    assert meta["artist"] == "Test Artist"
    assert meta["parent_id"] == PARENT_ID
    assert meta["is_instrumental"] is False
    assert meta["provider"] == "suno"
    assert meta["provider_label"] == "Suno"
    assert meta["provider_is_ai"] is True
    assert meta["provider_id"] == SUNO_ID


def test_import_blob_caller_metadata_still_wins(tmp_path: Path):
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="song.mp3",
        mime_type="audio/mpeg",
        metadata={
            "prompt": "caller prompt",
            "negative_prompt": "caller negative",
            "model": "caller model",
            "lyrics": "caller lyrics",
            "tags": ["mine"],
        },
    )

    assert record.prompt == "caller prompt"
    assert record.negative_prompt == "caller negative"
    assert record.model == "caller model"
    assert record.lyrics == "caller lyrics"
    # Labeling still happened; the provider tag joins the caller's tags once.
    assert record.provider == "suno"
    assert record.tags == ["mine", "suno"]


def test_import_blob_does_not_duplicate_an_existing_provider_tag(tmp_path: Path):
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="song.mp3",
        mime_type="audio/mpeg",
        metadata={"tags": ["Suno"]},
    )

    assert record.tags == ["Suno"]


def test_import_blob_never_ingests_analytics_or_a_zero_uuid(tmp_path: Path):
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_suno_bytes(tmp_path, suno_parent_id=ZERO_ID),
        filename="song.mp3",
        mime_type="audio/mpeg",
    )

    meta = _read_meta(store.root, record.id)
    # The all-zero parent uuid means "no parent", not a parent.
    assert "parent_id" not in meta
    # No analytics frame becomes a curated field of its own.
    for banned in (
        "play_count",
        "upvote_count",
        "popularity_class",
        "skip_rate",
    ):
        assert banned not in meta


def test_a_file_whose_only_tool_is_its_encoder_falls_back_to_the_derived_slug(
    tmp_path: Path,
):
    """An mp3 written by LAME or ffmpeg says nothing about where the music came
    from, so nothing is stored and nothing is tagged -- the entry keeps the
    slug the catalogue has always shown an import under."""
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_tagged_mp3(tmp_path / "plain.mp3", encoder="Lavf60.16.100"),
        filename="plain.mp3",
        mime_type="audio/mpeg",
    )

    assert record.provider == "import"
    assert record.provider_label == "Imported"
    assert record.provider_is_ai is False
    assert record.provider_id is None
    assert record.tags == []
    assert "provider" not in _read_meta(store.root, record.id)


def test_register_reference_labels_the_file_it_points_at(tmp_path: Path):
    source = tmp_path / "outside" / "song.mp3"
    source.parent.mkdir(parents=True, exist_ok=True)
    _suno_bytes(tmp_path / "outside", name="song.mp3")

    store = LibraryStore(tmp_path / "lib")
    record = store.register_reference(str(source), {"source": "folder"})

    assert record is not None
    assert record.provider == "suno"
    assert record.provider_id == SUNO_ID
    # A reference is still a reference: the audio was not copied in.
    assert _read_meta(store.root, record.id)["source_path"] == str(source.resolve())


def test_bulk_reference_import_opens_no_source_file(tmp_path: Path, monkeypatch):
    """The 200,000-file path must not gain a per-file tag read."""
    from backend.modules.library import tags as tags_module

    folder = tmp_path / "outside"
    folder.mkdir(parents=True, exist_ok=True)
    for index in range(3):
        _suno_bytes(folder, name=f"song{index}.mp3")

    store = LibraryStore(tmp_path / "lib")
    reads: list[str] = []
    real = tags_module.extract_embedded_tags
    monkeypatch.setattr(
        tags_module,
        "extract_embedded_tags",
        lambda path: (reads.append(str(path)), real(path))[1],
    )
    result = store.register_references_bulk(
        sorted(str(p) for p in folder.glob("*.mp3"))
    )

    assert len(result.created) == 3
    assert reads == []


# ---- Read path -------------------------------------------------------------


def test_read_time_derivation_from_stored_embedded_tags(client_with_root, tmp_path):
    """No provider in metadata, no audio read: the label comes from the tags
    the analysis pass already stored. This is how the existing library is
    labeled -- no backfill."""
    _seed_entry(tmp_path, "entry_derived", {"source": "import"})
    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis(
        "entry_derived",
        {"embedded_tags": {"generator": "suno", "txxx_suno_id": SUNO_ID}},
    )

    single = client_with_root.get("/api/library/entries/entry_derived").json()
    assert single["provider"] == "suno"
    assert single["provider_label"] == "Suno"
    assert single["provider_is_ai"] is True
    assert single["provider_id"] == SUNO_ID

    listed = client_with_root.get("/api/library/entries?limit=10").json()["entries"]
    assert [e["provider"] for e in listed] == ["suno"]


def test_legacy_suno_entry_is_labeled_without_an_analysis_row(
    client_with_root, tmp_path
):
    _seed_entry(tmp_path, "entry_legacy", {"source": "suno", "suno_id": LEGACY_ID})

    body = client_with_root.get("/api/library/entries/entry_legacy").json()
    assert body["provider"] == "suno"
    assert body["provider_label"] == "Suno"
    assert body["provider_id"] == LEGACY_ID


def test_an_entry_nothing_identifies_falls_back_to_the_derived_slug(
    client_with_root, tmp_path
):
    _seed_entry(tmp_path, "entry_plain", {"source": "generate", "model": "medium"})

    body = client_with_root.get("/api/library/entries/entry_plain").json()
    assert body["provider"] == "stable-audio"
    assert body["provider_label"] == "Stable Audio"
    assert body["provider_is_ai"] is True
    assert body["provider_id"] is None


def test_stored_label_wins_over_the_embedded_tags(client_with_root, tmp_path):
    _seed_entry(
        tmp_path,
        "entry_pinned",
        {
            "source": "import",
            "provider": "bandcamp",
            "provider_label": "Bandcamp",
            "provider_is_ai": False,
        },
    )
    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis("entry_pinned", {"embedded_tags": {"generator": "suno"}})

    body = client_with_root.get("/api/library/entries/entry_pinned").json()
    assert body["provider"] == "bandcamp"
    assert body["provider_is_ai"] is False


# ---- List filter -----------------------------------------------------------


@pytest.fixture
def mixed_library(tmp_path: Path) -> LibraryStore:
    """One entry per way a track can be (or fail to be) a Suno track."""
    root = tmp_path / "lib"
    # Seeded before the store opens, so the auto-reindex picks them up.
    root.mkdir(parents=True, exist_ok=True)
    _seed_entry(root, "legacy_source", {"source": "suno"})
    _seed_entry(root, "legacy_id", {"source": "import", "suno_id": LEGACY_ID})
    _seed_entry(root, "plain", {"source": "generate"})

    store = LibraryStore(root)
    store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="fresh.mp3",
        mime_type="audio/mpeg",
        metadata={"title": "fresh suno"},
    )
    store.import_blob(
        audio_bytes=_tagged_mp3(
            tmp_path / "udio.mp3", txxx={"generator": "udio", "udio_id": "u-0001"}
        ),
        filename="udio.mp3",
        mime_type="audio/mpeg",
        metadata={"title": "fresh udio"},
    )
    return store


def _ids(store: LibraryStore, **kwargs) -> set[str]:
    assert store.db is not None
    return set(store.db.list_entry_ids(EntryFilters(**kwargs), 100))


def _titles(store: LibraryStore, **kwargs) -> set[str]:
    assert store.db is not None
    return {
        str(row["title"])
        for row in store.db.list_entries_page(EntryFilters(**kwargs), limit=100)
    }


def test_provider_filter_matches_new_and_legacy_suno_entries(mixed_library):
    store = mixed_library
    matched = _titles(store, provider="suno")

    assert matched == {"fresh suno", "legacy_source", "legacy_id"}
    assert store.db is not None
    assert store.db.count_entries_filtered(EntryFilters(provider="suno")) == 3


def test_provider_filter_excludes_other_providers(mixed_library):
    store = mixed_library
    assert _titles(store, provider="udio") == {"fresh udio"}
    assert _titles(store, provider="bandcamp") == set()


def test_provider_filter_is_case_insensitive_about_the_slug(mixed_library):
    assert len(_ids(mixed_library, provider="SUNO")) == 3


def test_source_filter_is_unchanged_by_the_provider_filter(mixed_library):
    store = mixed_library
    # `source` still means the three-value column it always meant.
    assert _titles(store, source="generate") == {"plain"}
    assert _titles(store, source="import") == {
        "legacy_id",
        "fresh suno",
        "fresh udio",
    }
    assert _titles(store, source="suno") == {"legacy_source"}
    # Combining the two narrows to the intersection.
    assert _titles(store, source="import", provider="suno") == {
        "legacy_id",
        "fresh suno",
    }


def test_provider_filter_survives_the_user_deleting_the_provider_tag(
    tmp_path: Path,
):
    """The tag is a convenience; ``$.provider`` is the authority."""
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="song.mp3",
        mime_type="audio/mpeg",
    )
    store.update_entry(record.id, {"tags": []})

    assert _ids(store, provider="suno") == {record.id}


# ---- Python / SQL parity ---------------------------------------------------

#: One row per rule of the provider precedence, plus the two cases that decide
#: whether the two implementations really are the same rule: a stored label
#: (rule 1) whose model would otherwise say something else, and a model that
#: merely CONTAINS "suno", which the frontend's `includes('suno')` matches and
#: an equality test would not. ``(entry_id, model, source, extra, slug)``.
PARITY_ROWS: tuple[tuple[str, str, str, dict, str], ...] = (
    (
        "stored_label",
        "medium",
        "import",
        {
            "provider": "bandcamp",
            "provider_label": "Bandcamp",
            "provider_is_ai": False,
        },
        "bandcamp",
    ),
    ("legacy_source", "medium", "suno", {}, "suno"),
    ("legacy_suno_id", "medium", "import", {"suno_id": LEGACY_ID}, "suno"),
    ("model_suno", "suno", "folder", {}, "suno"),
    ("model_sunoesque", "sunoesque", "generate", {}, "suno"),
    ("model_magenta", "gemini-magenta", "generate", {}, "gemini-magenta"),
    ("model_gemini", "gemini-music", "generate", {}, "gemini-magenta"),
    ("model_udio", "udio-v2", "generate", {}, "udio"),
    ("model_riffusion", "riffusion", "generate", {}, "riffusion"),
    ("plain_import", "whatever", "import", {}, "import"),
    ("native_generate", "medium", "generate", {}, "stable-audio"),
    ("native_studio", "", "studio", {}, "stable-audio"),
)


@pytest.fixture
def parity_store(tmp_path: Path) -> LibraryStore:
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    for entry_id, model, source, extra, _slug in PARITY_ROWS:
        _seed_entry(root, entry_id, {"model": model, "source": source, **extra})
    return LibraryStore(root)


def test_the_wire_label_matches_the_rule_table(parity_store):
    """What an entry is labeled, read off disk and read out of the DB."""
    expected = {entry_id: slug for entry_id, _m, _s, _x, slug in PARITY_ROWS}
    assert {r.id: r.provider for r in parity_store.list_entries()} == expected
    paged = parity_store.list_entries_page(EntryFilters(), limit=100)
    assert {r.id: r.provider for r in paged} == expected


def test_the_sql_filter_files_every_entry_under_its_wire_label(parity_store):
    """The parity that matters: for every rule, the slug Python puts on the
    wire is the slug the SQL filter returns that entry under -- and no entry
    is returned under two."""
    wire = {r.id: r.provider for r in parity_store.list_entries()}
    by_entry: dict[str, list[str]] = {entry_id: [] for entry_id in wire}
    for slug in sorted(set(wire.values())):
        for entry_id in _ids(parity_store, provider=slug):
            by_entry[entry_id].append(slug)

    assert by_entry == {entry_id: [slug] for entry_id, slug in wire.items()}
    assert parity_store.db is not None
    for slug in sorted(set(wire.values())):
        matched = sum(1 for value in wire.values() if value == slug)
        assert (
            parity_store.db.count_entries_filtered(EntryFilters(provider=slug))
            == matched
        )


def test_the_provider_facet_reports_rules_two_to_seven(parity_store):
    """The facet's contract, and the one gap it is documented to have.

    It folds ``(model, source)`` through ``infer_provider`` inside the covering
    index, so the rule's two metadata-backed arms -- a stored ``$.provider``
    and a ``$.suno_id`` -- are invisible to it: those entries are COUNTED under
    what their columns imply while the FILTER returns them under the slug they
    really carry. Pinned on both sides so the divergence is exactly this and
    cannot widen unnoticed. See ``LibraryDB._provider_facet`` for the 570 ms
    measurement that is the reason.
    """
    from collections import Counter

    from backend.modules.library.db import infer_provider

    assert parity_store.db is not None
    facet = {
        row["value"]: row["count"]
        for row in parity_store.db.facet_counts(EntryFilters(), ["provider"])[
            "provider"
        ]
    }
    assert facet == dict(
        Counter(
            infer_provider(model, source)
            for _id, model, source, _extra, _slug in PARITY_ROWS
        )
    )
    # The gap, stated out loud from both ends.
    assert "bandcamp" not in facet
    assert _ids(parity_store, provider="bandcamp") == {"stored_label"}
    assert _ids(parity_store, provider="import") == {"plain_import"}
    assert "legacy_suno_id" in _ids(parity_store, provider="suno")


def test_infer_provider_still_mirrors_the_frontend_rules():
    """Rules 2-7 alone, as the pure function the SQL CASE is written from."""
    from backend.modules.library.db import infer_provider

    for _id, model, source, extra, slug in PARITY_ROWS:
        if "provider" in extra:
            continue  # rule 1 is not this function's business
        assert infer_provider(model, source, extra.get("suno_id")) == slug


def test_list_endpoint_filters_and_counts_by_provider(client_with_root, tmp_path):
    _seed_entry(tmp_path, "legacy_source", {"source": "suno"})
    _seed_entry(tmp_path, "plain", {"source": "generate"})
    store = library_router_module.get_store()
    store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="fresh.mp3",
        mime_type="audio/mpeg",
        metadata={"title": "fresh suno"},
    )

    body = client_with_root.get("/api/library/entries?provider=suno").json()
    assert {e["title"] for e in body["entries"]} == {"legacy_source", "fresh suno"}
    assert body["total"] == 2
    assert all(e["provider"] == "suno" for e in body["entries"])

    ids = client_with_root.get("/api/library/entries/ids?provider=suno").json()
    assert ids["total"] == 2

    empty = client_with_root.get("/api/library/entries?provider=udio").json()
    assert empty["entries"] == []
    assert empty["total"] == 0
