/**
 * djAutomixPlan — the DJ Automix transition brain, as pure functions.
 *
 * DJView's automix used to decide everything inline inside a `setInterval`:
 * when to blend, how far the crossfader had travelled, what pitch the
 * follower needed. None of it could be tested without the audio engine, and
 * all of it was wrong in ways a listener hears:
 *
 *  · the blend started at a fixed distance from the end — mid-phrase, mid-bar,
 *    wherever the tail rule happened to land;
 *  · both basslines ran together for the whole 10 s fade;
 *  · a required pitch the ±10 % fader could not deliver was clamped in
 *    silence while the UI still said "BPM Sync";
 *  · when the outgoing track ended before the incoming one had decoded, the
 *    "is it due?" test (which required the outgoing deck to be PLAYING)
 *    answered no forever and the set ran into dead air;
 *  · a fade interrupted by the outgoing track ending left the crossfader
 *    parked wherever the last partial write put it.
 *
 * Everything here is pure: seconds in, numbers out, no engine, no React, no
 * clock of its own (the caller passes `now` — the automix interval passes the
 * AudioContext clock, so a stalled/throttled timer cannot skew a fade).
 */

/** dB the bass is cut to while the other deck owns the low end. */
const EQ_KILL_DB = -26;
/** Beats in a phrase. Dance music is built in 4-bar phrases; a blend that
 *  starts anywhere else sounds like a mistake even when it is beatmatched. */
export const PHRASE_BEATS = 16;
/** How close (in beats) a downbeat must sit to a 16-beat multiple to count. */
const DOWNBEAT_TOLERANCE_BEATS = 0.25;
/** A blend never begins before this much of the outgoing track has played.
 *  Without it a track shorter than `tailSec` mixes out from its first frame,
 *  and phrase quantisation (which only ever moves the start EARLIER) can drag
 *  a short track's blend back onto a phrase line near zero. */
export const MIN_PLAY_FRACTION = 0.5;
/** Phase error (sec) below which a nudge is not worth scheduling. */
export const PHASE_DEADBAND_SEC = 0.008;

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const finite = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

/* ─────────────────────────────── transition ─────────────────────────────── */

/** The outgoing (currently playing) deck, as the plan needs to see it. */
export interface AutomixOutgoing {
  /** Playback position, seconds. */
  currentTime: number;
  /** Track length, seconds. 0 = unknown (nothing decoded yet). */
  duration: number;
  /** Analysis tempo, null until analysis lands. */
  bpm: number | null;
  /** Constant-beatgrid phase (`buildBeatgrid().anchor`), null with no grid. */
  gridAnchor: number | null;
  /** Seconds per beat from the same grid, null with no grid. */
  beatLen: number | null;
  playing: boolean;
  /** True once this deck has actually PLAYED during the current automix run.
   *  `playing: false` means two completely different things — a track that
   *  ran out (rescue it) and a deck that is still decoding and has never made
   *  a sound (wait for it) — and the plan cannot tell them apart without this. */
  started: boolean;
  /** A prepared set's exact blend-out point; replaces the tail rule. */
  mixOut?: number | null;
  /** Detected downbeats, when the rhythm analysis has them. Preferred over
   *  the bare grid: a downbeat that is a whole number of phrases from the
   *  first one is a real phrase start, not just a multiple of 16 beats. */
  downbeats?: number[] | null;
}

/** The incoming (staged) deck. */
export interface AutomixIncoming {
  bpm: number | null;
  /** Its audio is decoded and ready to play. */
  hasBuffer: boolean;
  /** Where the incoming track should start, seconds (0 = top of the file). */
  cueIn?: number | null;
}

export type TransitionReason =
  /** The mix-out point has not been reached. */
  | 'not-due'
  /** Nothing decoded on the incoming deck — there is nothing to blend into. */
  | 'no-incoming'
  /** The incoming deck has audio but no tempo yet; still waiting. */
  | 'incoming-not-ready'
  /** The outgoing deck stopped; start the incoming one immediately. */
  | 'outgoing-stopped'
  /** The outgoing deck has never played — it is still loading/decoding, or
   *  its start was given up on. There is nothing to transition OUT of yet, so
   *  the blend waits rather than "rescuing" a set that never began. */
  | 'outgoing-not-started'
  /** Started on a 16-beat phrase boundary. */
  | 'phrase'
  /** Started at the raw mix-out point — no grid to align to. */
  | 'unaligned'
  /** An explicit "transition NOW" request. */
  | 'forced';

export interface TransitionPlan {
  /** Begin the blend on this tick. */
  start: boolean;
  /** Dead-air rescue: no fade-in runway, just get audio playing. */
  immediate: boolean;
  /** Outgoing-track position (sec) the blend is planned for; null when there
   *  is no mix-out point to aim at (unknown duration and no prepared point). */
  startAt: number | null;
  /** Fade length, seconds. */
  fadeSec: number;
  /** `startAt` sits on a 16-beat phrase boundary of the outgoing track. */
  phraseAligned: boolean;
  /** Both tempos are known, so the decks CAN be beatmatched. Never true on a
   *  guess — the interval flashes an honest "unmatched" message when false. */
  matched: boolean;
  /** Where the incoming deck starts playing, seconds. */
  cueIn: number;
  /** The `now` handed in — the fade clock's t0, so the caller never mixes
   *  clocks between "when the fade started" and "how far along it is". */
  startedAt: number;
  reason: TransitionReason;
}

/**
 * Quantise a mix-out point DOWN to the outgoing track's nearest phrase start.
 * Prefers a detected downbeat that is a whole number of 16-beat phrases from
 * the FIRST downbeat; falls back to the constant grid; falls back again to the
 * raw point when there is no grid at all.
 */
function phraseStart(
  at: number,
  beatLen: number | null,
  gridAnchor: number | null,
  downbeats: number[] | null | undefined,
  /** Quantising only ever moves the start EARLIER; never below this. */
  floor: number,
): { startAt: number; aligned: boolean } {
  if (!finite(beatLen) || beatLen <= 0) return { startAt: at, aligned: false };
  const phrase = beatLen * PHRASE_BEATS;

  if (downbeats && downbeats.length > 0 && finite(downbeats[0])) {
    const first = downbeats[0];
    let best: number | null = null;
    for (const d of downbeats) {
      if (!finite(d) || d > at + 1e-6) continue;
      const beatsFromFirst = (d - first) / beatLen;
      const off = Math.abs(beatsFromFirst - Math.round(beatsFromFirst / PHRASE_BEATS) * PHRASE_BEATS);
      if (off <= DOWNBEAT_TOLERANCE_BEATS && (best == null || d > best)) best = d;
    }
    if (best != null && best >= floor) return { startAt: best, aligned: true };
  }

  if (!finite(gridAnchor)) return { startAt: at, aligned: false };
  const k = Math.floor((at - gridAnchor) / phrase + 1e-9);
  const startAt = gridAnchor + k * phrase;
  if (!finite(startAt) || startAt < 0 || startAt < floor) return { startAt: at, aligned: false };
  return { startAt, aligned: true };
}

/**
 * The RAW position on the outgoing track where a blend becomes due: a prepared
 * set's exact mix-out point when it has one, else `tailSec` before the end.
 * Null when neither exists (nothing decoded, so no length to count back from).
 * Shared by `planTransition` (which then quantises it to a phrase) and
 * DJView's `automixTransitionDue`, so the two can never disagree about when a
 * transition is due.
 */
export function mixOutPoint(o: { duration: number; mixOut?: number | null }, tailSec: number): number | null {
  // A prepared set's point is the DJ's own call — an early mix-out is a valid
  // edit, so only a negative one (nonsense) is corrected.
  if (finite(o.mixOut)) return Math.max(0, o.mixOut);
  if (!(o.duration > 0)) return null;
  // `duration - tailSec` is NEGATIVE for anything shorter than the tail (an
  // 18 s tail on a 12 s track gives −6). The old form handed that straight
  // back, `currentTime >= startAt` was true at 0, and the track blended out
  // the instant it started. Floor it at MIN_PLAY_FRACTION of the track.
  return clamp(Math.max(o.duration * MIN_PLAY_FRACTION, o.duration - tailSec), 0, o.duration);
}

/**
 * Carry-over for a phase nudge the engine could only partly deliver.
 *
 * `djEngine.nudgePhase` bends the platter inside a bend limit and a bounded
 * window, so a large correction comes back short — it returns what it actually
 * delivered. Ignoring that leaves the decks permanently out of phase by the
 * shortfall. Re-apply the remainder on the next tick, unless it is inside the
 * deadband (chasing a few ms forever is audible wobble, not a fix).
 *
 * @returns the shift still owed (signed), or 0 when nothing is worth doing.
 */
export function residualNudge(requested: number, delivered: number, deadbandSec: number): number {
  if (!finite(requested) || !finite(delivered)) return 0;
  const remaining = requested - delivered;
  const band = Math.abs(finite(deadbandSec) ? deadbandSec : 0);
  return Math.abs(remaining) > band + 1e-9 ? remaining : 0;
}

/**
 * Decide whether — and where — the automix blend into the incoming deck starts.
 *
 * Ordering matters: the dead-air rescue is checked BEFORE "is it due", because
 * a stopped outgoing deck can never be due (it has no clock left to advance).
 */
export function planTransition(args: {
  outgoing: AutomixOutgoing;
  incoming: AutomixIncoming;
  /** Requested crossfade length, seconds. */
  fadeSec: number;
  /** How long before the end a classic (unprepared) blend begins, seconds. */
  tailSec: number;
  /** Current clock (the caller's audio clock) — becomes the fade's t0. */
  now: number;
  /** An explicit "transition NOW" request from the assistant / a user. */
  forced?: boolean;
}): TransitionPlan {
  const { outgoing: o, incoming: inc, fadeSec, tailSec, now, forced = false } = args;
  const cueIn = finite(inc.cueIn) ? inc.cueIn : 0;
  const bothTempos = finite(o.bpm) && o.bpm > 0 && finite(inc.bpm) && inc.bpm > 0;
  const base = { fadeSec, cueIn, startedAt: now, immediate: false };

  // Nothing decoded on the incoming deck: no plan can help.
  if (!inc.hasBuffer) {
    return {
      ...base, start: false, startAt: null, phraseAligned: false, matched: false,
      reason: o.playing ? 'incoming-not-ready' : 'no-incoming',
    };
  }

  // Dead air (fix 6): the outgoing deck is not running — it ended while the
  // incoming track was still decoding, or something else stopped it. Waiting
  // for a mix-out point on a stopped clock means waiting forever.
  //
  // …but ONLY once that deck has actually played (DJ-5). A deck that is still
  // decoding also reads `playing: false`, and treating that as dead air made
  // every 500 ms tick "rescue" the set into the next track: nothing ever
  // played, and a new track was loaded every few seconds forever.
  if (!o.playing) {
    return o.started
      ? {
        ...base, start: true, immediate: true, startAt: o.currentTime,
        phraseAligned: false, matched: bothTempos, reason: 'outgoing-stopped',
      }
      : {
        ...base, start: false, startAt: null,
        phraseAligned: false, matched: false, reason: 'outgoing-not-started',
      };
  }

  // Where the blend is meant to begin, phrase-quantised.
  const rawDue = mixOutPoint(o, tailSec);
  // The tail rule's floor also binds the quantisation; a prepared mix-out is
  // deliberate, so only the phrase line's own "never negative" rule applies.
  const floor = finite(o.mixOut) ? 0 : (o.duration > 0 ? o.duration * MIN_PLAY_FRACTION : 0);
  const q = rawDue != null
    ? phraseStart(rawDue, o.beatLen, o.gridAnchor, o.downbeats, floor)
    : { startAt: null as number | null, aligned: false };
  const due = forced || (q.startAt != null && o.currentTime >= q.startAt);
  const startAt = forced ? o.currentTime : q.startAt;
  const phraseAligned = forced ? false : q.aligned;

  // The incoming deck has audio but no tempo: mixing into it blind is worse
  // than waiting — unless waiting means running the outgoing track to silence.
  const desperate = o.duration > 0 && o.duration - o.currentTime < tailSec / 2;
  if (!finite(inc.bpm) || inc.bpm <= 0) {
    const start = forced || (due && desperate);
    return {
      ...base, start, startAt: start ? o.currentTime : startAt,
      phraseAligned: false, matched: false, reason: 'incoming-not-ready',
    };
  }

  return {
    ...base,
    start: due,
    startAt,
    phraseAligned,
    matched: bothTempos,
    reason: !due ? 'not-due' : forced ? 'forced' : phraseAligned ? 'phrase' : 'unaligned',
  };
}

/* ──────────────────────────────── crossfade ─────────────────────────────── */

/**
 * Crossfader position `fadeSec` into a fade that began at `t0`.
 *
 * Always lands EXACTLY on `to` once the fade is over — and on `to` rather than
 * some partial value for a degenerate clock or length (fix 7: the old inline
 * form divided by `fadeSec` and left the fader parked at e.g. 0.3 when the
 * outgoing track ended mid-fade and the swap branch ran before the last write).
 */
export function fadeStep(t0: number, now: number, fadeSec: number, from: number, to: number): number {
  if (!finite(fadeSec) || fadeSec <= 0 || !finite(now) || !finite(t0)) return to;
  const t = (now - t0) / fadeSec;
  if (!finite(t) || t >= 1) return to;
  if (t <= 0) return from;
  return from + (to - from) * t;
}

/**
 * The bass swap (fix 1). Two basslines playing at once is the single most
 * audible thing an amateur automix does; a DJ pulls the outgoing low out as
 * the incoming one comes in. Held flat for the first third of the fade (the
 * incoming track's intro rides on top), swapped across the middle third,
 * settled for the last third.
 *
 * @param progress 0 → 1 through the crossfade.
 */
export function eqSwap(progress: number): { outLowDb: number; inLowDb: number } {
  const p = finite(progress) ? clamp(progress, 0, 1) : 0;
  const t = clamp((p - 1 / 3) * 3, 0, 1);
  // `+ 0` normalises -0 (what `-26 * 0` gives) to 0, so an untouched band
  // compares equal to 0 for callers that skip no-op EQ writes.
  return { outLowDb: EQ_KILL_DB * t + 0, inLowDb: EQ_KILL_DB * (1 - t) + 0 };
}

/* ──────────────────────────────── beatmatch ─────────────────────────────── */

export interface TempoMatch {
  /** Pitch percent to put on the follower, already clamped to ±`maxPct`. */
  pct: number;
  /** The pitch a caller should actually APPLY: `pct` when the match is real,
   *  0 when it is not (DJ-5). Clamping an unreachable match and applying it
   *  anyway parks the fader at its rail — the deck plays at the wrong speed
   *  and is no closer to the master's tempo than it was at 0 %. One number,
   *  so syncDeck and the sync-lock PLL cannot disagree about it. */
  appliedPct: number;
  /** The clamp did NOT have to truncate: the decks really are beatmatched.
   *  False means the UI must not claim a match (fix 4). */
  matched: boolean;
  /** The ratio was folded by an octave (half/double time) to get in range. */
  folded: boolean;
  /** Playback rate the clamped `pct` actually produces. */
  rate: number;
}

/**
 * Pitch the follower needs to run at the master's tempo.
 *
 * Folds by octaves first (140 against 70 BPM is a legitimate 0 % match), then
 * clamps to the pitch fader's range — and says so when the clamp truncated it,
 * instead of moving the fader to its limit and flashing "BPM Sync: matched".
 */
export function tempoMatch(masterBpm: number | null, followerBpm: number | null, maxPct: number): TempoMatch {
  if (!finite(masterBpm) || masterBpm <= 0 || !finite(followerBpm) || followerBpm <= 0) {
    return { pct: 0, appliedPct: 0, matched: false, folded: false, rate: 1 };
  }
  let rate = masterBpm / followerBpm;
  let folded = false;
  while (rate > Math.SQRT2) { rate /= 2; folded = true; }
  while (rate < Math.SQRT1_2) { rate *= 2; folded = true; }
  const raw = (rate - 1) * 100;
  const lim = Math.abs(finite(maxPct) ? maxPct : 0);
  const pct = clamp(raw, -lim, lim);
  const matched = Math.abs(raw) <= lim + 1e-9;
  return { pct, appliedPct: matched ? pct : 0, matched, folded, rate: 1 + pct / 100 };
}

/* ─────────────────────────────── next track ─────────────────────────────── */

/** Parse "8A" / "12B" into its ring position. Null for anything else. */
function parseCamelot(code: string | null | undefined): { num: number; letter: 'A' | 'B' } | null {
  if (!code) return null;
  const m = /^([0-9]{1,2})([AB])$/.exec(code.trim().toUpperCase());
  if (!m) return null;
  const num = Number(m[1]);
  if (!(num >= 1 && num <= 12)) return null;
  return { num, letter: m[2] as 'A' | 'B' };
}

/** True when two Camelot codes mix harmonically: same code, ±1 on the same
 *  ring (a fifth), or the relative major/minor (same number, other ring). */
export function camelotCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = parseCamelot(a);
  const cb = parseCamelot(b);
  if (!ca || !cb) return false;
  if (ca.letter === cb.letter) {
    const d = Math.abs(ca.num - cb.num);
    return d === 0 || d === 1 || d === 11; // 11 = the 12 → 1 wrap
  }
  return ca.num === cb.num;
}

/**
 * Which track in the set plays next (fix 10).
 *
 * Strict set order unless the DJ left room to be choosy: with at least 3
 * tracks still to come and a key clash straight ahead, skip to the nearest
 * harmonically compatible one. An unanalysed track is never skipped over — an
 * unknown key is not a known clash.
 *
 * @returns index into `candidates`, or null at the end of the set.
 */
export function chooseNextIndex(args: {
  /** Index of the OUTGOING track in the set; -1 when it is not in the set. */
  fromIndex: number;
  candidates: Array<{ camelot: string | null }>;
  currentCamelot: string | null;
  preferHarmonic: boolean;
  /** Tracks that must remain after the next one before reordering. */
  minRemaining?: number;
}): number | null {
  const { fromIndex, candidates, currentCamelot, preferHarmonic, minRemaining = 3 } = args;
  const next = fromIndex >= 0 ? fromIndex + 1 : 0;
  if (next >= candidates.length) return null;
  if (!preferHarmonic || !currentCamelot) return next;
  if (candidates.length - next < minRemaining) return next;
  const straightAhead = candidates[next]?.camelot ?? null;
  // Unknown key ahead: leave the DJ's order alone rather than guess.
  if (!straightAhead || camelotCompatible(currentCamelot, straightAhead)) return next;
  for (let i = next + 1; i < candidates.length; i++) {
    if (camelotCompatible(currentCamelot, candidates[i]?.camelot ?? null)) return i;
  }
  return next;
}
