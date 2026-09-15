"""Every notation built from a MIDI keeps each note at the second it sounds.

The phrase below overlaps notes in bar 1 so music21's MIDI import splits the
bar into voices, and holds a G3 from bar 1 to bar 3. The import leaves the part
of the G3 that reaches into bar 2 unsplit, bar 2 overflows by three quarters,
and every later bar moved three quarters (1.5 s) late: in the single-part sheet,
the note chart built from the MIDI, the tabs and the band score. The band score
also struck a held note again wherever another note began or ended under it.

Every source onset sits on the (4, 3) quantization grid, so each notated onset
must land within a few milliseconds of its source second.
"""

from __future__ import annotations

import bisect
from pathlib import Path

import pretty_midi
import pytest

from backend.modules.library.db import LibraryDB
from backend.modules.notation.arrangers.guitar_tab import arrange_tabs
from backend.modules.notation.engine import midi_to_arrangement, midi_to_musicxml
from backend.modules.notation.exporters.notechart import build_notechart

BPM = 120.0
QUARTER = 60.0 / BPM
TOLERANCE_SEC = 0.005

# (onset in quarters, length in quarters, MIDI pitch)
PHRASE = [
    (0.0, 1.0, 60),
    (0.0, 2.0, 64),
    (1.5, 1.0, 71),
    (1.75, 9.25, 55),
    (4.0, 0.5, 69),
    (4.0, 1.5, 72),
    (6.0, 1.0, 67),
    (8.0, 1.0, 62),
    (8.0, 0.25, 65),
    (9.0, 1.0, 69),
    (12.0, 1.0, 60),
    (13.5, 0.5, 64),
    (16.0, 2.0, 67),
    (17.0, 1.0 / 3.0, 72),
    (20.0, 1.0, 60),
]


def _write_phrase(path: Path) -> list[tuple[int, float]]:
    """Write :data:`PHRASE` and return ``(pitch, onset seconds)`` per note."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=BPM)
    inst = pretty_midi.Instrument(program=0, name="keys")
    for onset, length, pitch in PHRASE:
        start = onset * QUARTER
        inst.notes.append(pretty_midi.Note(100, pitch, start, start + length * QUARTER))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))
    return sorted((pitch, onset * QUARTER) for onset, _length, pitch in PHRASE)


def _chart(source: Path) -> dict:
    return build_notechart(source, title="Phrase", artist="GANTASMO", entry_id="track")


def _attacks(chart: dict) -> list[tuple[int, float]]:
    """``(pitch, onset seconds)`` of every struck note in a note chart."""
    return sorted(
        (int(event["midi"]), float(event["onsetSec"]))
        for part in chart["parts"]
        for event in part["events"]
        if not event["isRest"]
        and not event["isGrace"]
        and event["tie"] not in ("stop", "continue")
    )


def _assert_on_source(
    attacks: list[tuple[int, float]], source: list[tuple[int, float]]
) -> None:
    """Each attack lies within :data:`TOLERANCE_SEC` of a source onset of its
    own pitch."""
    by_pitch: dict[int, list[float]] = {}
    for pitch, second in source:
        by_pitch.setdefault(pitch, []).append(second)
    for pitch, second in attacks:
        starts = by_pitch.get(pitch, [])
        j = bisect.bisect_left(starts, second)
        gap = min(
            (abs(starts[k] - second) for k in (j - 1, j) if 0 <= k < len(starts)),
            default=float("inf"),
        )
        assert gap <= TOLERANCE_SEC, (pitch, second, gap)


def _db(tmp_path: Path) -> LibraryDB:
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    return db


def test_single_part_sheet_keeps_every_onset(tmp_path: Path):
    midi = tmp_path / "midi" / "keys.mid"
    source = _write_phrase(midi)
    result = midi_to_musicxml(
        _db(tmp_path),
        entry_id="track",
        midi_path=midi,
        output_path=tmp_path / "notation" / "keys.musicxml",
    )
    assert result["ok"] is True, result
    attacks = _attacks(_chart(Path(result["path"])))
    _assert_on_source(attacks, source)
    assert len(attacks) == len(source)


def test_note_chart_from_a_midi_keeps_every_onset(tmp_path: Path):
    midi = tmp_path / "midi" / "keys.mid"
    source = _write_phrase(midi)
    chart = _chart(midi)
    attacks = _attacks(chart)
    _assert_on_source(attacks, source)
    assert len(attacks) == len(source)
    # The chart keeps its bars: six of them, four quarters each.
    assert chart["timing"]["totalMeasures"] == 6


def _arrange(tmp_path: Path, style: str) -> list[tuple[int, float]]:
    midi = tmp_path / "midi" / "keys.mid"
    _write_phrase(midi)
    result = midi_to_arrangement(
        _db(tmp_path),
        entry_id="track",
        sources=[midi],
        style=style,
        output_path=tmp_path / "notation" / f"keys__{style}.musicxml",
    )
    assert result["ok"] is True, result
    return _attacks(_chart(Path(result["path"])))


@pytest.mark.parametrize(
    "style", ["band-score", "piano-reduction", "lead-sheet", "simplified"]
)
def test_arrangement_strikes_notes_only_where_they_sound(tmp_path: Path, style: str):
    """No arrangement moves a note or strikes a held note again. That includes
    the G3 held from 1.75 quarters: the melody styles reach it at 2.5 quarters,
    when the B4 above it ends, and must not strike it there. The band score and
    the piano reduction keep every note."""
    attacks = _arrange(tmp_path, style)
    source = sorted((pitch, onset * QUARTER) for onset, _length, pitch in PHRASE)
    _assert_on_source(attacks, source)
    if style in ("band-score", "piano-reduction"):
        assert len(attacks) == len(source)


def test_tabs_keep_every_onset(tmp_path: Path):
    midi = tmp_path / "midi" / "keys.mid"
    source = _write_phrase(midi)
    result = arrange_tabs(midi, instrument="guitar")
    assert result["ok"] is True, result
    attacks = sorted(
        (int(n["pitch"]), float(n["offset"]) * QUARTER) for n in result["notes"]
    )
    _assert_on_source(attacks, source)
    assert len(attacks) == len(source)
