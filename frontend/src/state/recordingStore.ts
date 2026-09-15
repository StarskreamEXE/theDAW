/**
 * recordingStore — the one `recordingEngine` instance, wired to the transport.
 *
 * `lib/recordingEngine.ts` shipped with no caller: it opens recorders, anchors
 * every take to the TRANSPORT second its `start` event landed on, and hands
 * takes back. It touches no store and draws nothing. This file is the seam
 * where it meets the app: arming, the record press, the count-in, the transport
 * and the clips the pass leaves behind.
 *
 * Who owns what
 * -------------
 *   - ARMING is owned HERE, not by the UI. `editorStore` already has the
 *     `armed` flag on a track (the red dot in the track header); this store
 *     subscribes to it and calls `engine.arm` / `engine.disarm` as the flag
 *     flips. A track is armed by flipping that flag and by nothing else, so the
 *     arm button, a project load and a script all arm identically.
 *   - The MIC PROFILE is owned here too. `micConstraints()` defaults to
 *     MicRecorder's voice-memo chain (echo cancellation, noise suppression and
 *     AGC all ON) because that is what a memo wants. A PERFORMANCE does not:
 *     AGC rides a crescendo flat, noise suppression gates a quiet tail and echo
 *     cancellation ducks a sustained tone. So the store supplies the engine's
 *     `getUserMedia` seam and rebuilds whatever constraints the engine asked
 *     for with `micConstraints({ musical: true })` on the way to the device —
 *     the seam exists precisely so the HOST picks the profile.
 *   - PLACEMENT is owned here: `takeClipPlacement` turns a take into clip
 *     coordinates and `editorStore.addClipToTrack` is given the same field set
 *     `lib/sendToTargets.ts:sendAudioToEditor` fills in, peaks included.
 *
 * Order of the press
 * ------------------
 * `engine.start()` resolves only once every recorder's `start` event has landed
 * — that event is what stamps the take — and the transport is started AFTER it.
 * `liveMixer.currentTransportSec()` returns `editorStore.playheadSec` while the
 * transport is stopped, so a take whose `onstart` lands before `play()` is
 * stamped at the playhead: recording from bar 9 puts the take at bar 9, which
 * is the wanted answer and the whole point of the anchor. Starting the
 * transport first would instead race the device open against a clock that is
 * already moving and lose the head of the take.
 *
 * When the clock does not move
 * ----------------------------
 * The anchor is right; the LENGTH is the part that can go wrong, because it is
 * `endSec - startSec` off that same clock. Three ways the clock refuses, and
 * one repair for all of them:
 *
 *   - an EMPTY project. `liveMixer.start()` returns at once when there are no
 *     clips, so `isPlaying` never turns on and `currentTransportSec()` reads
 *     the stationary playhead for the whole take: `endSec === startSec`. That
 *     is the FIRST take of every new project, so it is the common case, not an
 *     edge one.
 *   - any other early bail in `start()` (a decode that throws), for the same
 *     reason.
 *   - a LOOP region. `currentTransportSec()` rewinds at `loopEnd`, so a take
 *     that runs past it ends EARLIER on the clock than it began and
 *     `takeClipPlacement` floors the length at 0.
 *
 * In every one of them the recorded bytes are fine and know their own length,
 * so `placeTakes` repairs the clip from the decode: `computePeaks` hands back
 * the blob's duration and `applyClipRender` writes it in. That write is
 * history-exempt, so the pass is still ONE undo step.
 *
 * Seams
 * -----
 * Every outside reach is a `RecordingStoreDeps` entry with a real default, and
 * the engine itself arrives through a FACTORY (`createEngine`) so a test drives
 * the whole press with `recordingEngine.test.ts`-style fakes and never opens a
 * microphone, an `AudioContext` or a count-in scheduler.
 *
 * Nothing here is copied from any reference DAW under `oss-refs/`.
 */

import { create } from 'zustand';
import {
  RecordingError,
  createRecordingEngine,
  micConstraints,
  takeClipPlacement,
  type LevelFrame,
  type RecordingDeps,
  type RecordingEngine,
  type Take,
} from '../lib/recordingEngine';
import { beginUndoStep, computePeaks, useEditorStore } from './editorStore';
import { usePlayerStore } from './playerStore';
import { currentTransportSec } from './liveMixer';
import {
  cancelMetronomeCountIn,
  metronomeCountIn,
  shouldCountIn,
  useMetronomeStore,
} from './metronomeStore';
import { callEditorPlay } from './editorPlaybackBridge';
import { EDITOR_TIMELINE_ID } from '../components/audio/trackMenuModel';

/* -------------------------------------------------------------------------- */
/*                                   types                                    */
/* -------------------------------------------------------------------------- */

/**
 * `idle` -> `counting` (only when the metronome is counting this press in) ->
 * `recording` -> `stopping` -> `idle`. The footer's RECORD key is latched for
 * every state but `idle`, and a press in any of them stops instead of starting.
 */
export type RecordingStatus = 'idle' | 'counting' | 'recording' | 'stopping';

export interface RecordingStoreState {
  status: RecordingStatus;
  /** Record-armed track ids, mirroring `editorStore`'s `armed` flags in order. */
  armedTrackIds: string[];
  /** Latest meter frame per armed track, written at most every
   *  `LEVEL_WRITE_MS`. Emptied when a pass ends. */
  levels: Record<string, LevelFrame>;
  /** The last failure, for the footer to surface. A fresh object every time, so
   *  the same failure twice is still two notices. */
  lastError: RecordingError | null;
  /** Start a pass, or stop the one running. Never throws. */
  recordPress: () => void;
  /** Stop a pass (or cancel a count-in). Never throws. */
  stopRecording: () => void;
  clearError: () => void;
}

/** Everything this store reaches outside itself. Every entry has a real default. */
export interface RecordingStoreDeps {
  /** THE factory seam: how the one engine is built. */
  createEngine: (deps: RecordingDeps) => RecordingEngine;
  /** What the engine is built with, bar `now` (which is `transportSec`). */
  engineEnv: Omit<RecordingDeps, 'now'>;
  /** Transport seconds — `liveMixer.currentTransportSec`. */
  transportSec: () => number;
  /** Wall clock, for the level write throttle only. */
  nowMs: () => number;
  /** Start the EDIT transport. Mirrors `PlayerFooter`'s own `startTransport`. */
  startTransport: () => void;
  /** Is the transport rolling right now? */
  isTransportPlaying: () => boolean;
  /** Transport playing changes. Returns an unsubscribe. */
  subscribeTransport: (cb: (playing: boolean) => void) => () => void;
  /** Record-armed track ids, in track order. */
  armedTrackIds: () => string[];
  /** Arm-flag changes. Returns an unsubscribe. */
  subscribeArmed: (cb: (ids: string[]) => void) => () => void;
  /** Play the count-in and call `onDone` at its end, returning the cancel — or
   *  `null` when THIS press does not count in, in which case `onDone` is not
   *  called and the caller starts at once. */
  beginCountIn: (onDone: () => void) => (() => void) | null;
  /** Silence a count-in in flight. */
  cancelCountIn: () => void;
  /** Waveform peaks for a placed take. */
  computePeaks: (blob: Blob, bins?: number) => Promise<{ peaks: Float32Array; duration: number }>;
}

/* -------------------------------------------------------------------------- */
/*                                 constants                                  */
/* -------------------------------------------------------------------------- */

/**
 * How often the meter frames reach the STORE. The engine feeds them at
 * `RECORDING_LEVEL_INTERVAL_MS` (40 ms, 25 Hz) per armed track; a zustand write
 * per track per frame would re-render every subscriber 25 times a second per
 * track. Coalescing to one write per 50 ms keeps the meter above the 20 Hz a
 * meter needs while the store settles at 20 writes a second however many tracks
 * are armed.
 */
export const LEVEL_WRITE_MS = 50;

/** Peak bins per placed take — `sendToTargets.sendAudioToEditor`'s number. */
const TAKE_PEAK_BINS = 240;

/** The colour a clip falls back to, as in `sendToTargets.sendAudioToEditor`. */
const FALLBACK_CLIP_COLOR = '#8b5cf6';

/* -------------------------------------------------------------------------- */
/*                              the mic profile                               */
/* -------------------------------------------------------------------------- */

/**
 * Rebuild constraints the engine asked for with the MUSICAL profile, keeping
 * whatever device it named. Exported because it is the whole of the store's mic
 * policy and is worth reading (and testing) on its own.
 *
 * The device id is the ONLY field carried over, which is the whole of what
 * `openGroup` — the single caller today — asks for: it builds its constraints
 * with `micConstraints(source.deviceId)`, so `deviceId` plus the three
 * processors IS the object. Anything else a future caller puts in `audio` would
 * be dropped here; widen this the day there is one.
 */
export function musicalConstraints(asked: MediaStreamConstraints): MediaStreamConstraints {
  const audio = asked.audio;
  const deviceId =
    audio && typeof audio === 'object' && typeof (audio as MediaTrackConstraints).deviceId === 'string'
      ? ((audio as MediaTrackConstraints).deviceId as string)
      : undefined;
  return micConstraints({ deviceId, musical: true });
}

function realGetUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(
      new RecordingError('unsupported', 'getUserMedia is not available in this browser.'),
    );
  }
  return navigator.mediaDevices.getUserMedia(musicalConstraints(constraints));
}

/* -------------------------------------------------------------------------- */
/*                               real defaults                                */
/* -------------------------------------------------------------------------- */

/** The armed ids, in track order, so a take batch reads top-down. */
function armedIdsFromEditor(): string[] {
  return useEditorStore
    .getState()
    .tracks.filter((t) => t.armed === true)
    .map((t) => t.id);
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

const defaultDeps: RecordingStoreDeps = {
  createEngine: createRecordingEngine,
  engineEnv: { getUserMedia: realGetUserMedia },
  transportSec: currentTransportSec,
  nowMs: () => Date.now(),
  // The same branch `PlayerFooter`'s own `startTransport` takes: the EDIT
  // timeline has to be RENDERED into the player before the footer's toggle can
  // drive it, and `callEditorPlay` is what does that. A transport already
  // rolling is left alone — a record press must never pause it.
  startTransport: () => {
    const player = usePlayerStore.getState();
    if (player.isPlaying) return;
    if (player.currentEntryId !== EDITOR_TIMELINE_ID) callEditorPlay();
    else player.toggle();
  },
  // liveMixer has no subscription of its own, but it PUBLISHES its playing
  // state: `play` / `pause` / `stop` all write `usePlayerStore.isPlaying`.
  isTransportPlaying: () => usePlayerStore.getState().isPlaying,
  subscribeTransport: (cb) =>
    usePlayerStore.subscribe((s, prev) => {
      if (s.isPlaying !== prev.isPlaying) cb(s.isPlaying);
    }),
  armedTrackIds: armedIdsFromEditor,
  subscribeArmed: (cb) =>
    useEditorStore.subscribe((s, prev) => {
      if (s.tracks === prev.tracks) return;
      cb(armedIdsFromEditor());
    }),
  // `shouldCountIn` is asked FIRST so a press that does not count in never
  // reaches the scheduler (which would call `onDone` synchronously and hand
  // back a no-op cancel that the caller could not tell from a real one).
  // `editor: true` / `playing: false`: a record press only ever exists on EDIT,
  // and it only ever starts.
  beginCountIn: (onDone) => {
    const { countInBars: bars, enabled } = useMetronomeStore.getState();
    if (!shouldCountIn({ editor: true, playing: false, bars, enabled })) return null;
    return metronomeCountIn(onDone, { editor: true, playing: false });
  },
  cancelCountIn: cancelMetronomeCountIn,
  computePeaks: (blob, bins) => computePeaks(blob, bins),
};

let deps: RecordingStoreDeps = { ...defaultDeps };

/**
 * Replace some of the outside reaches. For the tests, and for a host that has
 * to drive a different transport. Takes effect on the next `initRecording()`;
 * call `resetRecording()` first if the service is already up.
 */
export function setRecordingDeps(partial: Partial<RecordingStoreDeps>): void {
  deps = { ...deps, ...partial };
}

/* -------------------------------------------------------------------------- */
/*                                 the store                                  */
/* -------------------------------------------------------------------------- */

let engine: RecordingEngine | null = null;
let subscriptions: Array<() => void> = [];
let started = false;
/** The cancel of the count-in in flight, if any. */
let countInCancel: (() => void) | null = null;
/** True from the record press until `engine.start()` settles. */
let startInFlight = false;
/** A stop that arrived while `start()` was still in flight. */
let stopPending = false;
/** Did the transport actually roll for the pass being placed? When it did not,
 *  the take's clock never moved and its length has to come from the decode
 *  instead — see the header. */
let transportRolled = false;
/** Take numbering, for the clip labels. Session-wide and monotonic, so two
 *  passes never both call their clip "Take 1". */
let takeSeq = 0;
let pendingLevels: Record<string, LevelFrame> = {};
let lastLevelWrite = 0;

const st = () => useRecordingStore.getState();
const setState = (patch: Partial<RecordingStoreState>): void => useRecordingStore.setState(patch);

const asRecordingError = (e: unknown): RecordingError =>
  e instanceof RecordingError
    ? e
    : new RecordingError('unsupported', e instanceof Error ? e.message : String(e), e);

function getEngine(): RecordingEngine {
  if (engine) return engine;
  engine = deps.createEngine({ ...deps.engineEnv, now: deps.transportSec });
  subscriptions.push(
    engine.onLevel((trackId, frame) => {
      pendingLevels[trackId] = frame;
      const now = deps.nowMs();
      if (now - lastLevelWrite < LEVEL_WRITE_MS) return;
      lastLevelWrite = now;
      setState({ levels: { ...st().levels, ...pendingLevels } });
      pendingLevels = {};
    }),
  );
  return engine;
}

/** Mirror `ids` onto the engine's armed set, and onto the store. */
function syncArmed(ids: readonly string[]): void {
  const e = getEngine();
  const want = new Set(ids);
  for (const id of e.armed()) if (!want.has(id)) e.disarm(id);
  const have = new Set(e.armed());
  for (const id of ids) if (!have.has(id)) e.arm(id, { kind: 'mic' });
  if (!sameIds(st().armedTrackIds, ids)) setState({ armedTrackIds: [...ids] });
}

/** Open the recorders, then release the transport. Never rejects. */
async function beginPass(): Promise<void> {
  const e = getEngine();
  startInFlight = true;
  stopPending = false;
  transportRolled = false;
  try {
    await e.start();
  } catch (err) {
    startInFlight = false;
    setState({ status: 'idle', lastError: asRecordingError(err), levels: {} });
    pendingLevels = {};
    return;
  }
  startInFlight = false;
  // A press that arrived while the inputs were opening: the recorders are live
  // NOW, so this is where that stop actually runs. Without it the engine would
  // be left recording with nothing able to stop it.
  if (stopPending) {
    stopPending = false;
    await finishPass();
    return;
  }
  deps.startTransport();
  // Asked AFTER the call rather than assumed from it: `liveMixer.start()` bails
  // on an empty (or undecodable) project and leaves `isPlaying` false, which is
  // precisely the pass whose take needs repairing.
  transportRolled = deps.isTransportPlaying();
}

/** Stop the recorders and lay the takes down. Never rejects. */
async function finishPass(): Promise<void> {
  setState({ status: 'stopping' });
  let takes: Take[] = [];
  try {
    takes = await getEngine().stop();
  } catch (err) {
    setState({ lastError: asRecordingError(err) });
  }
  placeTakes(takes);
  pendingLevels = {};
  setState({ status: 'idle', levels: {} });
}

/**
 * Every take of ONE pass onto the timeline as ONE undo step.
 *
 * `beginUndoStep()` cuts the coalescing burst so the next document change opens
 * a fresh step; the adds that follow are synchronous, so they fold into that
 * one step and a single undo takes the whole pass back off the timeline.
 *
 * `sourceDuration` is the take's own length: a take IS its source, nothing is
 * trimmed off its front (`offsetIntoSource` is 0 by definition) and nothing
 * follows its end. Peaks are decoded afterwards and cached onto the clip — a
 * decode that fails costs the waveform drawing, never the take.
 *
 * That same decode is the repair for a take whose CLOCK never moved (see the
 * header): a zero length, or a pass whose transport never rolled, takes its
 * length from the blob instead. The repair is deliberately narrow — a clip the
 * clock measured correctly is never overwritten, because the user may have
 * trimmed it in the moments the decode took.
 */
function placeTakes(takes: readonly Take[]): void {
  if (takes.length === 0) return;
  beginUndoStep();
  let faulted: RecordingError | null = null;
  for (const take of takes) {
    if (take.meta.error) faulted = take.meta.error;
    const place = takeClipPlacement(take);
    const editor = useEditorStore.getState();
    if (!editor.tracks.some((t) => t.id === place.trackId)) continue; // the track was deleted mid-pass
    const color = editor.tracks.find((t) => t.id === place.trackId)?.color ?? FALLBACK_CLIP_COLOR;
    takeSeq += 1;
    const measured = place.durationSec > 0 && transportRolled;
    const clipId = editor.addClipToTrack({
      trackId: place.trackId,
      label: `Take ${takeSeq}`,
      audioBlob: take.blob,
      mimeType: take.meta.mime,
      sourceDuration: place.durationSec,
      offsetIntoSource: place.offsetIntoSource,
      durationSec: place.durationSec,
      startSec: place.startSec,
      color,
    });
    void deps
      .computePeaks(take.blob, TAKE_PEAK_BINS)
      .then(({ peaks, duration }) => {
        const store = useEditorStore.getState();
        if (!measured && Number.isFinite(duration) && duration > 0) {
          // `applyClipRender` is history-exempt and keeps the redo stack, so the
          // pass is still one undo step however long the decode took.
          store.applyClipRender(clipId, { durationSec: duration, sourceDuration: duration }, peaks);
          return;
        }
        store.cachePeaks(clipId, peaks);
      })
      .catch(() => {
        /* a clip that draws flat is still a clip; the bytes are on it */
      });
  }
  // A faulted take still LANDS — the spec flushes what it gathered — so the
  // fault is reported beside the clip rather than instead of it.
  if (faulted) setState({ lastError: faulted });
}

export const useRecordingStore = create<RecordingStoreState>()(() => ({
  status: 'idle',
  armedTrackIds: [],
  levels: {},
  lastError: null,

  recordPress: () => {
    // Any state but idle: the key is a STOP. That covers a cancel during the
    // count and a second press mid-pass, so the one key never needs a mode.
    if (st().status !== 'idle') {
      st().stopRecording();
      return;
    }
    const ids = deps.armedTrackIds();
    syncArmed(ids);
    if (ids.length === 0) {
      // Not a throw: the press is a no-op the UI explains. The engine would
      // raise the same code from `start()`, but asking it would open nothing
      // and lose the press to an unhandled rejection.
      setState({ lastError: new RecordingError('nothing-armed') });
      return;
    }
    setState({ lastError: null });

    // `MetronomeScheduler.countIn` can call `onDone` SYNCHRONOUSLY and still
    // hand back a non-null cancel, on two paths `shouldCountIn` cannot see from
    // out here: no engine context yet (it returns `() => undefined`), and a
    // count that works out to no clicks or no duration (it returns the REAL
    // cancel). Latching `counting` over a pass that has already been released
    // would leave the key lying about its state, and the next press would
    // "cancel" a count that is not running while the recorders kept rolling —
    // the press after THAT then gets `busy`. So the release wins: if it has
    // already run, this was a normal press and there is nothing to store.
    let released = false;
    const release = (): void => {
      released = true;
      countInCancel = null;
      setState({ status: 'recording' });
      void beginPass();
    };
    const cancel = deps.beginCountIn(release);
    if (released) return;
    if (!cancel) {
      release();
      return;
    }
    countInCancel = cancel;
    setState({ status: 'counting' });
  },

  stopRecording: () => {
    const status = st().status;
    if (status === 'idle' || status === 'stopping') return;
    if (status === 'counting') {
      // Nothing has moved: the playhead is where it was and no recorder was
      // ever opened, so there is nothing to undo — only the clicks to silence.
      countInCancel?.();
      countInCancel = null;
      deps.cancelCountIn();
      setState({ status: 'idle' });
      return;
    }
    if (startInFlight) {
      // The recorders are still opening. `beginPass` runs this stop the moment
      // they are live, rather than stopping an engine with nothing in it.
      stopPending = true;
      setState({ status: 'stopping' });
      return;
    }
    void finishPass();
  },

  clearError: () => setState({ lastError: null }),
}));

/* -------------------------------------------------------------------------- */
/*                                 the service                                */
/* -------------------------------------------------------------------------- */

/**
 * Start the recording service: build the engine, mirror the arm flags onto it
 * and watch the transport. Idempotent — safe under StrictMode's double mount
 * and safe to call from more than one mount point. It only subscribes; no input
 * is opened until a record press.
 */
export function initRecording(): void {
  if (started) return;
  started = true;
  syncArmed(deps.armedTrackIds());
  subscriptions.push(deps.subscribeArmed((ids) => syncArmed(ids)));
  subscriptions.push(
    deps.subscribeTransport((playing) => {
      // Stopping the transport stops the pass: a take cannot outlive the clock
      // it is anchored to. A count-in has no transport yet, so it is untouched.
      if (playing) return;
      if (st().status === 'recording') st().stopRecording();
    }),
  );
}

/**
 * Tear the service down: drop every subscription and the engine, and return the
 * store to idle. `initRecording()` may then be called again, with whatever
 * `setRecordingDeps` now holds. Used by the tests; a running pass is NOT
 * stopped for you — stop it first.
 */
export function resetRecording(): void {
  for (const off of subscriptions) {
    try {
      off();
    } catch {
      /* a subscription the owner already dropped */
    }
  }
  subscriptions = [];
  engine = null;
  started = false;
  countInCancel = null;
  startInFlight = false;
  stopPending = false;
  takeSeq = 0;
  transportRolled = false;
  pendingLevels = {};
  lastLevelWrite = 0;
  setState({ status: 'idle', armedTrackIds: [], levels: {}, lastError: null });
}
