/**
 * SoundFont synthesis engine (SpessaSynth) — the sample/soundfont voice that
 * `midiSynth` delegates to when a soundfont instrument is active. When soundfonts
 * are off or fail to load, callers fall back to midiSynth's built-in sawtooth
 * ("Basic"), so nothing breaks if the soundfont asset is missing.
 *
 * Live preview runs on the app's shared AudioContext (playerStore). Offline
 * bounce builds its own OfflineAudioContext, mirroring midiSynth's render path,
 * so MIDI rendered to WAV (Library, sendToTargets, PianoRoll) uses the soundfont
 * too. Arbitrary notes are bridged to a MIDI sequence via `notesToSmf`, since
 * SpessaSynth renders from a parsed MIDI rather than loose notes.
 */
import { create } from 'zustand';
import { WorkletSynthesizer, audioBufferToWav } from 'spessasynth_lib';
import { BasicMIDI } from 'spessasynth_core';
import { getEngineCtx, getMasterGain } from '../state/playerStore';
import { RANGE_LSB_SPESSA, bendRangeMessages } from './midi';
import { addWorkletModule } from './audioWorkletSupport';
import { notesToSmf, type SmfWheel } from './midiWrite';
import type { RenderNote } from './midiSynth';

/** Bundled default General MIDI soundfont, served from frontend/public. */
const DEFAULT_SOUNDFONT_URL = '/soundfonts/gm.sf3';

interface SoundfontState {
  /** Live synth is initialized and the soundfont is loaded. */
  ready: boolean;
  /** A load is in flight. */
  loading: boolean;
  /** Last load error, if any (lets the UI show a fallback notice). */
  loadError: string | null;
  /** When false, MIDI uses the built-in sawtooth instead of the soundfont. */
  useSoundfont: boolean;
  /** Active General MIDI program (0-127). */
  activeProgram: number;
  /** Active procedural synth voice id (see synthVoices); null = soundfont/basic. */
  activeSynthVoice: string | null;
  setUseSoundfont: (b: boolean) => void;
  setActiveProgram: (p: number) => void;
  setActiveSynthVoice: (id: string | null) => void;
}

export const useSoundfontStore = create<SoundfontState>((set) => ({
  ready: false,
  loading: false,
  loadError: null,
  // Default to the bundled soundfont's Bright Acoustic Piano (GM program 1)
  // instead of the raw sawtooth; falls back to the sawtooth if it fails to load.
  useSoundfont: true,
  activeProgram: 1,
  activeSynthVoice: null,
  // The three instrument modes are mutually exclusive: a soundfont program, a
  // procedural synth voice, or neither ("basic" sawtooth).
  setUseSoundfont: (b) => set(b ? { useSoundfont: true, activeSynthVoice: null } : { useSoundfont: false }),
  setActiveProgram: (p) => set({ activeProgram: Math.max(0, Math.min(127, Math.round(p))) }),
  setActiveSynthVoice: (id) => set(id ? { activeSynthVoice: id, useSoundfont: false } : { activeSynthVoice: null }),
}));

/** True when MIDI should render through a soundfont instead of the sawtooth. */
export const isSoundfontActive = (): boolean => useSoundfontStore.getState().useSoundfont;
/** The active GM program (0-127). */
export const getActiveProgram = (): number => useSoundfontStore.getState().activeProgram;
/** The active procedural synth voice id, or null when on soundfont/basic. */
export const getActiveSynthVoice = (): string | null => useSoundfontStore.getState().activeSynthVoice;

let sfPromise: Promise<ArrayBuffer> | null = null;
function loadDefaultSoundfont(): Promise<ArrayBuffer> {
  if (!sfPromise) {
    useSoundfontStore.setState({ loading: true, loadError: null });
    sfPromise = fetch(DEFAULT_SOUNDFONT_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`soundfont HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((ab) => {
        useSoundfontStore.setState({ loading: false });
        return ab;
      })
      .catch((e: unknown) => {
        useSoundfontStore.setState({
          loading: false,
          loadError: e instanceof Error ? e.message : String(e),
        });
        sfPromise = null; // allow a later retry
        throw e;
      });
  }
  return sfPromise;
}

/**
 * URL of the SpessaSynth AudioWorklet processor, resolved lazily.
 *
 * Vite rewrites this `?url` specifier to the same emitted asset whether it is
 * written as a static or a dynamic import, so the URL handed to `addModule` is
 * unchanged. Importing it dynamically means merely importing this module no
 * longer evaluates a Vite-only specifier, which Node/tsx (the frontend test
 * runner) cannot resolve. Memoized, so the dynamic import is evaluated once.
 */
let processorUrlPromise: Promise<string> | null = null;
function getProcessorUrl(): Promise<string> {
  if (!processorUrlPromise) {
    processorUrlPromise = import('spessasynth_lib/dist/spessasynth_processor.min.js?url')
      .then((m) => m.default)
      .catch((e: unknown) => {
        processorUrlPromise = null;
        throw e;
      });
  }
  return processorUrlPromise;
}

let liveSynth: WorkletSynthesizer | null = null;
let liveSynthPromise: Promise<WorkletSynthesizer> | null = null;
const channelProgram = new Map<number, number>();
function getLiveSynth(): Promise<WorkletSynthesizer> {
  if (!liveSynthPromise) {
    liveSynthPromise = (async () => {
      const ctx = getEngineCtx();
      await addWorkletModule(ctx, await getProcessorUrl());
      const synth = new WorkletSynthesizer(ctx);
      synth.connect(getMasterGain());
      const sf = await loadDefaultSoundfont();
      // Pass a copy: the worklet transfers (detaches) the buffer it receives, and
      // the cached `sf` is reused by the offline render path too.
      await synth.soundBankManager.addSoundBank(sf.slice(0), 'main');
      await synth.isReady;
      liveSynth = synth;
      channelProgram.clear();
      useSoundfontStore.setState({ ready: true });
      return synth;
    })().catch((e: unknown) => {
      liveSynthPromise = null;
      throw e;
    });
  }
  return liveSynthPromise;
}

/**
 * Warm up the engine (worklet + soundfont) ahead of first use so the first note
 * is not delayed. Safe to call repeatedly; resolves false if the soundfont could
 * not be loaded (caller stays on the sawtooth).
 */
export async function ensureSoundfontReady(): Promise<boolean> {
  try {
    await getLiveSynth();
    return true;
  } catch {
    return false;
  }
}

/**
 * Switch a channel to `program` when it plays another one, and remember it, so
 * every caller on that channel (a preview, the roll, EDIT's live MIDI) knows
 * what the channel plays and switches it back when it needs its own.
 */
function setChannelProgram(synth: WorkletSynthesizer, ch: number, program: number): void {
  const p = Math.max(0, Math.min(127, Math.round(program)));
  if (channelProgram.get(ch) === p) return;
  synth.programChange(ch, p);
  channelProgram.set(ch, p);
}

/**
 * Play a single note live through the soundfont on `channel` (0 unless the
 * caller keeps a channel of its own), at audio-context time `when` (now when
 * left out or already past) for `durationSec`. The note-on and note-off are
 * timed on the synth, so a note lands with the wheel messages sent for the same
 * time. Failure-safe (no throw).
 */
export async function previewNoteSF(midi: number, velocity: number, durationSec: number, channel = 0, when?: number): Promise<void> {
  try {
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    const synth = await getLiveSynth();
    const ch = channel & 0x0f;
    setChannelProgram(synth, ch, getActiveProgram());
    const note = Math.round(midi);
    // A time that passed while the synth loaded plays now, and the note keeps its length.
    const start = Math.max(when ?? 0, ctx.currentTime);
    synth.noteOn(ch, note, Math.max(1, Math.min(127, Math.round(velocity))), { time: start });
    synth.noteOff(ch, note, { time: start + Math.max(0.04, durationSec) });
  } catch {
    /* swallow: the caller decides whether to fall back to the sawtooth */
  }
}

async function renderMidiToBlob(
  midiBytes: ArrayBuffer,
  sampleRate: number,
  tailSec: number,
): Promise<{ blob: Blob; duration: number }> {
  const sf = await loadDefaultSoundfont();
  const midi = BasicMIDI.fromArrayBuffer(midiBytes, 'render');
  const length = Math.max(1, Math.ceil(sampleRate * (midi.duration + tailSec)));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, sampleRate, length });
  await addWorkletModule(ctx, await getProcessorUrl());
  const synth = new WorkletSynthesizer(ctx, { eventsEnabled: false });
  synth.connect(ctx.destination);
  await synth.startOfflineRender({
    midiSequence: midi,
    // Copy: startOfflineRender transfers (detaches) the buffer, but `sf` is the
    // shared cached soundfont reused by the live synth and later renders.
    soundBankList: [{ bankOffset: 0, soundBankBuffer: sf.slice(0) }],
    loopCount: 0,
  });
  await synth.isReady;
  const out = await ctx.startRendering();
  const wav: unknown = audioBufferToWav(out);
  const blob = wav instanceof Blob ? wav : new Blob([wav as ArrayBuffer], { type: 'audio/wav' });
  return { blob, duration: out.duration };
}

/** Render absolute-seconds notes to a WAV blob through the soundfont. */
export async function renderNotesToBlobSF(
  notes: RenderNote[],
  opts: { sampleRate?: number; tailSec?: number; program?: number; wheel?: SmfWheel[] } = {},
): Promise<{ blob: Blob; duration: number }> {
  // Honor an explicit program when the caller knows the clip's instrument; only
  // fall back to the global picker when it doesn't. Pitch wheels ride in the same file.
  const smf = notesToSmf(notes, opts.program ?? getActiveProgram(), 0, [], 120, opts.wheel ?? []);
  return renderMidiToBlob(smf.buffer as ArrayBuffer, opts.sampleRate ?? 44100, opts.tailSec ?? 0.6);
}

/** Render a Standard MIDI File buffer to a WAV blob through the soundfont. */
export async function renderMidiBufferToBlobSF(
  buf: ArrayBuffer | Uint8Array,
  opts: { sampleRate?: number; tailSec?: number } = {},
): Promise<{ blob: Blob; duration: number }> {
  const ab =
    buf instanceof Uint8Array
      ? (buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
      : buf;
  return renderMidiToBlob(ab, opts.sampleRate ?? 44100, opts.tailSec ?? 1);
}

/* ── per-channel output routing ────────────────────────────────────────────────
 * The worklet exposes 17 outputs: output 0 is the shared effects bus (reverb /
 * chorus returns) and outputs 1-16 are the dry per-MIDI-channel outs.
 * `synth.connect(node)` wires ALL 17 to one destination, which is why live MIDI
 * used to land straight on the engine master — bypassing the track fader, pan,
 * insert FX and the master rack that the very same clip obeys once exported.
 *
 * Rerouting a channel is therefore just: detach it from master, attach it to the
 * track's gain node. `connectChannel(node, ch)` maps to `worklet.connect(node,
 * ch % 16 + 1)`, so this uses the public API only — no `oneOutput` rebuild of the
 * synth, which would have changed the topology for the piano roll and MIDI panel
 * too. Output 0 stays on master: the effects bus is shared across all channels
 * and cannot be attributed to one track, so a track's synth reverb tail is the
 * one part that still bypasses its chain.
 */
const channelRoutes = new Map<number, AudioNode>();

/** Send MIDI channel `ch` to `dest` (a track's gain node), or back to the engine
 *  master when `dest` is null. No-op until the live synth exists. */
export function routeMidiChannel(ch: number, dest: AudioNode | null): void {
  const synth = liveSynth;
  if (!synth) return;
  const master = getMasterGain();
  const current = channelRoutes.get(ch) ?? master;
  const next = dest ?? master;
  if (current === next) return;
  try { synth.disconnectChannel(current, ch); } catch { /* already detached */ }
  try { synth.connectChannel(next, ch); } catch { /* node gone */ }
  if (dest) channelRoutes.set(ch, dest);
  else channelRoutes.delete(ch);
}

/** Return every rerouted channel to the engine master. MUST run before the track
 *  nodes it points at are disposed, or channels stay attached to dead nodes. */
export function resetMidiRouting(): void {
  const synth = liveSynth;
  if (!synth) {
    channelRoutes.clear();
    return;
  }
  const master = getMasterGain();
  for (const [ch, node] of channelRoutes) {
    try { synth.disconnectChannel(node, ch); } catch { /* already detached */ }
    try { synth.connectChannel(master, ch); } catch { /* master always valid */ }
  }
  channelRoutes.clear();
}

/* ── live multi-channel note API (timeline MIDI scheduler) ─────────────────── */

/** True when the live synth is loaded and ready for immediate scheduling. */
export const isLiveSynthReady = (): boolean => liveSynth !== null;

/**
 * Note-on on a channel, switching that channel's program first if it changed.
 * No-op (and warms the engine) if the synth is not ready yet.
 */
export function liveNoteOn(channel: number, program: number, midi: number, velocity: number): void {
  const s = liveSynth;
  if (!s) {
    void ensureSoundfontReady();
    return;
  }
  const ch = channel & 0x0f;
  setChannelProgram(s, ch, program);
  s.noteOn(ch, Math.round(midi), Math.max(1, Math.min(127, Math.round(velocity))));
}

/** Note-off on a channel. No-op if the synth is not ready. */
export function liveNoteOff(channel: number, midi: number): void {
  const s = liveSynth;
  if (!s) return;
  try {
    s.noteOff(channel & 0x0f, Math.round(midi));
  } catch {
    /* ignore */
  }
}

/**
 * Move a channel's pitch wheel on the live synth: raw 0-16383, 8192 the centre,
 * at audio-context time `time` (now when absent). No-op until the synth is ready.
 */
export function sfPitchWheel(channel: number, raw: number, time?: number): void {
  const s = liveSynth;
  if (!s) return;
  try {
    s.pitchWheel(channel & 0x0f, Math.max(0, Math.min(16383, Math.round(raw))), time !== undefined ? { time } : undefined);
  } catch {
    /* ignore */
  }
}

/**
 * Set a channel's pitch bend range on the live synth at `time` (now when
 * absent): the RPN 0/0 messages of lib/midi bendRangeMessages, each at that
 * time, with CC 38 in the 1/128 semitones SpessaSynth reads it as. No-op until
 * the synth is ready.
 */
export function sfPitchWheelRange(channel: number, semitones: number, time?: number): void {
  const s = liveSynth;
  if (!s) return;
  try {
    const options = time !== undefined ? { time } : undefined;
    for (const bytes of bendRangeMessages(channel, Math.max(0, semitones), RANGE_LSB_SPESSA)) s.sendMessage(bytes, 0, options);
  } catch {
    /* ignore */
  }
}

/** Panic: stop all notes on all channels (used on transport stop/seek). */
export function liveAllNotesOff(): void {
  const s = liveSynth;
  if (!s) return;
  try {
    s.stopAll(true);
  } catch {
    /* ignore */
  }
}
