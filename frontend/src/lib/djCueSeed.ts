/**
 * djCueSeed — where a DJ track's four hot cues go when nobody has placed one.
 *
 * Until now nothing in the app ever wrote a cue: `djCuesStore`'s only writers
 * sat behind the hotcue pads and the MIDI map, so an analyzed track opened
 * with four empty pads and a waveform with no markers on it — the "i dont see
 * cue points" report. The docs have promised hotcue markers by default for a
 * while; this is the placement rule behind that promise.
 *
 * What we have to work with:
 *   - `djAnalysisStore` gives a flat `beats` list (every beat, ~300+ of them
 *     on a 2.5-minute track) and a `bpm`. It has no downbeats and no sections.
 *   - The rhythm module (`GET /api/rhythm/{id}`) DOES have downbeats — but
 *     only for tracks somebody already analyzed there, and running it is
 *     expensive. So downbeats are an optional upgrade, never a requirement.
 *
 * The rule is the one a DJ uses by hand: cue 1 on the first downbeat (the
 * first beat when no downbeats are known), then the starts of the 16, 32 and
 * 48-bar phrases after it — the three points a mix in/out most often lands on.
 *
 * Pure: no store, no fetch, no clock. `DJView` calls it once per track when
 * the analysis lands and hands the result to `djCuesStore.seedCues`.
 */

/** Bars in one phrase. 16 bars is the standard dance-music phrase length. */
export const CUE_PHRASE_BARS = 16;

/** Beats per bar. Analysis gives no meter, so 4/4 is the working assumption —
 *  when real downbeats are present they carry the true meter and this is only
 *  used for the tail of a short downbeat list. */
export const CUE_BEATS_PER_BAR = 4;

/** Hot cues seeded per track — matches `HOTCUE_SLOTS` in djCuesStore. */
export type SeededCues = [number, number, number, number];

export interface SeedCuesArgs {
  /** Every beat position in seconds, from `djAnalysisStore` (`a.beats`). */
  beats: number[] | null | undefined;
  /** Tracked tempo. Without it there is no phrase length and no seed. */
  bpm: number | null | undefined;
  /** Track length in seconds; `0`/absent simply skips the clamp. */
  duration: number | null | undefined;
  /** Bar starts from the rhythm module, when its cache already has them. */
  downbeats?: number[] | null;
  /** An explicit bar-start list, if a caller has one that is better than
   *  `downbeats` (the rhythm engine's `downbeats` are bar starts already, so
   *  in practice only one of the two is ever supplied). */
  bars?: number[] | null;
}

/** Drop NaN/Infinity/negative entries and put what is left in time order.
 *  Analysis payloads are not always clean and a cue is a seek target. */
function clean(list: number[] | null | undefined): number[] | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const out = list.filter((t) => Number.isFinite(t) && t >= 0);
  if (out.length === 0) return null;
  out.sort((a, b) => a - b);
  return out;
}

export function seedCues(args: SeedCuesArgs): SeededCues | null {
  const bpm = args.bpm;
  if (!Number.isFinite(bpm ?? NaN) || (bpm as number) <= 0) return null;
  const beatLen = 60 / (bpm as number);

  const beats = clean(args.beats);
  // An explicit bar list wins over downbeats; downbeats win over raw beats.
  const grid = clean(args.bars) ?? clean(args.downbeats);
  const anchor = grid ? grid[0] : beats ? beats[0] : null;
  if (anchor == null) return null;

  const duration = Number.isFinite(args.duration ?? NaN) ? (args.duration as number) : 0;
  // Keep the last cue a legal seek target: one beat short of the end, never
  // negative. `duration <= 0` means "unknown" — nothing to clamp against.
  const limit = duration > 0 ? Math.max(0, duration - beatLen) : Number.POSITIVE_INFINITY;
  const clamp = (t: number): number => Math.max(0, Math.min(t, limit));

  const phraseSec = CUE_PHRASE_BARS * CUE_BEATS_PER_BAR * beatLen;
  const at = (phrase: number): number => {
    // Real bar starts when the grid reaches that far; a short cached grid
    // (the rhythm engine stops at the last bar it was confident about) falls
    // back to measuring the phrase off the anchor.
    const fromGrid = grid?.[phrase * CUE_PHRASE_BARS];
    return clamp(fromGrid ?? anchor + phrase * phraseSec);
  };

  return [at(0), at(1), at(2), at(3)];
}
