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
  mergeRecordingPrefs,
  setRecordingPrefsStorage,
  useRecordingPrefs,
  useRecordingStore,
} from './recordingStore.ts';

/** Let every queued microtask run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

const rs = () => useRecordingStore.getState();
const rp = () => useRecordingPrefs.getState();
const es = () => useEditorStore.getState();

/* --------------------------- the preference storage ------------------------ */

// Installed FIRST, before any block picks a mode: node has no `localStorage`,
// so the real one would warn on every write. Counting `setItem` here is also
// what pins that the HOT store never reaches storage — see the block at the end.
const storageKeys: string[] = [];
const fakeStorage: Record<string, string> = {};
setRecordingPrefsStorage({
  getItem: (k) => fakeStorage[k] ?? null,
  setItem: (k, v) => { storageKeys.push(k); fakeStorage[k] = v; },
  removeItem: (k) => { delete fakeStorage[k]; },
});

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
    // No loop region, so the punch gate is inert unless a block sets one.
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 0,
  });
  usePlayerStore.setState({ isPlaying: false });
  // `punch` is a PERSISTED preference, so `resetRecording()` deliberately
  // leaves it alone — the harness is what returns it to the default.
  useRecordingPrefs.setState({ punch: 'off' });

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

/* --------------------------- punch in / punch out -------------------------- */

/** One whole pass: press, let the recorders open, hand back `takes`, stop, and
 *  let the decode that follows the placement settle. */
async function pass(h: Harness, takes: Take[]): Promise<void> {
  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();
  h.engine.setTakes(takes);
  rs().stopRecording();
  await flush();
  await flush();
}

/** The editor's loop region IS the punch region — there is no second owner. */
function setLoop(start: number, end: number): void {
  es().setLoopRegion(start, end);
  assert.equal(es().loopEnabled, true, 'the fixture loop is long enough to enable');
}

// The default, and the only value a bad one falls back to.
{
  const h = harness([]);
  void h;
  assert.equal(rp().punch, 'off', 'punch is off until asked for');
  rp().setPunch('in-out');
  assert.equal(rp().punch, 'in-out');
  rp().setPunch('nonsense' as never);
  assert.equal(rp().punch, 'off', 'an unknown mode is not a mode');
}

// `in-out`: the take is cropped to BOTH edges of the loop region. The bytes are
// untouched — the clip keeps the whole take as its source and slides its window
// in with `offsetIntoSource`.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');

  await pass(h, [fakeTake('trk-a', 2, 12)]);

  const clip = es().clips[0];
  assert.ok(clip, 'a take that overlaps the window still lands');
  assert.equal(clip.startSec, 4, 'the clip starts at loopStart');
  assert.equal(clip.durationSec, 6, 'and ends at loopEnd');
  assert.equal(clip.offsetIntoSource, 2, 'the head outside the window is trimmed, not discarded');
  assert.equal(clip.sourceDuration, 10, 'the SOURCE is still the whole pass');
  assert.equal(clip.audioBlob.size > 0, true);
}

// `in`: the lower edge only — recording starts at loopStart and runs on past
// loopEnd to wherever the pass was stopped.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in');

  await pass(h, [fakeTake('trk-a', 2, 12)]);

  const clip = es().clips[0];
  assert.equal(clip.startSec, 4);
  assert.equal(clip.durationSec, 8, 'punch in does not punch out');
  assert.equal(clip.offsetIntoSource, 2);
  assert.equal(clip.sourceDuration, 10);
}

// `out`: the upper edge only — the take keeps its own anchor and is cut at
// loopEnd.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('out');

  await pass(h, [fakeTake('trk-a', 2, 12)]);

  const clip = es().clips[0];
  assert.equal(clip.startSec, 2, 'punch out does not punch in');
  assert.equal(clip.durationSec, 8);
  assert.equal(clip.offsetIntoSource, 0, 'nothing is trimmed off the front');
  assert.equal(clip.sourceDuration, 10);
}

// A take wholly INSIDE the window is passed through untouched.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');

  await pass(h, [fakeTake('trk-a', 5, 8)]);

  const clip = es().clips[0];
  assert.equal(clip.startSec, 5);
  assert.equal(clip.durationSec, 3);
  assert.equal(clip.offsetIntoSource, 0);
}

// A take wholly OUTSIDE it is dropped, and takes no take number with it.
{
  const h = harness(['trk-a', 'trk-b']);
  es().updateTrack('trk-a', { armed: true });
  es().updateTrack('trk-b', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');

  await pass(h, [fakeTake('trk-a', 12, 14), fakeTake('trk-b', 6, 9)]);

  const clips = es().clips;
  assert.equal(clips.length, 1, 'the take outside the window never becomes a clip');
  assert.equal(clips[0].trackId, 'trk-b');
  assert.equal(clips[0].label, 'Take 1', 'a dropped take does not burn a take number');
}

// Punch armed with NO loop region: the press records normally and says so. The
// pass is not refused and the status never leaves its ordinary path.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  es().clearLoop();
  rp().setPunch('in-out');

  await pass(h, [fakeTake('trk-a', 2, 12)]);

  assert.match(
    rs().lastNotice?.text ?? '',
    /punch ignored: no loop region/i,
    'the press explains why the punch did nothing',
  );
  assert.equal(rs().lastError, null, 'nothing FAILED — the notice is informational');
  assert.equal(rs().status, 'idle');
  const clip = es().clips[0];
  assert.ok(clip, 'and the pass is recorded whole');
  assert.equal(clip.startSec, 2);
  assert.equal(clip.durationSec, 10);
  assert.equal(clip.offsetIntoSource, 0);

  // Give it a region and the notice goes away on the next press — it describes
  // THAT press, like `lastError`, not a setting that is stuck wrong.
  setLoop(4, 10);
  await pass(h, [fakeTake('trk-a', 2, 12)]);
  assert.equal(rs().lastNotice, null, 'the notice is cleared by the press that no longer needs it');
  assert.equal(es().clips[1].durationSec, 6, 'and that press punched');
}

// THE WRAP RULE. One press is one take per armed track — the engine records the
// whole pass as a single blob however many times the transport rewound at
// `loopEnd` — so a pass that wraps yields ONE clip, never one per lap. Its
// CLOCK is the wrapped one T12b-a repairs (`endSec` lands earlier than
// `startSec`), and a clock that rewound cannot bound a window: the take is
// repaired from the decode and left UNCROPPED, exactly as with punch off.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');
  h.setDecodedDuration(7.5);

  await pass(h, [fakeTake('trk-a', 9, 1)]);

  const clips = es().clips;
  assert.equal(clips.length, 1, 'one pass, one take, one clip');
  assert.equal(clips[0].startSec, 9, 'the anchor was never in doubt');
  assert.equal(clips[0].durationSec, 7.5, 'the T12b-a repair still owns the length');
  assert.equal(clips[0].sourceDuration, 7.5);
  assert.equal(clips[0].offsetIntoSource, 0, 'an unmeasured take is never cropped');
}

// Two presses are two takes, and each pass is still exactly one undo step.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');
  const undoDepth = () => (useEditorStore.getState() as unknown as { _undo: unknown[] })._undo.length;

  const before = undoDepth();
  await pass(h, [fakeTake('trk-a', 2, 12)]);
  assert.equal(undoDepth(), before + 1, 'a punched pass is one undo step');
  await pass(h, [fakeTake('trk-a', 3, 11)]);
  assert.equal(es().clips.length, 2, 'two passes, two takes');
  assert.equal(undoDepth(), before + 2);

  es().undo();
  assert.equal(es().clips.length, 1, 'one undo takes the LAST pass off, and only it');
  assert.equal(es().clips[0].label, 'Take 1');
}

// Punch OFF with a loop region up: nothing is cropped.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);

  await pass(h, [fakeTake('trk-a', 2, 12)]);

  const clip = es().clips[0];
  assert.equal(clip.startSec, 2, 'punch off is punch off, loop region or not');
  assert.equal(clip.durationSec, 10);
  assert.equal(clip.offsetIntoSource, 0);
  assert.equal(rs().lastError, null, 'and there is nothing to say about it');
  assert.equal(rs().lastNotice, null);
}

// THE WINDOW IS THE PRESS'S. Dragging the loop region — or changing the mode —
// while the recorders are rolling must not reach back and re-cut a take that
// was recorded under the old window.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();
  // Mid-pass: the user drags the loop somewhere else and switches the mode off.
  setLoop(20, 30);
  rp().setPunch('off');
  h.engine.setTakes([fakeTake('trk-a', 2, 12)]);
  rs().stopRecording();
  await flush();
  await flush();

  const clip = es().clips[0];
  assert.equal(clip.startSec, 4, 'the crop is the window the press was made with');
  assert.equal(clip.durationSec, 6);
  assert.equal(clip.offsetIntoSource, 2);
}

// A pass the window kept NOTHING of does not vanish in silence.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');

  await pass(h, [fakeTake('trk-a', 12, 14)]);

  assert.equal(es().clips.length, 0, 'nothing lands');
  assert.match(rs().lastNotice?.text ?? '', /punch window empty/i, 'and the store says why');
  assert.equal(rs().lastError, null, 'still not a failure');
}

// The SAME notice twice is two notices: a value-keyed consumer (the footer's
// effect) must re-post, so the text alone is not the identity.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  es().clearLoop();
  rp().setPunch('in-out');

  await pass(h, [fakeTake('trk-a', 0, 1)]);
  const first = rs().lastNotice;
  await pass(h, [fakeTake('trk-a', 2, 3)]);
  const second = rs().lastNotice;

  assert.equal(first?.text, second?.text, 'the same thing happened twice');
  assert.notEqual(first?.seq, second?.seq, 'and it is reported twice');
  assert.notEqual(first, second, 'a fresh object, so an identity-keyed effect refires');
}

// A press with nothing armed clears a notice the previous press left behind —
// it describes THAT press, and this one did not even open an input.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  es().clearLoop();
  rp().setPunch('in-out');
  await pass(h, [fakeTake('trk-a', 0, 1)]);
  assert.ok(rs().lastNotice, 'the notice is up');

  es().updateTrack('trk-a', { armed: false });
  rs().recordPress();
  await flush();
  assert.equal(rs().lastError?.code, 'nothing-armed');
  assert.equal(rs().lastNotice, null, 'and the stale notice went with it');
}

/* ---------------- the preference is NOT on the hot store ------------------- */

// `persist` replaces `setState`, so persisting the hot store would serialise it
// and hit storage on every meter frame — 20 writes a second per pass — and a
// storage that throws would throw out of `recordPress`. The preference lives in
// its own store; this pins that the hot one never reaches storage.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();

  const before = storageKeys.length;
  for (let i = 0; i < 40; i += 1) {
    h.setWallMs(10_000 + i * LEVEL_WRITE_MS);
    h.engine.emitLevel('trk-a', { peak: i / 40, rms: i / 80 });
  }
  assert.ok(rs().levels['trk-a'], 'the frames really did reach the store');
  rs().stopRecording();
  await flush();
  assert.equal(
    storageKeys.length,
    before,
    'a pass — meters, status flips, the placement and all — writes no storage',
  );

  // The preference itself still persists, which is what proves the counter works.
  rp().setPunch('in-out');
  assert.equal(storageKeys.length, before + 1, 'picking a mode is the only thing that does');
  assert.equal(storageKeys[storageKeys.length - 1], 'thedaw-recording-prefs');
  rp().setPunch('off');
}

// A persisted value this build does not know hydrates to `off` — never to a
// window nothing can compute.
// `mergeRecordingPrefs` IS the hydrate — it is the store's `merge` option — so
// it is pinned directly. zustand 5.0.15 attaches no `persist` api to the store
// (only setState / getState / getInitialState / subscribe), so its own hydrate
// cannot be re-run from out here.
{
  const base = { punch: 'in-out' as const, setPunch: rp().setPunch };
  assert.equal(mergeRecordingPrefs({ punch: 'sideways' }, base).punch, 'off', 'an unknown persisted mode is not a mode');
  assert.equal(mergeRecordingPrefs({ punch: 42 }, base).punch, 'off');
  assert.equal(mergeRecordingPrefs(null, base).punch, 'off', 'nothing persisted is off, not undefined');
  assert.equal(mergeRecordingPrefs({}, base).punch, 'off');
  // A good one survives, and the actions on `current` are kept.
  const good = mergeRecordingPrefs({ punch: 'out' }, base);
  assert.equal(good.punch, 'out');
  assert.equal(typeof good.setPunch, 'function', 'hydrating does not drop the actions');
}

resetRecording();
console.log('recordingStore: ok');
