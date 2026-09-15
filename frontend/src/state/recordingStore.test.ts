/**
 * recordingStore — the record press, driven entirely by fakes.
 *
 * The engine arrives through the store's factory seam, so this suite uses a
 * fake `RecordingEngine` whose `start` it resolves (or rejects) by hand and
 * whose takes it fabricates: no microphone, no `MediaRecorder`, no
 * `AudioContext`, no count-in scheduler. The TRANSPORT half is real — the
 * arm mirror reads `editorStore`'s own `armed` flags and the stop-follows-the-
 * transport rule rides `playerStore.isPlaying`, which is what `liveMixer`
 * writes — because those are the couplings the press exists to get right.
 *
 * The load-bearing assertions:
 *   - a press with nothing armed sets `lastError` and opens NOTHING;
 *   - `engine.start()` resolves BEFORE the transport is released, so the take's
 *     anchor is stamped against a clock that has not moved yet;
 *   - a pass leaves ONE undo step, and one undo takes every take of it back off
 *     the timeline without un-arming the track it was recorded on;
 *   - nothing the engine rejects with ever leaves the store as a throw.
 */
import assert from 'node:assert/strict';

import {
  RecordingError,
  type LevelFrame,
  type RecordingDeps,
  type RecordingEngine,
  type RecordingSource,
  type Take,
} from '../lib/recordingEngine.ts';
import { micConstraints } from '../lib/recordingEngine.ts';
import { useEditorStore } from './editorStore.ts';
import { usePlayerStore } from './playerStore.ts';
import {
  LEVEL_WRITE_MS,
  initRecording,
  musicalConstraints,
  resetRecording,
  setRecordingDeps,
  useRecordingStore,
} from './recordingStore.ts';

/** Let every queued microtask run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

const rs = () => useRecordingStore.getState();
const es = () => useEditorStore.getState();

/* ------------------------------- fake engine ------------------------------- */

interface FakeEngine extends RecordingEngine {
  /** Every call, in order, for the ordering assertions. */
  readonly calls: string[];
  /** Resolve / reject the `start()` currently in flight. */
  resolveStart(): void;
  rejectStart(err: unknown): void;
  /** What the next `stop()` hands back. */
  setTakes(takes: Take[]): void;
  emitLevel(trackId: string, frame: LevelFrame): void;
}

function fakeEngine(events: string[]): FakeEngine {
  const armedMap = new Map<string, RecordingSource>();
  const levelSubs = new Set<(trackId: string, frame: LevelFrame) => void>();
  const takeSubs = new Set<(take: Take) => void>();
  const calls: string[] = [];
  let takes: Take[] = [];
  let recording = false;
  let settleStart: (() => void) | null = null;
  let failStart: ((e: unknown) => void) | null = null;

  return {
    calls,
    arm(trackId, source) {
      calls.push(`arm:${trackId}`);
      armedMap.set(trackId, source);
    },
    disarm(trackId) {
      calls.push(`disarm:${trackId}`);
      armedMap.delete(trackId);
    },
    armed() {
      return [...armedMap.keys()];
    },
    start() {
      calls.push('start');
      events.push('engine.start');
      return new Promise<void>((res, rej) => {
        settleStart = () => {
          recording = true;
          res();
        };
        failStart = (e) => {
          recording = false;
          rej(e);
        };
      });
    },
    async stop() {
      calls.push('stop');
      events.push('engine.stop');
      recording = false;
      const out = takes;
      takes = [];
      for (const t of out) for (const cb of takeSubs) cb(t);
      return out;
    },
    isRecording() {
      return recording;
    },
    onLevel(cb) {
      levelSubs.add(cb);
      return () => { levelSubs.delete(cb); };
    },
    onTake(cb) {
      takeSubs.add(cb);
      return () => { takeSubs.delete(cb); };
    },
    resolveStart() {
      settleStart?.();
      settleStart = null;
      failStart = null;
    },
    rejectStart(err) {
      failStart?.(err);
      settleStart = null;
      failStart = null;
    },
    setTakes(next) {
      takes = next;
    },
    emitLevel(trackId, frame) {
      for (const cb of levelSubs) cb(trackId, frame);
    },
  };
}

function fakeTake(
  trackId: string,
  startSec: number,
  endSec: number,
  error?: RecordingError,
): Take {
  return {
    meta: {
      id: `take-${trackId}-${startSec}`,
      trackId,
      startSec,
      endSec,
      sampleRate: 48000,
      mime: 'audio/webm',
      ...(error ? { error } : {}),
    },
    blob: new Blob(['audio'], { type: 'audio/webm' }),
  };
}

/* --------------------------------- harness --------------------------------- */

interface Harness {
  engine: FakeEngine;
  events: string[];
  /** Transport seconds the engine's `now` reads. */
  setTransportSec(sec: number): void;
  /** Wall clock the level throttle reads. */
  setWallMs(ms: number): void;
  /** `null` = this press does not count in. */
  setCountInBars(bars: number): void;
  /** Make `beginCountIn` call `onDone` SYNCHRONOUSLY and still return a cancel,
   *  the way `MetronomeScheduler.countIn` does with no engine context or with a
   *  count that works out to no clicks. */
  setCountInSynchronous(on: boolean): void;
  /** Make `startTransport` a no-op that never sets `isPlaying` — `liveMixer`
   *  bailing on an empty project. */
  setTransportRefuses(on: boolean): void;
  /** What the fake decode reports the take's blob to be. */
  setDecodedDuration(sec: number): void;
  /** Finish the count-in in flight (the scheduler's `onDone`). */
  finishCountIn(): void;
  countInCancels: number;
  engineDeps: RecordingDeps | null;
}

/** A fresh store, a fresh fake engine, and a timeline with `trackIds` on it. */
function harness(trackIds: readonly string[] = []): Harness {
  resetRecording();
  // A clean document: one unarmed track, no clips, no history.
  useEditorStore.setState({
    tracks: trackIds.map((id, i) => ({
      id,
      name: `Track ${i + 1}`,
      nameAutoGenerated: false,
      volume: 0.8,
      pan: 0,
      mute: false,
      solo: false,
      color: `#00000${i}`,
    })),
    clips: [],
    _undo: [],
    _redo: [],
  });
  usePlayerStore.setState({ isPlaying: false });

  const events: string[] = [];
  const engine = fakeEngine(events);
  const h: Harness = {
    engine,
    events,
    setTransportSec: (sec) => { transportSec = sec; },
    setWallMs: (ms) => { wallMs = ms; },
    setCountInBars: (bars) => { countInBars = bars; },
    setCountInSynchronous: (on) => { countInSync = on; },
    setTransportRefuses: (on) => { transportRefuses = on; },
    setDecodedDuration: (sec) => { decodedDuration = sec; },
    finishCountIn: () => { countInDone?.(); countInDone = null; },
    countInCancels: 0,
    engineDeps: null,
  };
  let transportSec = 0;
  let wallMs = 0;
  let countInBars = 0;
  let countInSync = false;
  let transportRefuses = false;
  let decodedDuration = 1;
  let countInDone: (() => void) | null = null;

  setRecordingDeps({
    createEngine: (d) => { h.engineDeps = d; return engine; },
    engineEnv: {},
    transportSec: () => transportSec,
    nowMs: () => wallMs,
    startTransport: () => {
      events.push('transport');
      // `liveMixer.start()` returns before it ever sets this when the project
      // has no clips (or a decode throws), so the fake can refuse too.
      if (!transportRefuses) usePlayerStore.setState({ isPlaying: true });
    },
    beginCountIn: (onDone) => {
      if (countInBars <= 0) return null;
      if (countInSync) {
        // The scheduler's own shape on its two synchronous paths: `onDone` now,
        // and a NON-null cancel back.
        onDone();
        return () => { /* the real scheduler hands back a live cancel here */ };
      }
      countInDone = onDone;
      return () => { countInDone = null; };
    },
    cancelCountIn: () => { h.countInCancels += 1; },
    computePeaks: async () => ({ peaks: new Float32Array([0.5, 0.25]), duration: decodedDuration }),
  });
  initRecording();
  return h;
}

/* ------------------------------ the mic profile ---------------------------- */

// The store, not the engine, picks the profile: a PERFORMANCE is recorded flat.
{
  const audioOf = (c: MediaStreamConstraints): Record<string, unknown> =>
    c.audio as unknown as Record<string, unknown>;

  const musical = audioOf(musicalConstraints(micConstraints()));
  assert.equal(musical.echoCancellation, false);
  assert.equal(musical.noiseSuppression, false);
  assert.equal(musical.autoGainControl, false, 'AGC rides a crescendo flat — it must be off');

  // The device the engine asked for survives the rewrite.
  const named = audioOf(musicalConstraints(micConstraints('mic-7')));
  assert.equal(named.deviceId, 'mic-7');
  assert.equal(named.noiseSuppression, false);

  // The engine's own default is still the voice-memo profile — MicRecorder's.
  assert.equal(audioOf(micConstraints('mic-7')).autoGainControl, true);
}

/* --------------------------- the engine it builds -------------------------- */

// Built with the TRANSPORT clock as `now` (the take anchor) and with an input
// opener of the store's own, so the engine never falls back to the memo profile.
{
  resetRecording();
  let captured: RecordingDeps | null = null;
  let sec = 12.5;
  setRecordingDeps({
    createEngine: (d) => { captured = d; return fakeEngine([]); },
    transportSec: () => sec,
  });
  initRecording();
  const deps = captured as RecordingDeps | null;
  assert.ok(deps, 'the store builds its engine through the factory seam');
  assert.equal(deps!.now(), 12.5);
  sec = 30;
  assert.equal(deps!.now(), 30, '`now` is the live transport clock, not a snapshot');
  assert.equal(
    typeof deps!.getUserMedia,
    'function',
    'the store supplies the input opener, so the engine cannot use its own memo-profile default',
  );
}

/* ------------------------------ nothing armed ------------------------------ */

{
  const h = harness(['trk-a']);
  assert.deepEqual(rs().armedTrackIds, []);

  rs().recordPress();
  await flush();

  assert.equal(rs().status, 'idle', 'a press with nothing armed changes no state');
  assert.equal(rs().lastError?.code, 'nothing-armed');
  assert.ok(rs().lastError instanceof RecordingError);
  assert.equal(h.engine.calls.includes('start'), false, 'no input is opened');
  assert.deepEqual(h.events, [], 'and the transport is not touched');
}

/* ------------------------------- the arm mirror ---------------------------- */

{
  const h = harness(['trk-a', 'trk-b']);

  es().updateTrack('trk-a', { armed: true });
  assert.deepEqual(rs().armedTrackIds, ['trk-a'], 'the store mirrors editorStore, in track order');
  assert.deepEqual(h.engine.armed(), ['trk-a'], 'and arms the engine for it');

  es().updateTrack('trk-b', { armed: true });
  assert.deepEqual(rs().armedTrackIds, ['trk-a', 'trk-b']);
  assert.deepEqual(h.engine.armed(), ['trk-a', 'trk-b']);

  es().updateTrack('trk-a', { armed: false });
  assert.deepEqual(rs().armedTrackIds, ['trk-b']);
  assert.deepEqual(h.engine.armed(), ['trk-b'], 'a disarmed track is disarmed on the engine');

  // An unrelated track edit must not churn the engine.
  const before = h.engine.calls.length;
  es().updateTrack('trk-b', { volume: 0.5 });
  assert.equal(h.engine.calls.length, before, 're-arming an already-armed track is not re-issued');
  assert.deepEqual(rs().armedTrackIds, ['trk-b']);
}

/* --------------------- the press: engine first, then transport ------------- */

{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  h.setTransportSec(8);

  rs().recordPress();
  assert.equal(rs().status, 'recording', 'the key latches on the press, not on the device');
  await flush();
  assert.deepEqual(h.events, ['engine.start'], 'the transport is still where it was');

  h.engine.resolveStart();
  await flush();
  assert.deepEqual(
    h.events,
    ['engine.start', 'transport'],
    'the recorders are live BEFORE the clock moves, so the anchor is the playhead',
  );
  assert.equal(rs().status, 'recording');

  // Tidy up: stop the pass so the next block starts clean.
  h.engine.setTakes([]);
  rs().stopRecording();
  await flush();
  assert.equal(rs().status, 'idle');
}

/* -------------------------------- count-in --------------------------------- */

{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  h.setCountInBars(2);

  rs().recordPress();
  await flush();
  assert.equal(rs().status, 'counting');
  assert.deepEqual(h.events, [], 'nothing is opened and nothing moves during the count');

  // A second press during the count cancels it. Nothing was moved, so there is
  // nothing to undo — only the clicks to silence.
  rs().recordPress();
  await flush();
  assert.equal(rs().status, 'idle');
  assert.equal(h.countInCancels, 1, 'the count-in is cancelled through the metronome');
  assert.deepEqual(h.events, []);
  assert.equal(h.engine.calls.includes('start'), false);

  // And a count that runs to its end releases the pass.
  rs().recordPress();
  await flush();
  assert.equal(rs().status, 'counting');
  h.finishCountIn();
  await flush();
  assert.equal(rs().status, 'recording');
  assert.deepEqual(h.events, ['engine.start']);
  h.engine.resolveStart();
  await flush();
  assert.deepEqual(h.events, ['engine.start', 'transport']);

  h.engine.setTakes([]);
  rs().stopRecording();
  await flush();
}

/* -------------------- a count-in that releases synchronously --------------- */

// `MetronomeScheduler.countIn` calls `onDone` inline — and still returns a
// non-null cancel — when there is no engine context, and when the count works
// out to no clicks. `shouldCountIn` cannot see either from outside, so the
// press must not latch `counting` over a pass that is already rolling.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  h.setCountInBars(2);
  h.setCountInSynchronous(true);

  rs().recordPress();
  assert.equal(rs().status, 'recording', 'the release wins: the key says what the engine is doing');
  await flush();
  assert.deepEqual(h.events, ['engine.start'], 'and the pass really did start');
  h.engine.resolveStart();
  await flush();
  assert.deepEqual(h.events, ['engine.start', 'transport']);

  // The next press is therefore a STOP, not a cancel of a count that is not
  // running — which is what used to leave the engine rolling with the store
  // idle, and the press after that getting `busy`.
  h.engine.setTakes([fakeTake('trk-a', 0, 2)]);
  rs().recordPress();
  await flush();
  assert.equal(rs().status, 'idle');
  assert.equal(h.countInCancels, 0, 'nothing was cancelled — there was no count');
  assert.equal(h.engine.calls.filter((c) => c === 'stop').length, 1, 'the pass was stopped');
  assert.equal(h.engine.isRecording(), false, 'and the engine is not left rolling');
  assert.equal(es().clips.length, 1);
}

/* ------------------------------ stop: placement ---------------------------- */

{
  const h = harness(['trk-a', 'trk-b']);
  es().updateTrack('trk-a', { armed: true });
  es().updateTrack('trk-b', { armed: true });
  const undoDepth = () => (useEditorStore.getState() as unknown as { _undo: unknown[] })._undo.length;
  const depthBeforePass = undoDepth();

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();

  h.engine.setTakes([fakeTake('trk-a', 4, 6.5), fakeTake('trk-b', 4, 6.5)]);
  rs().stopRecording();
  assert.equal(rs().status, 'stopping');
  await flush();
  assert.equal(rs().status, 'idle');
  assert.deepEqual(rs().levels, {}, 'the meters go dark with the pass');

  const clips = es().clips;
  assert.equal(clips.length, 2, 'one clip per take');
  const a = clips.find((c) => c.trackId === 'trk-a')!;
  assert.equal(a.startSec, 4, 'the clip lands on the take\'s own anchor');
  assert.equal(a.durationSec, 2.5);
  assert.equal(a.sourceDuration, 2.5, 'a take IS its source');
  assert.equal(a.offsetIntoSource, 0);
  assert.equal(a.mimeType, 'audio/webm');
  assert.equal(a.audioBlob.size > 0, true, 'the bytes are on the clip');
  assert.deepEqual(clips.map((c) => c.label), ['Take 1', 'Take 2'], 'each pass numbers its takes');
  assert.equal(a.color, es().tracks.find((t) => t.id === 'trk-a')!.color, 'the clip takes its track\'s colour');

  // Peaks are decoded afterwards and cached onto the clip.
  await flush();
  assert.equal(es().clips.find((c) => c.id === a.id)?.peaks?.length, 2);

  // ONE undo step for the whole pass: one undo takes BOTH takes off, and the
  // track it was recorded on is still armed (the pass did not fold into the
  // arm flip that happened moments before it).
  assert.equal(undoDepth(), depthBeforePass + 1, 'the pass is a single undo step');
  es().undo();
  assert.equal(es().clips.length, 0, 'one undo takes the whole pass back off the timeline');
  assert.equal(es().tracks.find((t) => t.id === 'trk-a')?.armed, true, 'and leaves the arm alone');
}

/* ------------------ a take whose clock never moved is repaired ------------- */

// The FIRST take of every new project: `liveMixer.start()` bails on an empty
// timeline, so `isPlaying` never sets, `currentTransportSec()` stays on the
// stationary playhead and the take reads `endSec === startSec`. The bytes know
// their own length, so the decode repairs the clip.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  h.setTransportRefuses(true);
  h.setDecodedDuration(3.2);

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();

  h.engine.setTakes([fakeTake('trk-a', 5, 5)]); // the clock never moved
  rs().stopRecording();
  await flush();
  await flush();

  const clip = es().clips[0];
  assert.ok(clip, 'the take still lands');
  assert.equal(clip.startSec, 5, 'the ANCHOR was never in doubt — only the length');
  assert.equal(clip.durationSec, 3.2, 'the length comes from the decode');
  assert.equal(clip.sourceDuration, 3.2);
  assert.equal(clip.peaks?.length, 2, 'and the peaks land in the same write');
  // History-exempt: the pass is still one undo step, and one undo clears it.
  es().undo();
  assert.equal(es().clips.length, 0);
}

// The loop-region case is the same repair: `currentTransportSec()` rewinds at
// `loopEnd`, so a take that runs past it ends EARLIER than it began and
// `takeClipPlacement` floors the length at 0.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  h.setDecodedDuration(7.5);

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();

  h.engine.setTakes([fakeTake('trk-a', 9, 1)]); // wrapped at loopEnd
  rs().stopRecording();
  await flush();
  await flush();

  const clip = es().clips[0];
  assert.equal(clip.startSec, 9);
  assert.equal(clip.durationSec, 7.5, 'a wrapped clock is repaired from the decode too');
  assert.equal(clip.sourceDuration, 7.5);
}

// A take the clock DID measure is never overwritten by the decode — the user
// may have trimmed the clip in the moments the decode took.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  h.setDecodedDuration(99);

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();

  h.engine.setTakes([fakeTake('trk-a', 2, 6)]);
  rs().stopRecording();
  await flush();
  await flush();

  const clip = es().clips[0];
  assert.equal(clip.durationSec, 4, 'the measured length stands');
  assert.equal(clip.sourceDuration, 4);
  assert.equal(clip.peaks?.length, 2, 'peaks still cached');
}

/* ------------------------- a faulted take still lands ---------------------- */

{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();

  const fault = new RecordingError('unsupported', 'The recorder faulted mid-take: boom');
  h.engine.setTakes([fakeTake('trk-a', 1, 3, fault)]);
  rs().stopRecording();
  await flush();

  assert.equal(es().clips.length, 1, 'the audio it did gather is still delivered');
  assert.equal(rs().lastError, fault, 'and the fault is flagged beside it');
  assert.equal(rs().status, 'idle');
}

/* ---------------------- the transport stops the recording ------------------ */

{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();
  assert.equal(rs().status, 'recording');

  h.engine.setTakes([fakeTake('trk-a', 0, 2)]);
  // What liveMixer's `pause` / `stop` publish.
  usePlayerStore.setState({ isPlaying: false });
  await flush();

  assert.equal(rs().status, 'idle', 'a take cannot outlive the clock it is anchored to');
  assert.equal(h.engine.calls.filter((c) => c === 'stop').length, 1);
  assert.equal(es().clips.length, 1, 'and the pass is still laid down');
}

/* ------------------------------- busy / failure ---------------------------- */

{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });

  rs().recordPress();
  await flush();
  h.engine.rejectStart(new RecordingError('busy'));
  await flush();

  assert.equal(rs().status, 'idle', 'a refused start leaves nothing latched');
  assert.equal(rs().lastError?.code, 'busy');
  assert.deepEqual(h.events, ['engine.start'], 'and never releases the transport');

  // A non-RecordingError is wrapped, not re-thrown.
  rs().recordPress();
  await flush();
  h.engine.rejectStart(new TypeError('something else entirely'));
  await flush();
  assert.equal(rs().status, 'idle');
  assert.ok(rs().lastError instanceof RecordingError);
  assert.match(rs().lastError!.message, /something else entirely/);
}

/* --------------------- a stop that lands while starting -------------------- */

{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });

  rs().recordPress();
  await flush();
  // The inputs are still opening.
  rs().recordPress();
  await flush();
  assert.equal(rs().status, 'stopping');
  assert.equal(h.engine.calls.includes('stop'), false, 'an engine with nothing in it is not stopped');

  h.engine.setTakes([fakeTake('trk-a', 0, 1)]);
  h.engine.resolveStart();
  await flush();

  assert.equal(rs().status, 'idle');
  assert.equal(h.engine.calls.filter((c) => c === 'stop').length, 1, 'the stop runs once the recorders are live');
  assert.equal(
    h.events.includes('transport'),
    false,
    'a pass stopped before it ran never releases the transport',
  );
  assert.equal(es().clips.length, 1);
}

/* ------------------------------- level throttle ---------------------------- */

{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();

  let writes = 0;
  const off = useRecordingStore.subscribe(() => { writes += 1; });

  h.setWallMs(1000);
  h.engine.emitLevel('trk-a', { peak: 0.5, rms: 0.25 });
  assert.equal(writes, 1, 'the first frame of a window is written through');
  assert.deepEqual(rs().levels['trk-a'], { peak: 0.5, rms: 0.25 });

  // Inside the window every further frame is coalesced away.
  h.setWallMs(1000 + LEVEL_WRITE_MS - 1);
  h.engine.emitLevel('trk-a', { peak: 0.9, rms: 0.4 });
  assert.equal(writes, 1, `no more than one write per ${LEVEL_WRITE_MS}ms`);
  assert.deepEqual(rs().levels['trk-a'], { peak: 0.5, rms: 0.25 });

  // The window closes and the latest frame lands.
  h.setWallMs(1000 + LEVEL_WRITE_MS);
  h.engine.emitLevel('trk-a', { peak: 0.8, rms: 0.3 });
  assert.equal(writes, 2);
  assert.deepEqual(rs().levels['trk-a'], { peak: 0.8, rms: 0.3 });

  off();
  h.engine.setTakes([]);
  rs().stopRecording();
  await flush();
  assert.deepEqual(rs().levels, {});
}

resetRecording();
console.log('recordingStore: ok');
