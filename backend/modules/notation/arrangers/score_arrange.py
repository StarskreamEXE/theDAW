"""Rule-based score arrangers.

Transforms symbolic music (one or more MIDIs) into different playable
arrangements rendered as MusicXML:

  - ``lead-sheet``      melody (skyline) plus chord symbols
  - ``piano-reduction`` two-staff grand-staff reduction split at middle C
  - ``simplified``      single-staff melody only, quantized
  - ``band-score``      one staff per source stem (percussion staff for drum
                        MIDIs, clef by register, redundant 'full' mix skipped),
                        every staff on one beat grid

Pure music21; no new dependencies. Each builder returns a ``music21`` score
that the engine writes to MusicXML, so the results render in the existing
OpenSheetMusicDisplay viewer.
"""

from __future__ import annotations

import logging
import math
import tempfile
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

# A MIDI converted to a beat grid is written at no fewer ticks per quarter than
# this, so each note lands within half a millisecond of its source second.
_GRID_RESOLUTION = 960

# Tie types that join a head to the one before it, and to the one after it.
_TIE_IN = ("stop", "continue")
_TIE_OUT = ("start", "continue")

STYLES = ("lead-sheet", "piano-reduction", "simplified", "band-score")

# Pitches at or above middle C (MIDI 60) go to the treble staff.
_TREBLE_BASS_SPLIT = 60

# Band-score register control. A stem whose median pitch is below A3 (57)
# reads on a bass clef. Each clef gets a window of three ledger lines above
# and below the staff; pitches outside it are folded by octave INTO the
# window (pitch class preserved, register normalised), because basic-pitch
# stems span MIDI 22-101 and a ten-ledger-line stack under a treble staff
# inflates every system past the page.
_BAND_BASS_CLEF_BELOW = 57
_CLEF_WINDOWS: dict[str, tuple[int, int]] = {
    "G": (53, 88),  # F3 .. E6 on a treble staff
    "F": (33, 67),  # A1 .. G4 on a bass staff
}
# Keep the lowest pitch plus the top three: a sane skyline and measure width.
_BAND_MAX_CHORD = 4
# Stem names that are a second transcription of the whole mix; redundant
# beside the real stems (measured Jaccard 0.47 against the stem union) and
# always the tallest staff.
_MIX_STEM_NAMES = frozenset({"full", "mix", "master"})


def arrange(
    sources: list[Path],
    style: str,
    *,
    title: str = "",
    reference_bpm: Optional[float] = None,
) -> dict[str, Any]:
    """Build an arrangement of ``style`` from one or more source MIDIs.

    ``reference_bpm`` (the song's analysed tempo) is the beat grid a band score
    lays every staff out at; see :func:`_grid_bpm` for the tempo used without
    it. The single-source styles keep their source's own tempo.

    Returns a result dict; on success it carries the music21 ``score`` for the
    caller to write. Never raises.
    """
    style = style.lower().strip()
    if style not in STYLES:
        return {"ok": False, "error": f"unknown arrangement style: {style!r}"}
    try:
        import music21  # type: ignore[import] # noqa: F401 - availability check
    except ImportError:
        return {"ok": False, "error": "music21 is not installed."}

    from ..midi_read import read_score

    paths = [Path(s) for s in sources]
    if not paths:
        return {"ok": False, "error": "no source provided"}
    for path in paths:
        if not path.is_file():
            return {"ok": False, "error": f"source not found: {path}"}

    extra_stats: dict[str, Any] = {}
    try:
        if style == "band-score":
            score, extra_stats = _band_score(paths, title, reference_bpm)
        else:
            base = read_score(paths[0])
            try:
                base = base.quantize((4, 3), inPlace=False, recurse=True)
            except Exception as exc:  # noqa: BLE001 - quantize is best-effort
                log.debug("arrange: quantize skipped for %s: %s", paths[0], exc)
            if style == "piano-reduction":
                score = _piano_reduction(base, title)
            elif style == "lead-sheet":
                score = _lead_sheet(base, title)
            else:
                score = _simplified(base, title)
            # Re-quantize AFTER the merge. These styles all route through
            # _skyline_chords -> chordify(), which slices a new sonority at every
            # onset boundary across every part. When the source mixes duple and
            # triple positions (which the (4, 3) grid above permits by design),
            # those slice widths are differences between the two grids and are
            # not representable as a plain note value, so music21 renders them as
            # nonsense tuplets: 12:7, 24:19, 11:8, 17:16. Snapping the assembled
            # score back onto the same grid removes the slicing artifacts while
            # leaving real triplets alone. Measured on a live piano-reduction:
            # irrational tuplet notes 8 -> 0, total tuplets 690 -> 214, note
            # count unchanged at 1183.
            try:
                score = score.quantize((4, 3), inPlace=False, recurse=True)
            except Exception as exc:  # noqa: BLE001 - quantize is best-effort
                log.debug("arrange: post-merge quantize skipped for %s: %s", style, exc)
    except Exception as exc:  # noqa: BLE001
        log.warning("arrange: %s failed: %s", style, exc)
        return {"ok": False, "error": repr(exc)}

    note_count = len(score.flatten().notes)
    if note_count == 0:
        return {"ok": False, "error": "no notes found in source(s)"}
    stats: dict[str, Any] = {"parts": len(score.parts), "notes": note_count}
    stats.update(extra_stats)
    return {"ok": True, "style": style, "score": score, "stats": stats}


def _skyline_chords(base: Any) -> list[Any]:
    """Collapse a score to vertical sonorities with absolute offsets."""
    from music21 import chord  # type: ignore[import]

    flat = base.chordify().flatten()
    return list(flat.getElementsByClass(chord.Chord))


def _tie_type(notes: list[Any]) -> Optional[str]:
    """The tie of a head written for ``notes`` of a chordified sonority.

    ``chordify`` cuts a held note wherever another note starts or ends and ties
    the pieces. The head continues a held note only when every note it stands
    for does, and runs on only when every one of them does.
    """
    types = [n.tie.type if n.tie is not None else None for n in notes]
    incoming = all(t in _TIE_IN for t in types)
    outgoing = all(t in _TIE_OUT for t in types)
    if incoming and outgoing:
        return "continue"
    if incoming:
        return "stop"
    if outgoing:
        return "start"
    return None


def _voice(heads: list[tuple[Any, Optional[str]]], quarter_length: float) -> Any:
    """A note or chord of ``(pitch, tie type)`` heads."""
    from music21 import chord, note, tie  # type: ignore[import]

    notes = []
    for pitch, tie_type in heads:
        head = note.Note(pitch)
        if tie_type:
            head.tie = tie.Tie(tie_type)
        notes.append(head)
    element = notes[0] if len(notes) == 1 else chord.Chord(notes)
    element.duration.quarterLength = quarter_length or 1.0
    return element


def _mend_ties(part: Any) -> None:
    """Strike a head only where its note is struck.

    A head tied in continues the head of its pitch that ends where it starts.
    Octave folding, the chord cap and the skyline drop heads, so that head can
    be missing: the note was struck earlier, under another head, and nothing is
    struck here. Such a head is removed, and with it the rest of its tied run,
    so it never reads as a new note. A tie out of a head that no head
    continues is released.
    """
    from music21 import chord, common, harmony, note, tie  # type: ignore[import]

    heads: list[tuple[Any, Any, int, Any, Any]] = []
    for element in part.getElementsByClass((note.Note, chord.Chord)):
        if isinstance(element, harmony.ChordSymbol):
            continue
        offset = common.opFrac(element.offset)
        end = common.opFrac(offset + element.duration.quarterLength)
        members = list(element.notes) if isinstance(element, chord.Chord) else [element]
        for head in members:
            heads.append((offset, end, int(head.pitch.midi), head, element))
    heads.sort(key=lambda h: (h[0], h[2]))

    def kind(head: Any) -> Optional[str]:
        return head.tie.type if head.tie is not None else None

    kept: list[tuple[Any, Any, int, Any]] = []
    kept_ending: dict[tuple[Any, int], Any] = {}
    dropped: dict[int, tuple[Any, list[Any]]] = {}
    for offset, end, midi, head, element in heads:
        before = kept_ending.get((offset, midi))
        if kind(head) in _TIE_IN and (before is None or kind(before) not in _TIE_OUT):
            dropped.setdefault(id(element), (element, []))[1].append(head)
            continue
        kept_ending[(end, midi)] = head
        kept.append((offset, end, midi, head))

    kept_starting = {(offset, midi): head for offset, _end, midi, head in kept}
    decided: list[tuple[Any, Optional[str]]] = []
    for _offset, end, midi, head in kept:
        current = kind(head)
        after = kept_starting.get((end, midi))
        out_ok = current in _TIE_OUT and after is not None and kind(after) in _TIE_IN
        in_ok = current in _TIE_IN
        if in_ok and out_ok:
            decided.append((head, "continue"))
        elif in_ok:
            decided.append((head, "stop"))
        elif out_ok:
            decided.append((head, "start"))
        else:
            decided.append((head, None))
    for head, tie_type in decided:
        head.tie = tie.Tie(tie_type) if tie_type else None

    for element, gone in dropped.values():
        members = list(element.notes) if isinstance(element, chord.Chord) else [element]
        if len(gone) == len(members):
            part.remove(element)
        else:
            for head in gone:
                element.remove(head)


def _new_score(title: str, fallback: str) -> Any:
    from music21 import metadata, stream  # type: ignore[import]

    score = stream.Score()
    score.insert(0, metadata.Metadata())
    score.metadata.title = title or fallback
    return score


def _piano_reduction(base: Any, title: str) -> Any:
    from music21 import clef, stream  # type: ignore[import]

    treble = stream.Part()
    treble.partName = "Piano R.H."
    treble.insert(0, clef.TrebleClef())
    bass = stream.Part()
    bass.partName = "Piano L.H."
    bass.insert(0, clef.BassClef())

    for sonority in _skyline_chords(base):
        ql = sonority.duration.quarterLength
        heads = sorted(
            ((n.pitch, _tie_type([n])) for n in sonority.notes),
            key=lambda head: head[0].midi,
        )
        high = [head for head in heads if head[0].midi >= _TREBLE_BASS_SPLIT]
        low = [head for head in heads if head[0].midi < _TREBLE_BASS_SPLIT]
        if high:
            treble.insert(sonority.offset, _voice(high, ql))
        if low:
            bass.insert(sonority.offset, _voice(low, ql))
    _mend_ties(treble)
    _mend_ties(bass)

    score = _new_score(title, "Piano Reduction")
    score.insert(0, treble)
    score.insert(0, bass)
    return score


def _simplified(base: Any, title: str) -> Any:
    from music21 import clef, stream  # type: ignore[import]

    melody = stream.Part()
    melody.partName = "Melody"
    melody.insert(0, clef.TrebleClef())
    for sonority in _skyline_chords(base):
        top = max(sonority.notes, key=lambda n: n.pitch.midi)
        element = _voice(
            [(top.pitch, _tie_type([top]))], sonority.duration.quarterLength
        )
        melody.insert(sonority.offset, element)
    _mend_ties(melody)

    score = _new_score(title, "Simplified Melody")
    score.insert(0, melody)
    return score


def _safe_chord_symbol(sonority: Any) -> Any:
    """Return a renderable ChordSymbol for a sonority, or None.

    music21's ``chordSymbolFromChord`` returns an "unidentified" symbol for
    chords it can't name, and inserting one crashes MusicXML export with
    "no pitches in chord". This rebuilds from the figure and verifies it.
    """
    from music21 import harmony  # type: ignore[import]

    try:
        figure = getattr(harmony.chordSymbolFromChord(sonority), "figure", "") or ""
    except Exception:  # noqa: BLE001 - many chords have no clean symbol
        return None
    if not figure or "Cannot Be Identified" in figure:
        return None
    try:
        clean = harmony.ChordSymbol(figure)
    except Exception:  # noqa: BLE001
        return None
    return clean if clean.pitches else None


def _lead_sheet(base: Any, title: str) -> Any:
    from music21 import clef, stream  # type: ignore[import]

    lead = stream.Part()
    lead.partName = "Lead"
    lead.insert(0, clef.TrebleClef())
    last_figure = None
    for sonority in _skyline_chords(base):
        top = max(sonority.notes, key=lambda n: n.pitch.midi)
        element = _voice(
            [(top.pitch, _tie_type([top]))], sonority.duration.quarterLength
        )
        lead.insert(sonority.offset, element)
        # A triad is the minimum for a meaningful, identifiable chord symbol.
        if len(sonority.pitches) >= 3:
            symbol = _safe_chord_symbol(sonority)
            if symbol is not None and symbol.figure != last_figure:
                lead.insert(sonority.offset, symbol)
                last_figure = symbol.figure
    _mend_ties(lead)

    score = _new_score(title, "Lead Sheet")
    score.insert(0, lead)
    return score


def _stem_base(path: Path) -> str:
    """Normalised stem name: lower-case, last ``__``-separated segment
    (``Song__full`` -> ``full``)."""
    stem = path.stem.lower().strip()
    if "__" in stem:
        stem = stem.rsplit("__", 1)[-1]
    return stem


def _is_mix_stem(path: Path) -> bool:
    return _stem_base(path) in _MIX_STEM_NAMES


def _is_drum_named(path: Path) -> bool:
    base = _stem_base(path)
    return "drum" in base or "percussion" in base


def _clef_for_pitches(midis: list[int]) -> str:
    """'F' (bass) when the median pitch sits below A3, else 'G' (treble)."""
    if not midis:
        return "G"
    ordered = sorted(midis)
    median = ordered[len(ordered) // 2]
    return "F" if median < _BAND_BASS_CLEF_BELOW else "G"


def fold_into_window(midi: int, low: int, high: int) -> int:
    """Move ``midi`` by whole octaves until it lies in ``[low, high]``.

    The window is always at least an octave wide, so the result is unique.
    """
    while midi < low:
        midi += 12
    while midi > high:
        midi -= 12
    return midi


def _band_voice(
    notes: list[Any], quarter_length: float, window: tuple[int, int]
) -> tuple[Any, int]:
    """One band-score sonority: the notes of a chordified sonority folded into
    the clef window, deduped, capped at ``_BAND_MAX_CHORD`` (lowest + top
    three), each head tied as the notes it stands for are. Returns the element
    and the number of pitches that were folded."""
    from music21 import pitch as m21pitch  # type: ignore[import]

    low, high = window
    folded = 0
    sources: dict[int, list[Any]] = {}
    for n in notes:
        midi = int(n.pitch.midi)
        target = fold_into_window(midi, low, high)
        if target != midi:
            folded += 1
        sources.setdefault(target, []).append(n)
    kept = sorted(sources)
    if len(kept) > _BAND_MAX_CHORD:
        kept = [kept[0]] + kept[-(_BAND_MAX_CHORD - 1) :]
    heads = [(m21pitch.Pitch(midi=m), _tie_type(sources[m])) for m in kept]
    return _voice(heads, quarter_length), folded


def _grid_bpm(
    staves: list[tuple[Path, str, bool]], reference_bpm: Optional[float]
) -> float:
    """The one tempo a band score lays every staff out at.

    ``reference_bpm`` when it is a positive number. Otherwise the tempo of the
    first drum-kit MIDI, because the drum transcriber writes the song's
    analysed tempo; otherwise the first staff's own tempo.
    """
    import pretty_midi  # type: ignore[import]

    from .percussion import _DEFAULT_TEMPO, _initial_tempo

    if reference_bpm is not None and math.isfinite(reference_bpm) and reference_bpm > 0:
        return float(reference_bpm)
    if not staves:
        return _DEFAULT_TEMPO
    path = next((p for p, _name, drum_kit in staves if drum_kit), staves[0][0])
    return _initial_tempo(pretty_midi.PrettyMIDI(str(path)))


def _conform_midi(source: Path, bpm: float, target: Path) -> Path:
    """Put ``source`` on a constant ``bpm`` grid and return the file to read.

    A MIDI whose only tempo is already ``bpm`` is returned as it is. Any other
    is written to ``target`` at ``bpm``, with every note, time signature and
    key signature at the second it sounds in ``source``, and ``target`` is
    returned. Its quarter-note offsets then count beats of ``bpm``.
    """
    import pretty_midi  # type: ignore[import]

    from .percussion import _initial_tempo

    pm = pretty_midi.PrettyMIDI(str(source))
    _times, tempi = pm.get_tempo_changes()
    if len(tempi) <= 1 and _initial_tempo(pm) == bpm:
        return source
    out = pretty_midi.PrettyMIDI(
        resolution=max(int(pm.resolution), _GRID_RESOLUTION), initial_tempo=bpm
    )
    out.instruments = pm.instruments
    out.time_signature_changes = pm.time_signature_changes
    out.key_signature_changes = pm.key_signature_changes
    target.parent.mkdir(parents=True, exist_ok=True)
    out.write(str(target))
    return target


def _band_score(
    paths: list[Path], title: str, reference_bpm: Optional[float] = None
) -> tuple[Any, dict[str, Any]]:
    """One staff per stem, every staff on one beat grid.

    * With more than one source, a whole-mix stem (``full``/``mix``/``master``)
      is skipped: it duplicates the real stems and is always the tallest staff.
    * A drum-kit MIDI (``is_drum`` instruments, or GM kit pitches in a file
      named like a drum stem) becomes an unpitched percussion staff.
    * A drum-NAMED stem that is NOT kit data (a pitched transcription of a
      drum stem: hundreds of spurious notes across five octaves) is skipped
      when other stems exist: omitting is honest, chordifying is garbage.
    * Every other stem picks its clef from its median pitch, folds outliers by
      octave into a three-ledger-line window and caps chords at four pitches.

    The stem MIDIs of one song declare different tempos: the drum transcriber
    writes the analysed tempo and basic-pitch writes 120. A quarter note is a
    different length of time in each, so every staff is laid out at the one
    tempo :func:`_grid_bpm` picks, each note at the second it sounds in its own
    file, and the score carries one metronome mark at that tempo.

    Returns ``(score, stats)`` with ``stats = {skipped, skip_reasons, clefs,
    folded_notes}``.
    """
    from music21 import chord, clef, stream, tempo  # type: ignore[import]

    from ..midi_read import read_score
    from ..tempo_marks import metronome_mark
    from .percussion import build_percussion_part, is_drum_midi

    score = _new_score(title, "Band Score")
    skipped: list[str] = []
    skip_reasons: dict[str, str] = {}
    clefs: dict[str, str] = {}
    folded_total = 0
    multi = len(paths) > 1

    staves: list[tuple[Path, str, bool]] = []
    for index, path in enumerate(paths):
        part_name = path.stem[:24] or f"Part {index + 1}"
        drum_kit = is_drum_midi(path)
        if multi and not drum_kit and _is_mix_stem(path):
            skipped.append(path.stem)
            skip_reasons[path.stem] = "whole-mix transcription duplicates the stems"
            continue
        if multi and not drum_kit and _is_drum_named(path):
            skipped.append(path.stem)
            skip_reasons[path.stem] = (
                "pitched transcription of a drum stem (no kit data)"
            )
            continue
        staves.append((path, part_name, drum_kit))

    bpm = _grid_bpm(staves, reference_bpm)
    with tempfile.TemporaryDirectory(prefix="band_grid_") as scratch:
        for index, (path, part_name, drum_kit) in enumerate(staves):
            if drum_kit:
                part = build_percussion_part(path, title=part_name, bpm=bpm)
                clefs[part_name] = "percussion"
                score.insert(0, part)
                continue

            staff_midi = _conform_midi(path, bpm, Path(scratch) / f"{index}.mid")
            # A converted file lives in a directory deleted below; music21 would
            # otherwise pickle it into its cache under a path never read again.
            source = read_score(staff_midi, cache=staff_midi == path)
            try:
                source = source.quantize((4, 3), inPlace=False, recurse=True)
            except Exception as exc:  # noqa: BLE001 - quantize is best-effort
                log.debug("arrange: quantize skipped for %s: %s", path, exc)
            sonorities = list(
                source.chordify().flatten().getElementsByClass(chord.Chord)
            )
            clef_sign = _clef_for_pitches(
                [int(p.midi) for sonority in sonorities for p in sonority.pitches]
            )
            window = _CLEF_WINDOWS[clef_sign]
            # Rebuild each stem into a fresh part (as the other builders do) so
            # the MusicXML writer bars it with a consistent time signature.
            # Inserting chordify()'s pre-measured stream directly produced scores
            # OSMD could not render ("Cannot read properties of undefined
            # (reading 'denominator')").
            part = stream.Part()
            part.partName = part_name
            part.partAbbreviation = part_name[:6]
            part.insert(0, clef.BassClef() if clef_sign == "F" else clef.TrebleClef())
            for sonority in sonorities:
                element, folded = _band_voice(
                    list(sonority.notes), sonority.duration.quarterLength, window
                )
                folded_total += folded
                part.insert(sonority.offset, element)
            _mend_ties(part)
            clefs[part_name] = clef_sign
            score.insert(0, part)

    # A percussion staff carries the grid's mark; a score of pitched staves
    # gets it on the top staff.
    parts = list(score.parts)
    if (
        parts
        and score.recurse().getElementsByClass(tempo.MetronomeMark).first() is None
    ):
        parts[0].insert(0, metronome_mark(bpm))

    stats: dict[str, Any] = {
        "skipped": skipped,
        "skip_reasons": skip_reasons,
        "clefs": clefs,
        "folded_notes": folded_total,
    }
    return score, stats
