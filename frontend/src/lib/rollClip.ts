/**
 * rollClip — the piano roll's state as EDIT clip fields, and a clip's fields as
 * the arguments that load it back into the roll.
 *
 * A bounce stores two note lists. `sourcePianoRoll` holds the notes as they
 * sound: each looping lane's repeats written out and the lane ids dropped. EDIT
 * plays and draws that list once. `sourceRollNotes` holds the roll's own notes
 * with their lanes, so the clip reopens in the roll with the same lanes, and
 * its meter map, pickup and each lane's pitch bend travel beside them.
 *
 * No Vite-only imports, so node tests load it.
 */
import type { AudioClip } from '../state/editorStore';
import { DEFAULT_LANES, rollMeterOf, sanitizeLanes, type PianoNote, type RollMeter } from '../state/pianoRollStore';
import { normalizeMeterMap, roundUpToBar, unrollLanes, type PolyLane } from './meterMap';
import { copyBends, rollRenderBends, sanitizeBends, type LaneBend, type RollRenderBends } from './pitchBend';

/** The roll state a bounce reads. */
export type RollClipSource = RollMeter & { notes: readonly PianoNote[]; bpm: number; totalSteps: number; bends: readonly LaneBend[] };

type RollClipKeys =
  | 'sourcePianoRoll'
  | 'sourceRollNotes'
  | 'sourceBpm'
  | 'sourceTotalSteps'
  | 'sourceMeterMap'
  | 'sourcePickupSteps'
  | 'sourceLanes'
  | 'sourceBends';

/** The clip fields a bounce writes. */
export type RollClipFields = Required<Pick<AudioClip, RollClipKeys>>;

/** The clip fields clipRollLoad reads. */
export type RollClipInput = Pick<AudioClip, 'id' | RollClipKeys>;

/** The arguments of pianoRollStore's loadFromClip. */
export type RollLoadArgs = [clipId: string, notes: PianoNote[], bpm: number, totalSteps: number, meter: RollMeter, bends: LaneBend[]];

/**
 * The notes as they sound: each looping lane's repeats written out across the
 * roll. The editor and a MIDI file play a note list once, so every hand-off
 * takes this list. Lane ids are dropped, so a clip loaded back into the roll
 * does not loop its repeats a second time.
 */
export const playedRollNotes = (notes: readonly PianoNote[], lanes: readonly PolyLane[], totalSteps: number): PianoNote[] =>
  unrollLanes(notes, lanes, totalSteps).map(({ lane: _lane, ...n }) => n);

/** The clip fields a bounce writes from the roll's state. Every list is a copy. */
export function rollClipFields(s: RollClipSource): RollClipFields {
  const meter = rollMeterOf(s);
  return {
    sourcePianoRoll: playedRollNotes(s.notes, s.lanes, s.totalSteps),
    sourceRollNotes: s.notes.map((n) => ({ ...n })),
    sourceBpm: s.bpm,
    sourceTotalSteps: s.totalSteps,
    sourceMeterMap: meter.meterMap,
    sourcePickupSteps: meter.pickupSteps,
    sourceLanes: meter.lanes,
    sourceBends: copyBends(s.bends),
  };
}

/** The clip fields a render of a roll clip reads. */
export type ClipRenderSource = Pick<AudioClip, 'sourcePianoRoll' | 'sourceRollNotes' | 'sourceLanes' | 'sourceBends'>;

/**
 * The notes a roll clip's audio renders from over `totalSteps`. A clip whose
 * lanes bend renders the roll's own notes unrolled with their lanes, so each
 * note follows its lane's curve; any other clip renders the notes it plays.
 */
export function clipRenderInput(clip: ClipRenderSource, totalSteps: number): { notes: PianoNote[]; bends?: RollRenderBends } {
  const lanes = sanitizeLanes(clip.sourceLanes?.length ? clip.sourceLanes : DEFAULT_LANES);
  const own = clip.sourceRollNotes;
  const bends = clip.sourceBends?.length && own?.length ? rollRenderBends(sanitizeBends(clip.sourceBends), lanes, totalSteps) : undefined;
  if (!bends || !own) return { notes: clip.sourcePianoRoll ?? [] };
  return { notes: unrollLanes(own, lanes, totalSteps), bends };
}

/**
 * The arguments that load `clip` into the roll: its stored notes when it has
 * them, else the notes it plays, its meter and its lanes' bends (none when it
 * has none). A clip with no meter map was bounced before the roll had one, so
 * it loads as 4/4 with no pickup and lane A only, and its grid length rounds up
 * to a bar line.
 */
export function clipRollLoad(clip: RollClipInput): RollLoadArgs {
  const stored = clip.sourceRollNotes?.length ? clip.sourceRollNotes : clip.sourcePianoRoll ?? [];
  const notes = stored.map((n) => ({ ...n }));
  const meterMap = normalizeMeterMap(clip.sourceMeterMap);
  const pickupSteps = clip.sourcePickupSteps ?? 0;
  const lanes = sanitizeLanes(clip.sourceLanes?.length ? clip.sourceLanes : DEFAULT_LANES);
  const noteEnd = notes.reduce((m, n) => Math.max(m, n.step + Math.max(1, n.length)), 0);
  const totalSteps =
    clip.sourceMeterMap && clip.sourceTotalSteps !== undefined
      ? clip.sourceTotalSteps
      : roundUpToBar(meterMap, Math.max(1, clip.sourceTotalSteps ?? noteEnd), pickupSteps);
  return [clip.id, notes, clip.sourceBpm ?? 120, totalSteps, { meterMap, pickupSteps, lanes }, sanitizeBends(clip.sourceBends ?? [])];
}
