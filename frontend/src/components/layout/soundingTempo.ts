/**
 * An engraved sheet prints its tempo as a whole number (quarter = 129) and
 * plays the tempo its notes were placed at (129.1992446150832 for a
 * beat-tracked drum stem). MusicXML carries the printed number in
 * `<metronome><per-minute>` and the playing tempo in the same direction's
 * `<sound tempo>`.
 *
 * OSMD times a score from `<per-minute>`: the iterator's `CurrentBpm` and the
 * sheet's `DefaultStartTempoInBpm` are both that number, and the one
 * `<sound tempo>` it reads inside a direction it rounds to an integer. A time
 * map integrated at the printed 129 runs 0.15 percent slow against the audio.
 * These helpers read the sounding tempi out of the document so the time map can
 * integrate at them.
 *
 * Parsed with regular expressions so the module runs under plain Node, where
 * the test runner has no DOMParser.
 */

export interface SoundingTempo {
  /** 0-based index of the `<measure>` within its `<part>`, which is OSMD's
   *  source measure index. */
  measureIndex: number;
  /** The `<per-minute>` number the sheet prints, quarter notes per minute. */
  printed: number;
  /** The tempo the direction plays at, quarter notes per minute. */
  sounding: number;
}

// `[\s>]` after the name keeps <part-list>, <measure-style>, <direction-type>
// and <metronome-note> out of the matches.
const PART_RE = /<part[\s>][\s\S]*?<\/part>/g;
const MEASURE_RE = /<measure[\s>][\s\S]*?<\/measure>/g;
const DIRECTION_RE = /<direction[\s>][\s\S]*?<\/direction>/g;
const METRONOME_RE = /<metronome[\s>]/g;
const BEAT_UNIT_RE = /<beat-unit>\s*([a-z0-9]+)\s*<\/beat-unit>/g;
const PER_MINUTE_RE = /<per-minute>\s*([^<]*?)\s*<\/per-minute>/;
const SOUND_TEMPO_RE = /<sound\b[^>]*\btempo\s*=\s*(["'])([^"']*)\1/;

/** The whole number a sheet prints for a tempo; halves round up. */
const printedNumber = (bpm: number): number => Math.floor(bpm + 0.5);

/** One direction's tempo, or null when it is not a plain quarter-note mark. */
function directionTempo(direction: string): { printed: number; sounding: number } | null {
  if ((direction.match(METRONOME_RE) ?? []).length !== 1) return null;
  if (direction.includes('<beat-unit-dot')) return null;
  const units = Array.from(direction.matchAll(BEAT_UNIT_RE), (m) => m[1]);
  if (units.length !== 1 || units[0] !== 'quarter') return null;
  const printed = Number.parseFloat(PER_MINUTE_RE.exec(direction)?.[1] ?? '');
  if (!Number.isFinite(printed) || printed <= 0) return null;
  const sound = Number.parseFloat(SOUND_TEMPO_RE.exec(direction)?.[2] ?? '');
  // The sound tempo counts only when the printed number is it, rounded.
  const sounding =
    Number.isFinite(sound) && sound > 0 && printedNumber(sound) === printed ? sound : printed;
  return { printed, sounding };
}

/**
 * Every quarter-note metronome mark in a MusicXML document, in document order,
 * with the tempo it sounds at. A mark without a `<sound tempo>`, or whose
 * printed number is not that tempo rounded, sounds at its printed number.
 */
export function readSoundingTempi(xml: string): SoundingTempo[] {
  const out: SoundingTempo[] = [];
  if (!xml.includes('<metronome')) return out;
  for (const part of xml.match(PART_RE) ?? []) {
    if (!part.includes('<metronome')) continue;
    let measureIndex = -1;
    for (const measure of part.match(MEASURE_RE) ?? []) {
      measureIndex += 1;
      if (!measure.includes('<metronome')) continue;
      for (const direction of measure.match(DIRECTION_RE) ?? []) {
        const tempo = directionTempo(direction);
        if (tempo) out.push({ measureIndex, ...tempo });
      }
    }
  }
  return out;
}

/**
 * The tempo that sounds where OSMD reports `printedBpm` at `measureIndex`: the
 * sounding tempo of the latest mark at or before that measure that prints
 * `printedBpm`, or `printedBpm` itself when no mark matches.
 */
export function soundingBpm(
  tempi: readonly SoundingTempo[],
  measureIndex: number,
  printedBpm: number,
): number {
  let match: SoundingTempo | undefined;
  for (const tempo of tempi) {
    if (tempo.measureIndex > measureIndex || tempo.printed !== printedBpm) continue;
    if (!match || tempo.measureIndex >= match.measureIndex) match = tempo;
  }
  return match ? match.sounding : printedBpm;
}
