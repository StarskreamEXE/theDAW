"""Ingest songs from a SunoHarvester API-compatible cache into the DAW library.

Reads the cache JSON, deduplicates by song id (keeps the most recent record
for each id), optionally caps the number of entries, and writes metadata.json
directories into the library root so the library store picks them up on
reindex.

No audio is downloaded — each entry stores a cdn_audio_url that the
library audio endpoint proxies on first play.

For a loss-free staged import of the *whole* cache (every revision, lineage
edges, quarantine, resume) use ``scripts/stage_suno_cache.py`` instead; this
script stays the quick "give me playable CDN entries" path.

Usage:
    python scripts/ingest_suno_cache.py [--cache PATH] [--limit N]
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
from pathlib import Path
from typing import Optional

# CHANGED: new script — bulk-imports Suno cache entries as CDN-backed
# library entries (no audio download, proxied on demand).

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

log = logging.getLogger(__name__)

# CHANGED: Path("") is truthy, so the old `Path(os.environ.get(...)) or default`
# never reached the default — an unset SUNO_CACHE_PATH meant Path(".").
_CACHE_FROM_ENV = os.environ.get("SUNO_CACHE_PATH", "").strip()
DEFAULT_CACHE = (
    Path(_CACHE_FROM_ENV)
    if _CACHE_FROM_ENV
    else Path.home()
    / "Documents"
    / "GitHub"
    / "SunoHarvester"
    / "cache"
    / "main"
    / "library_cache_API_COMPATIBLE.json"
)


def load_cache(path: Path) -> list[dict]:
    # CHANGED: stream-parse with ijson to avoid MemoryError on 150k+ entry files.
    # ijson is not a project dependency and this script never installs anything:
    # it says what to run and exits.
    try:
        import ijson
    except ImportError:
        log.error(
            "Streaming %s needs the optional 'ijson' package, which this project "
            "does not depend on. Run `uv add ijson` first, or use "
            "scripts/stage_suno_cache.py with a JSONL export (no dependency).",
            path.name,
        )
        sys.exit(2)

    songs = []
    with open(path, "r", encoding="utf-8") as f:
        for song in ijson.items(f, "songs.item"):
            songs.append(song)
    return songs


def dedupe_by_id(songs: list[dict], limit: Optional[int]) -> list[dict]:
    """Sort by created_at desc, keep the newest record for each song id.

    CHANGED: keyed on the provider song id, not the title. Songs that share a
    title are different songs and all of them survive; an untitled song is kept
    too (``ingest`` gives it a fallback title).
    """
    songs_sorted = sorted(
        songs,
        key=lambda s: s.get("created_at") or "",
        reverse=True,
    )
    seen_ids: set[str] = set()
    result: list[dict] = []
    for s in songs_sorted:
        song_id = (s.get("id") or "").strip()
        if not song_id:
            continue
        if s.get("status") != "complete":
            continue
        if not s.get("audio_url"):
            continue
        if song_id in seen_ids:
            continue
        seen_ids.add(song_id)
        result.append(s)
        if limit is not None and len(result) >= limit:
            break
    return result


def song_duration(song: dict) -> Optional[float]:
    """Seconds when the cache states a usable duration, else None.

    CHANGED: the old code wrote 0.0 for every entry, which is indistinguishable
    from a real measurement. Unknown stays unknown.
    """
    meta = song.get("metadata") or {}
    candidates = (
        meta.get("duration") if isinstance(meta, dict) else None,
        song.get("duration"),
        song.get("duration_seconds"),
    )
    for value in candidates:
        if value is None or isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            number = float(value)
        elif isinstance(value, str):
            try:
                number = float(value.strip())
            except ValueError:
                continue
        else:
            continue
        if math.isfinite(number) and number > 0:
            return number
    return None


def ingest(songs: list[dict], library_root: Path) -> int:
    """Write metadata.json for each song into library_root/<id>/."""
    count = 0
    for song in songs:
        song_id = song.get("id")
        if not song_id:
            continue

        entry_dir = library_root / song_id
        meta_path = entry_dir / "metadata.json"
        if meta_path.exists():
            continue

        entry_dir.mkdir(parents=True, exist_ok=True)

        meta_block = song.get("metadata") or {}
        inferred = song.get("inferred") or {}
        style = meta_block.get("style") or ""
        lyrics = meta_block.get("lyrics") or ""
        prompt = meta_block.get("description") or style

        tags = ["suno", f"sunoid:{song_id}"]
        genre = inferred.get("genre")
        if genre:
            tags.append(genre)
        mood = inferred.get("mood")
        if mood:
            tags.append(mood)
        for st in inferred.get("style_tags") or []:
            if st and st not in tags:
                tags.append(st)

        meta = {
            "id": song_id,
            "title": song.get("title") or f"suno_{song_id[:8]}",
            "prompt": prompt,
            "negative_prompt": "",
            "model": "suno",
            "duration": song_duration(song),
            "steps": 0,
            "cfg": 0.0,
            "seed": 0,
            "mime_type": "audio/mpeg",
            "audio_filename": f"{song_id}.mp3",
            "favorite": False,
            "rating": None,
            "tags": tags,
            "notes": "",
            "source": "import",
            "timestamp": song.get("created_at") or "",
            "created_at": song.get("created_at") or "",
            "cdn_audio_url": song.get("audio_url") or "",
            "lyrics": lyrics,
            "style": style,
            "inferred": inferred,
            "metadata": meta_block,
        }

        meta_path.write_text(
            json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        count += 1

    return count


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Ingest SunoHarvester cache into DAW library"
    )
    parser.add_argument(
        "--cache", type=Path, default=DEFAULT_CACHE, help="Path to cache JSON"
    )
    # CHANGED: no cap by default — the old 5000 silently discarded the rest.
    parser.add_argument(
        "--limit", type=int, default=None, help="Max entries to import (default: all)"
    )
    return parser


def main() -> None:
    args = build_parser().parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if not args.cache.is_file():
        log.error("Cache file not found: %s", args.cache)
        sys.exit(1)

    log.info("Loading cache from %s ...", args.cache)
    songs = load_cache(args.cache)
    log.info("Loaded %d total songs", len(songs))

    selected = dedupe_by_id(songs, args.limit)
    log.info("Selected %d songs (deduped by song id, most recent first)", len(selected))

    from backend.modules.library.store import default_library_root

    library_root = default_library_root()
    log.info("Library root: %s", library_root)

    count = ingest(selected, library_root)
    log.info(
        "Wrote %d new metadata entries (skipped %d already-existing)",
        count,
        len(selected) - count,
    )

    # Trigger DB reindex so they show up immediately.
    from backend.modules.library.store import LibraryStore

    store = LibraryStore(library_root)
    indexed = store.reindex()
    log.info("Reindexed %d total library entries", indexed)


if __name__ == "__main__":
    main()
