"""Backfill + repair for notation artifacts.

Idempotent, safe to re-run every launch:

  - Generate a MusicXML sheet for every entry that has MIDI but no sheet.
  - Repair sheets that are missing the song title (music21 stamps the
    placeholder "Music21 Fragment" on untitled MIDI) or the artist credit, by
    regenerating them from the source MIDI so they also pick up the current
    engraving. When the source MIDI is gone, the title is patched in place.

Runs in a worker thread off the event loop; the caller enqueues it on the
idle-gated background queue so a large library never blocks a request.
"""

from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

_PLACEHOLDER = "Music21 Fragment"


def _rewrite_titles(path: Path, title: str, composer: str) -> bool:
    """Patch the printed title (and an existing composer credit) of a MusicXML
    file in place. Returns True if changed. Best-effort."""
    if not title and not composer:
        return False
    try:
        tree = ET.parse(str(path))
    except Exception:
        return False
    root = tree.getroot()
    changed = False
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]  # strip any namespace
        if title and tag in ("movement-title", "work-title"):
            if (el.text or "") != title:
                el.text = title
                changed = True
        elif tag == "credit-words" and (el.text or "").strip() == _PLACEHOLDER:
            el.text = title or composer
            changed = True
        elif composer and tag == "creator" and el.get("type") == "composer":
            if (el.text or "") != composer:
                el.text = composer
                changed = True
    if changed:
        try:
            tree.write(str(path), encoding="utf-8", xml_declaration=True)
        except Exception:
            return False
    return changed


def _needs_fix(path: Path, title: str, composer: str) -> bool:
    """Cheap check (no music21 parse): does this sheet still need a title /
    composer fix?"""
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return False
    # Only flag the placeholder when we have a real title to replace it with;
    # otherwise an untitled entry would regenerate to music21's placeholder on
    # every launch forever.
    if title and _PLACEHOLDER in text:
        return True
    if title and title not in text:
        return True
    if composer and composer not in text:
        return True
    return False


def backfill_scores(store: Any) -> dict[str, int]:
    res = {"scanned": 0, "generated": 0, "fixed": 0, "skipped": 0, "errors": 0}
    if store.db is None:
        return res
    try:
        from .engine import (
            artist_name,
            clean_title,
            midi_to_musicxml,
            register_existing_midis,
            sheet_output_path,
        )
    except Exception:
        return res

    composer = artist_name()
    try:
        entries = store.db.list_entries()
    except Exception:
        return res

    for entry in entries:
        eid = str(entry.get("id") or "")
        if not eid:
            continue
        res["scanned"] += 1
        # Read the title from the entry RECORD, the same source
        # engine.sheet_output_path derives the filename from and the /from-midi
        # route engraves with. Using the entries-table value here instead made
        # this writer stamp different content than that route for the same
        # artifact id, so _needs_fix saw a "wrong" title and regenerated the
        # sheet on every launch.
        record = store.get_entry(eid)
        record_title = (
            str(getattr(record, "title", "") or "") if record is not None else ""
        )
        title = clean_title(record_title)
        try:
            register_existing_midis(store.db, eid)
        except Exception:
            pass

        try:
            sheets = store.db.list_notation_artifacts(eid, kind="musicxml")
        except Exception:
            sheets = []

        # Does this entry need a (re)generation? Missing sheet, or an existing
        # sheet with the placeholder / wrong title / missing credit.
        has_sheet = bool(sheets)
        needs = (not has_sheet) or any(
            _needs_fix(Path(s.get("path") or ""), title, composer) for s in sheets
        )
        if not needs:
            res["skipped"] += 1
            continue

        # Prefer regenerating from the source MIDI (fresh engraving + correct
        # title + composer); fall back to an in-place title patch when the MIDI
        # is gone.
        target = None
        try:
            midis = store.db.list_midis(eid)
        except Exception:
            midis = []
        for midi in midis:
            mp = midi.get("midi_path") or ""
            if mp and Path(mp).is_file():
                target = midi
                break

        if target is not None:
            entry_dir = store._dir_for(eid)  # noqa: SLF001 - module convention
            if entry_dir is None:
                res["errors"] += 1
                continue
            midi_id = str(target.get("id") or "")
            # The one path both writers of this sheet agree on (see
            # engine.sheet_output_path): same filename spelling AND the same
            # title source as the /from-midi route, so they cannot ping-pong.
            out = sheet_output_path(store, eid, midi_id)
            if out is None:
                res["errors"] += 1
                continue
            try:
                result = midi_to_musicxml(
                    store.db,
                    entry_id=eid,
                    midi_path=Path(target["midi_path"]),
                    output_path=out,
                    source_ref=midi_id,
                    artifact_id=f"{midi_id}__musicxml",
                    # RAW record title, like /from-midi: the engraver cleans it
                    # itself, so passing the pre-cleaned value would diverge.
                    title=record_title,
                )
                if result.get("ok"):
                    res["generated" if not has_sheet else "fixed"] += 1
                else:
                    res["errors"] += 1
            except Exception as exc:  # noqa: BLE001 - best-effort
                log.debug("notation backfill: regen failed for %s: %s", eid, exc)
                res["errors"] += 1
        elif has_sheet:
            fixed_any = False
            for s in sheets:
                p = Path(s.get("path") or "")
                if p.is_file() and _rewrite_titles(p, title, composer):
                    fixed_any = True
            res["fixed" if fixed_any else "skipped"] += 1
        else:
            res["skipped"] += 1

    log.info(
        "notation backfill: scanned=%(scanned)d generated=%(generated)d "
        "fixed=%(fixed)d skipped=%(skipped)d errors=%(errors)d",
        res,
    )
    return res
