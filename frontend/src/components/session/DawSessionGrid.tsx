import React from 'react';
import {
  Circle,
  Headphones,
  Play,
  SkipBack,
  SkipForward,
  Square,
  Volume2,
} from 'lucide-react';
import { dawImportAudioUrl } from '../../lib/dawImportClient';
import { SurfacePlayKey } from '../ui/SurfacePlayKey';
import type { DawClip, DawProject, DawTrack } from '../../lib/dawImportClient';
import { performScenes, performSceneCount, performTracks } from '../../lib/performModel';
import { beatClock, type ClockGrid } from '../../lib/beatClock';
import { createLaunchQueue, launchSlotId, type LaunchAction, type LaunchTicket } from '../../lib/launchQueue';
import { getEngineCtx, getMasterGain } from '../../state/playerStore';
import { renderNotesToBlob, type RenderNote } from '../../lib/midiSynth';
import { subscribeToMidi } from '../../state/midiBus';
import { subscribeSwayValue } from '../../state/swayBus';
import { enableMidi } from '../../state/midiTriggerStore';
import { usePerformRoutingStore, ctrlMatches } from '../../state/performRouting';
import { registerPerformChainPush } from '../../state/performRailStore';
import { logError } from '../../state/logStore';
import { dawDeviceToEffectNode } from '../../lib/dawEffectMap';
import {
  buildEffectChain,
  ensureChopModule,
  ensureGranularModule,
  ensureSubharmonicModule,
  type ChainHandle,
} from '../../lib/rackEffects';
import type { ChainEntry } from '../../state/effectChainStore';

type ClipLookup = Map<string, DawClip>;

interface SessionPlayer {
  source: AudioBufferSourceNode;
  analyser?: AnalyserNode;
  gain?: GainNode;
  panner?: StereoPannerNode;
  trackIndex: number;
  /** The track's index in the mixer/track list (performTracks order), used to
   *  apply live Sway modulation to the right column's gain. */
  mixIndex: number;
  /** Which scene row this player came from, so the grid can show per-track
   *  playing state instead of one global "active scene". */
  sceneIndex: number;
}

type ClipBufferCache = Map<string, Promise<AudioBuffer>>;

const CLIP_COLORS = [
  {
    clip: 'bg-[#7864ff] border-[#9f91ff] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#7864ff]',
  },
  {
    clip: 'bg-[#ff3232] border-[#ff7474] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#ff3232]',
  },
  {
    clip: 'bg-[#11c6aa] border-[#5af5dc] text-black',
    header: 'bg-[#c1aa31] text-black',
    scene: 'bg-[#11c6aa]',
  },
  {
    clip: 'bg-[#d9d9d9] border-white/80 text-black',
    header: 'bg-[#ff3232] text-black',
    scene: 'bg-[#d9d9d9]',
  },
  {
    clip: 'bg-[#91a7ff] border-[#c1cdff] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#91a7ff]',
  },
  {
    clip: 'bg-[#66ff50] border-[#a2ff92] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#66ff50]',
  },
  {
    clip: 'bg-[#28f0b8] border-[#84ffe1] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#28f0b8]',
  },
  {
    clip: 'bg-[#91a7ff] border-[#c1cdff] text-black',
    header: 'bg-[#7864ff] text-black',
    scene: 'bg-[#91a7ff]',
  },
];

const clipKey = (trackIndex: number, sceneIndex: number) => `${trackIndex}:${sceneIndex}`;

/* --- Launch quantization on the shared clock --------------------------------
   The grid used to quantize against its own `sessionStartRef`: a seconds-based
   anchor taken on the first launch, invisible to LOOM / the colony / the DJ
   pads, re-taken whenever the grid ran out of players (so a full stop moved the
   downbeat), and bars-only because it multiplied `time_signature[0] * 60/bpm`
   by hand. Launches now go through `launchQueue` over `beatClock`, which is the
   same bar/beat grid every other surface already launches against. */

/** How often the queue is pumped. Comfortably inside `LAUNCH_LEAD_SEC`. */
const LAUNCH_TICK_MS = 15;
/**
 * How far ahead of its grid line a ticket is handed back, so the fire path has
 * time to build the graph and call `source.start(at)` BEFORE `at` arrives.
 * `beatClock`'s own `CLOCK_LEAD_SEC` (10 ms) is the margin for a time computed
 * and used in the same turn; a launch is pumped by a JS timer, so the lead has
 * to cover a tick plus its jitter instead.
 */
const LAUNCH_LEAD_SEC = 0.05;

/** The quantization choices the toolbar offers, in grid order. */
const LAUNCH_GRIDS: ReadonlyArray<{ value: ClockGrid; label: string }> = [
  { value: 'now', label: 'Off' },
  { value: 'beat', label: '1 Beat' },
  { value: 'bar', label: '1 Bar' },
  { value: '2bar', label: '2 Bars' },
  { value: '4bar', label: '4 Bars' },
];

const isLaunchGrid = (value: string): value is ClockGrid =>
  LAUNCH_GRIDS.some((g) => g.value === value);

/** A clip resolved for launch, as `sceneClips` yields it. */
interface SceneEntry {
  clip: DawClip;
  track: DawTrack;
  trackIndex: number;
  mixIndex: number;
}

/** What a queued ticket needs at fire time, kept beside the queue by slot id. */
interface PendingLaunch {
  mixIndex: number;
  /** The row that was pressed — what the queued ring is drawn on. */
  sceneIndex: number;
  /** null for a stop (an empty slot, or a column the launched scene leaves out). */
  entry: SceneEntry | null;
  /** Scene launches own `activeScene`; a single-cell launch never touches it. */
  origin: 'clip' | 'scene';
  /** Bumped per press, so a decode that lands after a newer press is dropped. */
  gen: number;
}

/** Clip colour comes from Live's palette when the parser decoded one; the
 *  position-derived CLIP_COLORS entry is only a fallback now. Colour is how a
 *  performer navigates a grid at speed, so a set should look like itself. */
const clipStyle = (clip: DawClip, fallback: string): string =>
  clip.color ? 'border text-black' : fallback;

/** Tooltip that names WHY a clip can't play, instead of a bare clip name and an
 *  anonymous "N clips could not be played" banner. */
const clipTitle = (clip: DawClip): string => {
  if (isPlayableClip(clip)) return clip.name;
  return `${clip.name} — sample not found. Relink it in Live, or open the set from its Project folder.`;
};

const dbToVolume = (db: number): number => {
  if (!Number.isFinite(db)) return 1;
  return Math.min(1, Math.max(0, 10 ** (db / 20)));
};

/** A clip is playable if it has audio on disk or MIDI notes to render. */
const isPlayableClip = (clip: DawClip): boolean =>
  !!clip.file_path || !!(clip.midi_notes && clip.midi_notes.length);

/** Cache key: the audio URL for audio clips, or a stable MIDI key otherwise. */
const clipCacheKey = (clip: DawClip): string =>
  clip.file_path
    ? dawImportAudioUrl(clip.file_path)
    : `midi:${clip.track_index ?? '?'}:${clip.scene_index ?? clip.slot_index ?? '?'}:${clip.name}`;

/** DAW MIDI-note dicts -> synth RenderNote[] (start/duration in seconds). */
const notesFromDawClip = (clip: DawClip): RenderNote[] => {
  if (!Array.isArray(clip.midi_notes)) return [];
  return clip.midi_notes.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const note = raw as Record<string, unknown>;
    const midi = Number(note.midi ?? note.note ?? note.pitch);
    const startSec = Number(note.startSec ?? note.start_sec ?? note.start ?? 0);
    const durationSec = Number(note.durationSec ?? note.duration_sec ?? note.duration ?? 0.25);
    const velocityRaw = Number(note.velocity ?? 0.8);
    if (!Number.isFinite(midi) || !Number.isFinite(startSec) || !Number.isFinite(durationSec)) return [];
    return [{
      midi,
      startSec: Math.max(0, startSec),
      durationSec: Math.max(0.02, durationSec),
      // < 1, not <= 1: a raw value of exactly 1 is a legitimate (very quiet)
      // MIDI velocity, and treating it as normalised 1.0 turned it into 127.
      velocity: velocityRaw < 1 ? Math.round(velocityRaw * 127) : Math.round(velocityRaw),
    }];
  });
};

const linearToDb = (value: number): number => {
  if (value <= 0.0001) return -72;
  return Math.max(-72, Math.min(6, 20 * Math.log10(value)));
};

const meterHeight = (level: number): string => `${Math.round(Math.min(1, Math.max(0, level)) * 100)}%`;

const stopSessionPlayers = (players: SessionPlayer[]) => {
  players.forEach((player) => {
    try { player.source.onended = null; player.source.stop(); } catch { /* already stopped */ }
    try { player.source.disconnect(); } catch { /* already disconnected */ }
    // NOT the analyser: it belongs to the track's persistent FX chain and is
    // shared by every clip on that column. Disconnecting it here would sever the
    // column's output to the master bus for the rest of the session.
    player.gain?.disconnect();
    player.panner?.disconnect();
  });
};

/**
 * Stop these players AT `at` instead of now, so a column hands over on its grid
 * line: the outgoing clip's last sample and the incoming clip's first sample
 * share an instant. Stopping immediately and starting at the next bar (what the
 * old scene launch did) left a silent hole the length of the quantization.
 *
 * Teardown waits for `onended`, which a scheduled stop always fires — including
 * on a looping source, which otherwise never ends on its own.
 */
const scheduleStopPlayers = (players: SessionPlayer[], at: number) => {
  players.forEach((player) => {
    player.source.onended = () => {
      try { player.source.disconnect(); } catch { /* already disconnected */ }
      // NOT the analyser — it belongs to the column's persistent FX chain.
      player.gain?.disconnect();
      player.panner?.disconnect();
    };
    try { player.source.stop(at); } catch { /* already stopped */ }
  });
};

/**
 * Build and start one clip's audio graph:
 *   source -> gain (track vol x Sway mod x mute/solo) -> panner -> analyser -> master
 *
 * Everything here was previously missing. The old body was a bare
 * `source.start(startAt)`, which meant: the whole source file played once from
 * sample zero (ignoring the clip's trim), nothing looped, mute/solo/pan never
 * reached the graph at all, and a loop recorded at another tempo played at its
 * own rate so a scene drifted apart within a bar.
 */
const startClipPlayer = (
  context: AudioContext,
  opts: {
    buffer: AudioBuffer;
    clip: DawClip;
    track: DawTrack;
    trackIndex: number;
    mixIndex: number;
    sceneIndex: number;
    startAt: number;
    projectTempo: number;
    mix?: { vol: number; mute: boolean };
    anySolo: boolean;
    /** Where this clip feeds: the track's FX-chain input, so an imported set's
     *  EQ/compression/reverb is actually in the signal path. */
    destination: AudioNode;
    /** The TRACK's analyser (post-FX), shared by every clip on that column. */
    analyser: AnalyserNode;
  },
): SessionPlayer => {
  const { buffer, clip, track, startAt, projectTempo, mix, anySolo, destination, analyser } = opts;
  const source = context.createBufferSource();
  const gain = context.createGain();
  const panner = context.createStereoPanner();
  source.buffer = buffer;

  // Warp: play the sample at the ratio between the project tempo and the tempo
  // it was recorded at. Constant-rate, which is exactly right for the
  // single-tempo loops a session grid is made of.
  if (clip.is_warped && clip.source_tempo && clip.source_tempo > 0) {
    source.playbackRate.value = projectTempo / clip.source_tempo;
  }

  // The clip is a WINDOW onto its sample: start at the trim point and run for
  // the clip's own length, not the file's.
  const maxOffset = Math.max(0, buffer.duration - 0.01);
  const offset = Math.min(Math.max(0, clip.offset_into_source ?? 0), maxOffset);
  const span = Math.max(0, (clip.end_time ?? 0) - (clip.start_time ?? 0));
  const available = Math.max(0, buffer.duration - offset);
  const duration = span > 0.02 ? Math.min(span, available) : available;

  // Loop when Live says so. `loop_on == null` means the set didn't say, so treat
  // it as a one-shot rather than looping material never meant to repeat.
  if (clip.loop_on) {
    source.loop = true;
    source.loopStart = offset;
    source.loopEnd = Math.min(buffer.duration, offset + (duration || available));
  }

  // Mute/solo are honoured here for the first time: a track muted in Live came
  // back audible, and a set with any track soloed played everything.
  const volMul = mix?.vol ?? 1;
  const modMuted = mix?.mute ?? false;
  const silencedBySolo = anySolo && !track.solo;
  const audible = !track.mute && !modMuted && !silencedBySolo;
  gain.gain.value = dbToVolume(track.volume_db) * volMul * (audible ? 1 : 0);
  panner.pan.value = Math.max(-1, Math.min(1, track.pan ?? 0));

  source.connect(gain);
  gain.connect(panner);
  // -> the track's FX chain (built once per column), which terminates in the
  // shared track analyser and then the master bus.
  panner.connect(destination);
  // A looping source ignores `duration`; a one-shot needs it to stop at the
  // clip's edge instead of running to the end of the file.
  if (source.loop) source.start(startAt, offset);
  else source.start(startAt, offset, duration || undefined);

  return {
    source,
    gain,
    panner,
    analyser,
    trackIndex: opts.trackIndex,
    mixIndex: opts.mixIndex,
    sceneIndex: opts.sceneIndex,
  };
};

interface DawSessionGridProps {
  project: DawProject;
  fill?: boolean;
}

export const DawSessionGrid: React.FC<DawSessionGridProps> = ({ project, fill = false }) => {
  const [activeScene, setActiveScene] = React.useState<number | null>(null);
  /** Which scene each column is currently playing, keyed by mixIndex. A single
   *  scalar activeScene could not represent Live's core move — holding a
   *  bassline while changing drums — so per-clip launch needs this. */
  const [trackScenes, setTrackScenes] = React.useState<Record<number, number>>({});
  /** Which grid line a launch lands on. `'now'` = the next pump. */
  const [launchGrid, setLaunchGrid] = React.useState<ClockGrid>('bar');
  /** Column -> the row whose press is waiting for its grid line. One entry per
   *  column, because one column holds one intent. Drives the queued ring. */
  const [queuedSlots, setQueuedSlots] = React.useState<Record<number, number>>({});
  const [selectedScene, setSelectedScene] = React.useState(0);
  const [launchError, setLaunchError] = React.useState<string | null>(null);
  const [lastAction, setLastAction] = React.useState<string | null>(null);
  const [trackLevels, setTrackLevels] = React.useState<number[]>([]);
  const [masterLevel, setMasterLevel] = React.useState(0);
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  const playersRef = React.useRef<SessionPlayer[]>([]);
  const bufferCacheRef = React.useRef<ClipBufferCache>(new Map());
  /** Decoded buffers by cache key. The fire path has to be synchronous to hit
   *  `at`, so it reads a resolved buffer here rather than awaiting a promise. */
  const bufferReadyRef = React.useRef<Map<string, AudioBuffer>>(new Map());
  const launchTokenRef = React.useRef(0);
  const animationRef = React.useRef<number | null>(null);
  const startedAtRef = React.useRef<number | null>(null);
  const meterDataRef = React.useRef(new Uint8Array(0));
  // Per-mixer-column live modulation from the Sway dims (0..1 volume multiplier
  // + mute), applied on top of the clip's base track gain. Persists across scene
  // launches so a held hand position keeps modulating the next scene.
  const mixRef = React.useRef<Map<number, { vol: number; mute: boolean }>>(new Map());
  // Note-driven ccMods with `latch: true` that are currently toggled ON,
  // keyed by mod id. Session-only state, cleared when the mod disappears.
  const latchedRef = React.useRef<Set<string>>(new Set());

  /* --- The launch queue ----------------------------------------------------
     The queue owns nothing but intent; `at` always comes from `beatClock`, so
     a PERFORM downbeat and a LOOM downbeat are the same instant. */
  const launchQueue = React.useMemo(
    () => createLaunchQueue({
      nextGrid: (grid, from) => beatClock.nextGrid(grid, from),
      now: () => getEngineCtx().currentTime,
      lead: LAUNCH_LEAD_SEC,
    }),
    [],
  );
  /** Fire-time payload per slot id, replaced in lockstep with the queue. */
  const pendingRef = React.useRef<Map<string, PendingLaunch>>(new Map());
  /** The newest press generation per column, so a late decode can tell it lost. */
  const columnGenRef = React.useRef<Map<number, number>>(new Map());
  const genRef = React.useRef(0);
  const pumpTimerRef = React.useRef<number | null>(null);
  const pumpRef = React.useRef<() => void>(() => {});

  /**
   * Hand the set's tempo and meter to the shared clock, so "next bar" here
   * means the bar the SET is in and not 120 bpm 4/4.
   *
   * Claimed on the first launch, not on mount: PERFORM's grid mounts as soon as
   * a project is imported, and retuning the one clock at that moment would
   * silently move LOOM's grid and shard durations under a user who has not
   * pressed anything here yet. A press is the point at which this surface is
   * the one making sound.
   *
   * The meter goes in as a MAP, not as `setBeatsPerBar`: that shorthand builds
   * n/4, so a 7/8 set would come back as 7/4 (or, rounded through quarter
   * notes, as 4/4) and every bar line would be wrong. A beat is a quarter note
   * in the clock whatever the meter, which is why a 7/8 bar is 3.5 beats.
   */
  const meterNum = project.time_signature?.[0] ?? 4;
  const meterDen = project.time_signature?.[1] ?? 4;
  const clockClaimRef = React.useRef<string | null>(null);
  const claimClock = React.useCallback(() => {
    const key = `${project.tempo || 120}:${meterNum}/${meterDen}`;
    if (clockClaimRef.current === key) return;
    clockClaimRef.current = key;
    beatClock.setBpm(project.tempo || 120, 'perform');
    beatClock.setMeterMap([{ bar: 0, meter: { num: meterNum, den: meterDen, groups: [] } }]);
  }, [project.tempo, meterNum, meterDen]);

  // The worklet-backed rack stages (chop, Ares grains, the Kargyraa Sub
  // octave divider) degrade to passthrough/silence when their module is not
  // registered on the context. EDIT preloads them; PERFORM must too, or a
  // .tasmo chain using them plays defanged until the user visits EDIT.
  React.useEffect(() => {
    const ctx = getEngineCtx();
    void ensureChopModule(ctx).catch(() => {});
    void ensureGranularModule(ctx).catch(() => {});
    void ensureSubharmonicModule(ctx).catch(() => {});
  }, []);

  const tracks = React.useMemo(() => performTracks(project), [project]);

  React.useEffect(() => {
    setTrackLevels(Array.from({ length: tracks.length }, () => 0));
  }, [tracks.length]);

  const clipLookup = React.useMemo<ClipLookup>(() => {
    const lookup: ClipLookup = new Map();
    tracks.forEach((track, fallbackTrackIndex) => {
      track.clips.forEach((clip) => {
        const trackIndex = clip.track_index ?? fallbackTrackIndex;
        const sceneIndex = clip.scene_index ?? clip.slot_index;
        if (sceneIndex == null) return;
        lookup.set(clipKey(trackIndex, sceneIndex), clip);
      });
    });
    return lookup;
  }, [tracks]);

  const sceneCount = React.useMemo(() => performSceneCount(project), [project]);

  const scenes = React.useMemo(() => performScenes(project), [project]);

  const stopMeters = React.useCallback(() => {
    if (animationRef.current != null) window.cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    startedAtRef.current = null;
    setElapsedSeconds(0);
    setMasterLevel(0);
    setTrackLevels(Array.from({ length: tracks.length }, () => 0));
  }, [tracks.length]);

  /** The queue only needs pumping while something is waiting in it, so an idle
   *  grid costs no timer at all. `setInterval`, not rAF: in a hidden tab rAF is
   *  parked outright, so a queued launch would never fire, while a background
   *  interval is only clamped (to about 1 s) — late, not never. */
  const stopPump = React.useCallback(() => {
    if (pumpTimerRef.current != null) window.clearInterval(pumpTimerRef.current);
    pumpTimerRef.current = null;
  }, []);

  const ensurePump = React.useCallback(() => {
    if (pumpTimerRef.current == null) {
      pumpTimerRef.current = window.setInterval(() => pumpRef.current(), LAUNCH_TICK_MS);
    }
  }, []);

  React.useEffect(() => stopPump, [stopPump]);

  /* --- Per-track FX chains -------------------------------------------------
     Perform playback used to be completely dry: `grep device` over this file
     returned nothing, so an imported set's EQ, compression and reverb were
     parsed, mapped by dawEffectMap, and then never instantiated. Only the
     .tasmo conversion path ever called dawDeviceToEffectNode.

     One persistent chain per column, built lazily and reused across launches
     (rebuilding per clip would re-generate reverb IRs on every cell press). The
     chain terminates in the track's analyser, so metering is post-FX and every
     clip on a column shares one meter.

     Instruments are skipped at connect time rather than filtered out of
     track.devices — swayImportResolve.ts indexes fxChain by the FLATTENED device
     order, so removing elements would silently misalign controller mappings. */
  const trackChainsRef = React.useRef<
    Map<number, { input: GainNode; output: GainNode; analyser: AnalyserNode; handle: ChainHandle | null }>
  >(new Map());

  const ensureTrackChain = React.useCallback(
    (mixIndex: number, track: DawTrack) => {
      const existing = trackChainsRef.current.get(mixIndex);
      if (existing) return existing;
      const context = getEngineCtx();
      const input = context.createGain();
      const output = context.createGain();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.62;
      output.connect(analyser);
      analyser.connect(getMasterGain());

      let handle: ChainHandle | null = null;
      const entries: ChainEntry[] = (track.devices ?? [])
        .filter((d) => !d.is_instrument && !d.is_rack)
        .map((d, i) => {
          const node = dawDeviceToEffectNode(d);
          return {
            id: `perform-${mixIndex}-${i}`,
            effect: node.effect_name,
            params: node.parameters ?? {},
            enabled: !node.bypass,
          } as ChainEntry;
        })
        // VST3/AU cannot run in the live Web Audio graph (buildEffectChain only
        // knows the rack effects), so they are inert here exactly as they are on
        // the EDIT timeline.
        .filter((e) => e.effect !== 'vst3');
      try {
        handle = buildEffectChain(context, input, output, entries);
      } catch (e) {
        // A chain that fails to build must not take the whole grid down —
        // fall back to a clean passthrough.
        logError('perform', `Track FX chain failed for "${track.name}": ${e instanceof Error ? e.message : String(e)}`);
        try { input.connect(output); } catch { /* already wired */ }
      }
      const made = { input, output, analyser, handle };
      trackChainsRef.current.set(mixIndex, made);
      return made;
    },
    [],
  );

  const disposeTrackChains = React.useCallback(() => {
    for (const c of trackChainsRef.current.values()) {
      try { c.handle?.dispose(); } catch { /* already gone */ }
      try { c.input.disconnect(); c.output.disconnect(); c.analyser.disconnect(); } catch { /* gone */ }
    }
    trackChainsRef.current = new Map();
  }, []);

  React.useEffect(() => disposeTrackChains, [disposeTrackChains]);

  // The right rail's PARAMS tab edits device params through this bridge —
  // same entry ids the CC routes drive, same lazily-built live chains.
  React.useEffect(() => {
    registerPerformChainPush((trackIndex, deviceIndex, params) => {
      const track = tracksRef.current[trackIndex];
      if (!track) return;
      const chain = ensureTrackChain(trackIndex, track);
      chain.handle?.updateParams(`perform-${trackIndex}-${deviceIndex}`, params);
    });
    return () => registerPerformChainPush(null);
  }, [ensureTrackChain]);

  /** Stopping the transport is the one unquantized command: it clears every
   *  pending intent so nothing fires into the silence afterwards. */
  const stopScene = React.useCallback(() => {
    launchQueue.clear();
    pendingRef.current.clear();
    // Dropping every column's generation is what stops a clip that was still
    // decoding when the transport stopped from starting itself afterwards.
    columnGenRef.current.clear();
    stopPump();
    setQueuedSlots({});
    stopSessionPlayers(playersRef.current);
    playersRef.current = [];
    setActiveScene(null);
    setTrackScenes({});
    stopMeters();
  }, [launchQueue, stopMeters, stopPump]);

  /** Queue one column's next intent, replacing whatever it was waiting on. */
  const queueLaunch = React.useCallback(
    (req: { mixIndex: number; sceneIndex: number; entry: SceneEntry | null; origin: 'clip' | 'scene' }) => {
      // The first press is what makes this surface the clock's owner.
      claimClock();
      const action: LaunchAction = req.entry ? 'play' : 'stop';
      const slotId = launchSlotId(req.mixIndex);
      genRef.current += 1;
      const gen = genRef.current;
      columnGenRef.current.set(req.mixIndex, gen);
      pendingRef.current.set(slotId, { ...req, gen });
      launchQueue.queue(slotId, { grid: launchGrid, action });
      setQueuedSlots((prev) => ({ ...prev, [req.mixIndex]: req.sceneIndex }));
      ensurePump();
    },
    [claimClock, ensurePump, launchGrid, launchQueue],
  );

  React.useEffect(() => stopScene, [stopScene]);

  const sceneClips = React.useCallback(
    (sceneIndex: number) =>
      tracks.flatMap((track, fallbackTrackIndex) => {
        const trackIndex = track.clips.find((clip) => clip.track_index != null)?.track_index ?? fallbackTrackIndex;
        const clip = clipLookup.get(clipKey(trackIndex, sceneIndex));
        return clip && isPlayableClip(clip)
          ? [{ clip, track, trackIndex, mixIndex: fallbackTrackIndex }]
          : [];
      }),
    [clipLookup, tracks],
  );

  const getClipBuffer = React.useCallback((clip: DawClip): Promise<AudioBuffer> => {
    const key = clipCacheKey(clip);
    const cached = bufferCacheRef.current.get(key);
    if (cached) return cached;
    const task = (async () => {
      const context = getEngineCtx();
      if (clip.file_path) {
        const response = await fetch(dawImportAudioUrl(clip.file_path));
        if (!response.ok) throw new Error(`clip fetch ${response.status}`);
        return context.decodeAudioData(await response.arrayBuffer());
      }
      // MIDI clip: render its notes to audio so session cells still play.
      const notes = notesFromDawClip(clip);
      if (notes.length === 0) throw new Error('clip has no audio or notes');
      const rendered = await renderNotesToBlob(notes, { tailSec: 0.2 });
      return context.decodeAudioData(await rendered.blob.arrayBuffer());
    })();
    bufferCacheRef.current.set(key, task);
    // Mirror the resolved buffer into a plain map: the launch fire path runs on
    // a timer tick and cannot await, so it needs the buffer synchronously.
    task.then(
      (buffer) => { bufferReadyRef.current.set(key, buffer); },
      () => { bufferCacheRef.current.delete(key); },
    );
    return task;
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const seen = new Set<string>();
    // Warm only clips the grid can actually LAUNCH. This iterated every clip on
    // every track — arrangement lane included, which clipLookup can never reach —
    // so importing a real set decoded hundreds of MB of PCM (~10.6 MB per stereo
    // minute per clip) and locked the tab for tens of seconds, with no progress
    // and no cancel, even for an arrangement-only set whose grid is empty.
    // getClipBuffer memoises, so a cell outside this set costs one decode on use.
    const clips = Array.from(clipLookup.values()).filter((clip) => {
      if (!isPlayableClip(clip)) return false;
      const key = clipCacheKey(clip);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const warm = async () => {
      for (let index = 0; index < clips.length && !cancelled; index += 2) {
        await Promise.allSettled(clips.slice(index, index + 2).map(getClipBuffer));
      }
    };
    if (clips.length > 0) void warm();
    return () => { cancelled = true; };
  }, [getClipBuffer, clipLookup]);

  const tickMeters = React.useCallback(() => {
    const players = playersRef.current;
    const next = Array.from({ length: tracks.length }, () => 0);
    players.forEach((player) => {
      const analyser = player.analyser;
      if (!analyser) return;
      if (meterDataRef.current.length !== analyser.fftSize) {
        meterDataRef.current = new Uint8Array(analyser.fftSize);
      }
      analyser.getByteTimeDomainData(meterDataRef.current);
      let sum = 0;
      for (let i = 0; i < meterDataRef.current.length; i += 1) {
        const centered = (meterDataRef.current[i] - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / meterDataRef.current.length);
      // mixIndex, not trackIndex. `next` is allocated at performTracks length,
      // while trackIndex counts ALL tracks including return/master — so any
      // trackIndex past the mixer columns wrote off the end of the array and the
      // meter silently died. It only worked because Live emits returns last and
      // the parser drops groups; admitting a group type mid-list desyncs it.
      next[player.mixIndex] = Math.max(next[player.mixIndex] ?? 0, Math.min(1, rms * 5.5));
    });
    setTrackLevels((previous) => next.map((level, index) => Math.max(level, (previous[index] ?? 0) * 0.72)));
    setMasterLevel((previous) => {
      const peak = Math.max(0, ...next);
      return Math.max(peak, previous * 0.76);
    });
    if (startedAtRef.current != null) setElapsedSeconds((performance.now() - startedAtRef.current) / 1000);
    animationRef.current = window.requestAnimationFrame(tickMeters);
  }, [tracks.length]);

  /** Launch a whole row: every clip in it, plus a stop for every column the row
   *  leaves empty, all queued on the SAME grid line. The old body stopped
   *  everything immediately and then started at the next bar, so quantized
   *  scene changes left a silent hole the length of the quantization. */
  const launchScene = React.useCallback(
    async (sceneIndex: number) => {
      const launchToken = launchTokenRef.current + 1;
      launchTokenRef.current = launchToken;
      setLaunchError(null);
      const clips = sceneClips(sceneIndex);
      const context = getEngineCtx();
      // Resuming must happen before the grid line is computed — a suspended
      // context's `currentTime` does not move, so `nextGrid` would read a stale
      // now and the whole scene would land in the past.
      if (context.state === 'suspended') await context.resume();
      if (clips.length === 0) {
        // An empty row still IS a launch in Live: it stops everything. On the
        // grid like any other launch, not the instant the button goes down.
        for (const player of playersRef.current) {
          queueLaunch({ mixIndex: player.mixIndex, sceneIndex, entry: null, origin: 'scene' });
        }
        setActiveScene(sceneIndex);
        return;
      }
      const launching = new Set(clips.map((c) => c.mixIndex));
      // Plays first: a stop queued behind them sees the incoming players and so
      // never mistakes the handover for "the session is empty now".
      for (const entry of clips) {
        void getClipBuffer(entry.clip).catch(() => { /* reported below */ });
        queueLaunch({ mixIndex: entry.mixIndex, sceneIndex, entry, origin: 'scene' });
      }
      for (const player of playersRef.current) {
        if (!launching.has(player.mixIndex)) {
          queueLaunch({ mixIndex: player.mixIndex, sceneIndex, entry: null, origin: 'scene' });
        }
      }
      // Decoding does not block the launch any more, so the banner is settled
      // separately. One bad clip must not stop the rest of the scene playing;
      // each failure is still logged with its own reason.
      const outcomes = await Promise.allSettled(clips.map((c) => getClipBuffer(c.clip)));
      if (launchTokenRef.current !== launchToken) return;
      let failed = 0;
      outcomes.forEach((outcome, i) => {
        if (outcome.status !== 'rejected') return;
        failed += 1;
        const reason = outcome.reason;
        logError(
          'perform',
          `Clip "${clips[i].clip.name}" could not play: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      });
      setLaunchError(failed > 0 ? `${failed} of ${outcomes.length} clip(s) could not be played.` : null);
    },
    [getClipBuffer, queueLaunch, sceneClips],
  );

  /** Launch ONE cell, leaving every other column playing — Live's core move.
   *  Replaces the old behaviour where clicking any cell relaunched the whole
   *  row, so there was no way to hold a bassline while changing drums. */
  const launchClip = React.useCallback(
    async (mixIndex: number, sceneIndex: number) => {
      const context = getEngineCtx();
      if (context.state === 'suspended') await context.resume();
      // An empty slot IS a command in Live: it stops that track, on the grid.
      const entry = sceneClips(sceneIndex).find((c) => c.mixIndex === mixIndex) ?? null;
      if (entry) {
        setLaunchError(null);
        // Start decoding on the press so the buffer is ready by the grid line.
        void getClipBuffer(entry.clip).catch((e) => {
          logError('perform', `Clip "${entry.clip.name}" could not play: ${e instanceof Error ? e.message : String(e)}`);
          setLaunchError(`"${entry.clip.name}" could not be played.`);
        });
      }
      queueLaunch({ mixIndex, sceneIndex, entry, origin: 'clip' });
    },
    [getClipBuffer, queueLaunch, sceneClips],
  );

  // --- Live modulation from the Sway dims ------------------------------------
  // The hand-tracking dimensions (strike / sway / pulse / glide / press / sculpt)
  // route to a Perform-mix function (a track's volume or mute) via the routing
  // panel. Reading swayBus's normalized 0..1 values here applies them to the live
  // track gains and to the mix layer future scene launches inherit.
  const tracksRef = React.useRef(tracks);
  React.useEffect(() => { tracksRef.current = tracks; }, [tracks]);

  const applyMixToTrack = React.useCallback((mixIndex: number) => {
    const track = tracksRef.current[mixIndex];
    if (!track) return;
    const mix = mixRef.current.get(mixIndex);
    const vol = mix?.vol ?? 1;
    const modMuted = mix?.mute ?? false;
    // Fold in the track's OWN mute/solo (plus any live override from the S/M
    // buttons). This used to consider only the Sway modulation mute, so a track
    // muted in Live played anyway and solo did nothing at all.
    const st = trackStateRef.current[mixIndex] ?? { mute: !!track.mute, solo: !!track.solo };
    const anySolo = tracksRef.current.some(
      (t, i) => (trackStateRef.current[i] ?? { solo: !!t.solo }).solo,
    );
    const audible = !st.mute && !modMuted && !(anySolo && !st.solo);
    const target = dbToVolume(track.volume_db) * vol * (audible ? 1 : 0);
    const context = getEngineCtx();
    for (const player of playersRef.current) {
      if (player.mixIndex === mixIndex && player.gain) {
        player.gain.gain.setTargetAtTime(target, context.currentTime, 0.02);
      }
    }
  }, []);

  /** Live mute/solo state per mixer column, seeded from the imported project and
   *  then owned by the S/M buttons. A ref so the audio callbacks read it without
   *  re-subscribing; mirrored into state purely for rendering. */
  const trackStateRef = React.useRef<Record<number, { mute: boolean; solo: boolean }>>({});
  const [trackStateVersion, setTrackStateVersion] = React.useState(0);
  React.useEffect(() => {
    trackStateRef.current = Object.fromEntries(
      tracks.map((t, i) => [i, { mute: !!t.mute, solo: !!t.solo }]),
    );
    setTrackStateVersion((v) => v + 1);
  }, [tracks]);

  /** Re-apply every column: solo is a project-wide decision, so toggling one
   *  track changes what every other track should be doing. */
  const applyAllMix = React.useCallback(() => {
    tracksRef.current.forEach((_, i) => applyMixToTrack(i));
  }, [applyMixToTrack]);

  const toggleTrackMute = React.useCallback((mixIndex: number) => {
    const cur = trackStateRef.current[mixIndex] ?? { mute: false, solo: false };
    trackStateRef.current[mixIndex] = { ...cur, mute: !cur.mute };
    setTrackStateVersion((v) => v + 1);
    applyAllMix();
  }, [applyAllMix]);

  const toggleTrackSolo = React.useCallback((mixIndex: number) => {
    const cur = trackStateRef.current[mixIndex] ?? { mute: false, solo: false };
    trackStateRef.current[mixIndex] = { ...cur, solo: !cur.solo };
    setTrackStateVersion((v) => v + 1);
    applyAllMix();
  }, [applyAllMix]);

  /** The track as the mixer should DISPLAY it (base project state + live S/M). */
  const displayTrack = React.useCallback(
    (track: DawTrack, mixIndex: number): DawTrack => {
      void trackStateVersion; // re-read after a toggle
      const st = trackStateRef.current[mixIndex];
      return st ? { ...track, mute: st.mute, solo: st.solo } : track;
    },
    [trackStateVersion],
  );

  /* --- Firing a queued launch ----------------------------------------------
     Runs on the pump tick, `lead` seconds ahead of the ticket's grid line, so
     everything below schedules AT `ticket.at` rather than "now". */
  const fireTicket = React.useCallback(
    (ticket: LaunchTicket, context: AudioContext) => {
      const pending = pendingRef.current.get(ticket.slotId);
      pendingRef.current.delete(ticket.slotId);
      if (!pending) return;
      const { mixIndex, sceneIndex, entry, origin, gen } = pending;
      setQueuedSlots((prev) => {
        if (!(mixIndex in prev)) return prev;
        const next = { ...prev };
        delete next[mixIndex];
        return next;
      });

      // Hand the column over on the line: the outgoing clip stops at exactly
      // the instant the incoming one starts.
      const stay = playersRef.current.filter((p) => p.mixIndex !== mixIndex);
      const go = playersRef.current.filter((p) => p.mixIndex === mixIndex);
      playersRef.current = stay;
      if (go.length > 0) scheduleStopPlayers(go, ticket.at);

      if (ticket.action === 'stop' || !entry) {
        setTrackScenes((prev) => {
          const next = { ...prev };
          delete next[mixIndex];
          return next;
        });
        // A SCENE's stop does not clear the active row: the launch that queued
        // it already named the row, and the other columns of the same launch
        // may not have fired yet. Only a single-cell stop can empty the grid.
        if (origin === 'clip' && stay.length === 0) setActiveScene(null);
        return;
      }

      const start = (buffer: AudioBuffer, startAt: number) => {
        const player = startClipPlayer(context, {
          buffer,
          clip: entry.clip,
          track: displayTrack(entry.track, mixIndex),
          trackIndex: entry.trackIndex,
          mixIndex,
          sceneIndex,
          startAt,
          projectTempo: project.tempo || 120,
          mix: mixRef.current.get(mixIndex),
          destination: ensureTrackChain(mixIndex, entry.track).input,
          analyser: ensureTrackChain(mixIndex, entry.track).analyser,
          anySolo: tracksRef.current.some(
            (t, i) => (trackStateRef.current[i] ?? { solo: !!t.solo }).solo,
          ),
        });
        playersRef.current = [...playersRef.current, player];
        setTrackScenes((prev) => ({ ...prev, [mixIndex]: sceneIndex }));
        if (origin === 'scene') setActiveScene(sceneIndex);
        startedAtRef.current ??= performance.now();
        if (animationRef.current == null) animationRef.current = window.requestAnimationFrame(tickMeters);
      };

      const ready = bufferReadyRef.current.get(clipCacheKey(entry.clip));
      if (ready) {
        start(ready, Math.max(ticket.at, context.currentTime));
        return;
      }
      // Pressed before the warm-up reached this cell: start it the moment it
      // decodes, which is as close to the line as the decode allows. A newer
      // press on the same column wins, so a slow clip never jumps the queue.
      void getClipBuffer(entry.clip)
        .then((buffer) => {
          if (columnGenRef.current.get(mixIndex) !== gen) return;
          const ctx = getEngineCtx();
          start(buffer, Math.max(ticket.at, ctx.currentTime));
        })
        .catch(() => { /* logged by the press that queued it */ });
    },
    [displayTrack, ensureTrackChain, getClipBuffer, project.tempo, tickMeters],
  );

  // The pump: take everything due and fire it, then stand down once the queue
  // is empty. Kept in a ref so the interval never has to be torn down and
  // rebuilt as the callbacks above re-create.
  React.useEffect(() => {
    pumpRef.current = () => {
      const context = getEngineCtx();
      for (const ticket of launchQueue.advance(context.currentTime)) fireTicket(ticket, context);
      if (launchQueue.pending().length === 0) stopPump();
    };
  }, [fireTicket, launchQueue, stopPump]);

  // Direct CC routes (auto-created from the set's own MIDI-learn mappings, or
  // assigned on the Sway deck). Ref'd so the single MIDI subscription below can
  // apply them without re-subscribing when the mix callbacks re-create.
  const applyCcModRef = React.useRef<(cm: import('../../state/performRouting').CcMod, value01: number) => void>(() => {});
  React.useEffect(() => {
    applyCcModRef.current = (cm, value01) => {
      if (cm.target === 'fx') {
        // Reach the running chain entry. The chain is built lazily on first
        // launch; ensure it here so a knob works before the first clip fires.
        const track = tracksRef.current[cm.trackIndex];
        if (!track || cm.deviceIndex == null || !cm.paramKey) return;
        const chain = ensureTrackChain(cm.trackIndex, track);
        const lo = cm.min ?? 0;
        const hi = cm.max ?? 1;
        chain.handle?.updateParams(`perform-${cm.trackIndex}-${cm.deviceIndex}`, {
          [cm.paramKey]: lo + value01 * (hi - lo),
        });
        return;
      }
      const cur = mixRef.current.get(cm.trackIndex) ?? { vol: 1, mute: false };
      if (cm.target === 'mute') cur.mute = value01 > 0.5;
      else cur.vol = value01;
      mixRef.current.set(cm.trackIndex, cur);
      applyMixToTrack(cm.trackIndex);
    };
  }, [applyMixToTrack, ensureTrackChain]);

  React.useEffect(() => {
    const unsub = subscribeSwayValue((dim, value) => {
      const mods = usePerformRoutingStore.getState().trackMods.filter((m) => m.dim === dim);
      if (mods.length === 0) return;
      for (const m of mods) {
        const cur = mixRef.current.get(m.trackIndex) ?? { vol: 1, mute: false };
        if (m.target === 'volume') cur.vol = value;
        else cur.mute = value > 0.5;
        mixRef.current.set(m.trackIndex, cur);
        applyMixToTrack(m.trackIndex);
      }
    });
    return unsub;
  }, [applyMixToTrack]);

  // Removing a modulation route returns its track to neutral, so a track never
  // stays stuck at the last modulated gain/mute after its mod is deleted.
  const trackMods = usePerformRoutingStore((s) => s.trackMods);
  const ccMods = usePerformRoutingStore((s) => s.ccMods);
  React.useEffect(() => {
    const modVol = new Set(trackMods.filter((m) => m.target === 'volume').map((m) => m.trackIndex));
    const modMute = new Set(trackMods.filter((m) => m.target === 'mute').map((m) => m.trackIndex));
    for (const m of ccMods) {
      if (m.target === 'volume') modVol.add(m.trackIndex);
      else if (m.target === 'mute') modMute.add(m.trackIndex);
      // fx routes live in the chain, not the mix layer — nothing to neutralize here
    }
    for (const [index, mix] of mixRef.current) {
      let changed = false;
      if (!modVol.has(index) && mix.vol !== 1) { mix.vol = 1; changed = true; }
      if (!modMute.has(index) && mix.mute) { mix.mute = false; changed = true; }
      if (changed) applyMixToTrack(index);
    }
    // Latch state follows its mod: a removed/replaced punch must not leave a
    // phantom "on" that inverts the next project's toggle.
    const ids = new Set(ccMods.map((m) => m.id));
    for (const id of latchedRef.current) {
      if (!ids.has(id)) latchedRef.current.delete(id);
    }
  }, [trackMods, ccMods, applyMixToTrack]);

  // --- Live scene control from assigned Sway controls ------------------------
  // Assignments live in performRouting: Scene Select moves the highlighted scene,
  // Launch fires it, plus Stop / Scene +/- and direct per-scene controls. Pads
  // deliberately do NOT launch scenes. Refs keep the one MIDI subscription stable
  // across renders; learn is armed from the routing panel and captured here.
  const launchSceneRef = React.useRef(launchScene);
  const stopSceneRef = React.useRef(stopScene);
  const sceneCountRef = React.useRef(sceneCount);
  const selectedSceneRef = React.useRef(selectedScene);
  React.useEffect(() => { launchSceneRef.current = launchScene; }, [launchScene]);
  React.useEffect(() => { stopSceneRef.current = stopScene; }, [stopScene]);
  React.useEffect(() => { sceneCountRef.current = sceneCount; }, [sceneCount]);
  React.useEffect(() => { selectedSceneRef.current = selectedScene; }, [selectedScene]);

  // Keep the highlighted scene inside range when a smaller project loads.
  React.useEffect(() => {
    setSelectedScene((prev) => Math.min(Math.max(0, prev), Math.max(0, sceneCount - 1)));
  }, [sceneCount]);

  const selectAndLaunch = React.useCallback((index: number) => {
    const clamped = Math.min(Math.max(0, index), Math.max(0, sceneCountRef.current - 1));
    setSelectedScene(clamped);
    setLastAction(`Launch ${clamped + 1}`);
    void launchSceneRef.current(clamped);
  }, []);

  React.useEffect(() => {
    void enableMidi();
    const unsub = subscribeToMidi((msg) => {
      const data = msg.data;
      const status = data[0] ?? 0;
      const cmd = status & 0xf0;
      const ch = status & 0x0f;
      const isCc = cmd === 0xb0;
      const isNoteOn = cmd === 0x90 && (data[2] ?? 0) > 0;
      // Note-off matters now: momentary note-driven fx punches release on it.
      const isNoteOff = cmd === 0x80 || (cmd === 0x90 && (data[2] ?? 0) === 0);
      if (!isCc && !isNoteOn && !isNoteOff) return; // aftertouch / etc. ignored
      const num = data[1] ?? 0;
      const val = data[2] ?? 0;
      const st = usePerformRoutingStore.getState();

      // Learn: bind the armed function/scene to this control, then disarm.
      // Only activations bind — a release must not capture as a phantom CC.
      if (st.learn) {
        if (isNoteOff) return;
        const ctrl = { isNote: isNoteOn, channel: ch, number: num };
        if (st.learn.kind === 'fn') st.bindFn(st.learn.fn, ctrl);
        else st.bindScene(st.learn.scene, ctrl);
        return;
      }

      // Project-derived direct routes: the imported set's own MIDI-learn
      // mappings, applied to the live Perform mix with zero setup. Checked
      // before transport so a fader CC that happens to share a number with a
      // learned button still moves the fader it was mapped to in the DAW.
      if (isCc) {
        for (const cm of st.ccMods) {
          if (cm.isNote || cm.number !== num) continue;
          if (cm.channel >= 0 && cm.channel !== ch) continue;
          applyCcModRef.current(cm, val / 127);
        }
      }

      // Note-driven routes: pad punches. Momentary (default) pushes max on
      // press and min on release; `latch` toggles max/min on each press.
      // Like the CC loop above this does not return — a note shared with a
      // sceneCtrl fires both, mirroring the CC double-fire semantics.
      if (isNoteOn || isNoteOff) {
        for (const cm of st.ccMods) {
          if (!cm.isNote || cm.number !== num) continue;
          if (cm.channel >= 0 && cm.channel !== ch) continue;
          if (cm.latch) {
            if (!isNoteOn) continue;
            const on = !latchedRef.current.has(cm.id);
            if (on) latchedRef.current.add(cm.id);
            else latchedRef.current.delete(cm.id);
            applyCcModRef.current(cm, on ? 1 : 0);
          } else {
            applyCcModRef.current(cm, isNoteOn ? 1 : 0);
          }
        }
        // A release has no further meaning — scenes/transport fire on
        // activation only, and falling through would misread vel-0 as one.
        if (isNoteOff) return;
      }

      const count = sceneCountRef.current;
      if (count <= 0) return;

      // Scene Select encoder (CC): map its value across the scene range.
      const sel = st.transport.select;
      if (sel && isCc && ctrlMatches(sel, false, ch, num)) {
        const idx = Math.min(count - 1, Math.max(0, Math.round((val / 127) * (count - 1))));
        setSelectedScene(idx);
        setLastAction(`Select ${idx + 1}`);
        return;
      }

      // Everything else triggers on activation (note-on, or a CC button > 0).
      const activated = isNoteOn || (isCc && val > 0);
      if (!activated) return;
      const msgIsNote = isNoteOn;

      // Direct per-scene launch.
      for (const [key, ctrl] of Object.entries(st.sceneCtrls)) {
        if (ctrlMatches(ctrl, msgIsNote, ch, num)) {
          selectAndLaunch(Number(key));
          return;
        }
      }

      const { transport } = st;
      if (transport.launch && ctrlMatches(transport.launch, msgIsNote, ch, num)) {
        selectAndLaunch(selectedSceneRef.current);
      } else if (transport.stop && ctrlMatches(transport.stop, msgIsNote, ch, num)) {
        setLastAction('Stop');
        stopSceneRef.current();
      } else if (transport.next && ctrlMatches(transport.next, msgIsNote, ch, num)) {
        selectAndLaunch(selectedSceneRef.current + 1);
      } else if (transport.prev && ctrlMatches(transport.prev, msgIsNote, ch, num)) {
        selectAndLaunch(selectedSceneRef.current - 1);
      }
    });
    return unsub;
  }, [selectAndLaunch]);

  const launchPreviousScene = () => {
    if (scenes.length === 0) return;
    selectAndLaunch((activeScene ?? selectedScene) - 1);
  };

  const launchNextScene = () => {
    if (scenes.length === 0) return;
    selectAndLaunch((activeScene ?? selectedScene) + 1);
  };

  if (tracks.length === 0 || scenes.length === 0) return null;

  // An arrangement-only Live Set still ships 8 <Scene> elements, so the header
  // said "8 scenes / 12 tracks" and the grid below was an entirely empty wall of
  // greyed-out cells with no explanation. Say what happened and point at the
  // surface that DOES have the content.
  if (clipLookup.size === 0) {
    return (
      <div className={`border border-white/10 bg-[#2f3238] ${fill ? 'h-full' : ''} grid place-items-center p-6`}>
        <div className="flex flex-col items-center gap-2 text-center max-w-md">
          <Square className="w-6 h-6 text-zinc-600" />
          <div className="text-[11px] font-bold text-zinc-300">No session clips in this project</div>
          <p className="text-[9px] font-mono text-zinc-500 leading-relaxed">
            {`This set's ${tracks.length} track${tracks.length === 1 ? '' : 's'} put their clips on the arrangement timeline rather than in Session view, so there is nothing to launch here. Use “Edit Timeline” to open the arrangement.`}
          </p>
        </div>
      </div>
    );
  }

  const activeSceneName = activeScene == null ? 'Stopped' : scenes[activeScene];
  const masterDb = linearToDb(masterLevel);
  const masterMeterLabel = masterDb <= -71 ? '-inf' : masterDb.toFixed(1);

  return (
    <div className={`border border-white/10 bg-[#2f3238] overflow-hidden ${fill ? 'h-full flex flex-col' : ''}`}>
      <div className="shrink-0 flex items-center gap-1 border-b border-black/70 bg-[#202329] px-2 py-1 text-[10px] font-bold text-zinc-200">
        {/* Transport leads the row: the surface play key (launch the selected
            scene, or stop all clips while one plays), then stop, the scene
            steppers, and record arm last. */}
        <div className="mr-1 flex items-center gap-1">
          <SurfacePlayKey
            size="bar"
            playing={activeScene != null}
            onToggle={() => (activeScene == null ? selectAndLaunch(selectedScene) : stopScene())}
            what="the session"
            title={activeScene == null ? 'Play selected scene' : 'Stop all clips'}
          />
          <button
            type="button"
            onClick={stopScene}
            className="h-7 w-8 grid place-items-center border border-red-900/70 bg-[#3a1719] text-red-200 hover:bg-[#5a2024]"
            aria-label="Stop session"
            title="Stop all clips"
          >
            <Square className="h-4 w-4 fill-current" />
          </button>
          <button
            type="button"
            onClick={() => void launchPreviousScene()}
            className="h-7 w-7 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300 hover:bg-[#3a3d45] hover:text-white"
            aria-label="Launch previous scene"
            title="Previous scene"
          >
            <SkipBack className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void launchNextScene()}
            className="h-7 w-7 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300 hover:bg-[#3a3d45] hover:text-white"
            aria-label="Launch next scene"
            title="Next scene"
          >
            <SkipForward className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="h-7 w-7 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-400"
            aria-label="Record arm"
            title="Record arm placeholder"
          >
            <Circle className="h-3.5 w-3.5 fill-current text-zinc-500" />
          </button>
        </div>
        <div className="h-6 px-2 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300">
          {/* Real time signature from the set, not a hardcoded "4 / 4". */}
          {`${project.time_signature?.[0] ?? 4} / ${project.time_signature?.[1] ?? 4}`}
        </div>
        {/* Launch quantization is a grid on the shared clock now, not a bar
            count multiplied out by hand — so "next bar" means the same instant
            here as it does in LOOM, and sub-bar lines exist at all. */}
        <label htmlFor="session-quantize" className="sr-only">Launch quantization</label>
        <select
          id="session-quantize"
          name="sessionQuantize"
          value={launchGrid}
          onChange={(e) => { if (isLaunchGrid(e.target.value)) setLaunchGrid(e.target.value); }}
          title="Launch quantization — a press waits for the next line of this grid on the shared clock, so layered launches stay in time"
          className="h-6 px-2 border border-black/50 bg-[#15171b] text-zinc-300 text-[10px] font-bold outline-none cursor-pointer"
          style={{ colorScheme: 'dark' }}
        >
          {LAUNCH_GRIDS.map((g) => (
            <option key={g.value} value={g.value}>{g.label}</option>
          ))}
        </select>
        <div className="h-6 px-2 grid place-items-center border border-black/50 bg-[#15171b] text-zinc-300">
          {project.tempo.toFixed(2)}
        </div>
        <div
          className="h-6 px-2 grid place-items-center border border-black/50 bg-[#15171b] font-mono text-[9px]"
          title="Scene launch is driven by the controls you assign in Perform Routing: turn the assigned encoder to select, push to launch. Pads stay free for MIDI / modulation."
        >
          <span className={lastAction ? 'text-emerald-300' : 'text-zinc-400'}>
            {`Sel ${selectedScene + 1}${lastAction ? ` · ${lastAction}` : ''}`}
          </span>
        </div>
        <div className="ml-auto h-7 min-w-32 px-2 flex items-center justify-between border border-black/50 bg-[#15171b] font-mono text-[10px] text-zinc-300">
          <span>{elapsedSeconds.toFixed(1)}</span>
          <span className="text-zinc-500">sec</span>
        </div>
        <div className="h-7 min-w-48 px-2 flex items-center border border-black/50 bg-[#15171b] font-mono text-[10px] text-zinc-300">
          <span className={activeScene == null ? 'text-zinc-500' : 'text-emerald-200'}>{activeSceneName}</span>
        </div>
      </div>

      <div className={`overflow-auto ${fill ? 'flex-1 min-h-0' : 'max-h-140'}`}>
        <div
          className="grid min-w-245"
          style={{
            gridTemplateColumns: `118px repeat(${tracks.length}, minmax(116px, 1fr)) 86px`,
          }}
        >
          <div className="sticky left-0 z-20 bg-[#202329] border-r-2 border-b-2 border-black/70 px-2 py-1.5 text-[9px] font-bold text-zinc-300">
            Scenes
          </div>
          {tracks.map((track, trackIndex) => {
            const color = CLIP_COLORS[trackIndex % CLIP_COLORS.length];
            return (
              <div
                key={`${track.name}-${trackIndex}`}
                className={`${color.header} border-r-2 border-b-2 border-black/70 px-1.5 py-1 min-w-0`}
              >
                <div className="text-[10px] font-black truncate">{String(trackIndex + 1).padStart(2, '0')} {track.name}</div>
                <div className="text-[8px] font-mono opacity-70 uppercase">{track.type}</div>
              </div>
            );
          })}
          <div className="bg-[#afd4dc] text-black border-b-2 border-black/70 px-1.5 py-1 text-[10px] font-black">
            Main
          </div>

          {scenes.map((sceneName, sceneIndex) => {
            const sceneColor = CLIP_COLORS[sceneIndex % CLIP_COLORS.length].scene;
            const hasClips = sceneClips(sceneIndex).length > 0;
            return (
              <React.Fragment key={`${sceneName}-${sceneIndex}`}>
                <button
                  type="button"
                  onClick={() => selectAndLaunch(sceneIndex)}
                  disabled={!hasClips}
                  className={[
                    'sticky left-0 z-10 min-h-7 border-r-2 border-b border-black/70 px-1.5 text-left',
                    activeScene === sceneIndex
                      ? 'bg-[#2affb0] text-black'
                      : selectedScene === sceneIndex
                        ? 'bg-[#3b3f47] text-emerald-200 ring-1 ring-inset ring-emerald-400/70'
                        : 'bg-[#3b3f47] text-zinc-200 hover:bg-[#4a4f59]',
                    !hasClips ? 'opacity-45 cursor-not-allowed' : '',
                  ].join(' ')}
                  aria-label={`Launch ${sceneName}`}
                  title="Launch scene (also sets it as the highlighted scene)"
                >
                  <div className="flex items-center gap-1 min-w-0">
                    <Play className="h-3 w-3 fill-current shrink-0" />
                    <span className="truncate text-[10px] font-bold">{String(sceneIndex + 1).padStart(2, '0')} {sceneName}</span>
                  </div>
                </button>
                {tracks.map((track, mixIndex) => {
                  // TWO index spaces meet here. `trackIndex` is the clip's
                  // column in the SOURCE DAW and is only ever a lookup key;
                  // `mixIndex` is this column's position in the mixer and is
                  // the one every piece of launch state is keyed by, because
                  // that is what `sceneClips` and the launch queue use. Mixing
                  // them gave one column two slot ids on sets where they
                  // diverge, and replace-not-stack stopped holding across the
                  // scene and cell launch paths.
                  const trackIndex = track.clips.find((clip) => clip.track_index != null)?.track_index ?? mixIndex;
                  const clip = clipLookup.get(clipKey(trackIndex, sceneIndex));
                  const color = CLIP_COLORS[sceneIndex % CLIP_COLORS.length];
                  // Pressed, waiting for its grid line. The ring is on the cell
                  // that was pressed, so the row a queued stop came from is
                  // visible too.
                  const isQueued = queuedSlots[mixIndex] === sceneIndex;
                  const queuedRing = isQueued
                    ? 'ring-2 ring-inset ring-white animate-pulse motion-reduce:animate-none'
                    : '';
                  return (
                    <div
                      key={`${trackIndex}-${sceneIndex}`}
                      className={[
                        'border-r-2 border-b border-black/70 min-h-7 bg-[#30343b]',
                        trackScenes[mixIndex] === sceneIndex ? 'ring-1 ring-inset ring-emerald-200' : '',
                      ].filter(Boolean).join(' ')}
                    >
                      {clip ? (
                        <button
                          type="button"
                          onClick={() => void launchClip(mixIndex, sceneIndex)}
                          disabled={!isPlayableClip(clip)}
                          aria-label={isQueued ? `${clip.name} queued on ${track.name}` : `Launch ${clip.name} on ${track.name}`}
                          className={[
                            'h-7 w-full px-1.5 flex items-center gap-1 border text-left',
                            clipStyle(clip, color.clip),
                            queuedRing,
                            !isPlayableClip(clip) ? 'opacity-45 cursor-not-allowed' : 'hover:brightness-110',
                          ].filter(Boolean).join(' ')}
                          style={clip.color ? { backgroundColor: clip.color, borderColor: clip.color } : undefined}
                          title={isQueued ? `${clip.name} — queued for the next launch line` : clipTitle(clip)}
                        >
                          <Play className="h-3 w-3 fill-current shrink-0" />
                          <span className="min-w-0 truncate text-[10px] font-bold">{clip.name}</span>
                        </button>
                      ) : (
                        /* An empty slot is a STOP button in Live, not dead space. */
                        <button
                          type="button"
                          onClick={() => void launchClip(mixIndex, sceneIndex)}
                          aria-label={isQueued ? `Stop ${track.name} queued` : `Stop ${track.name}`}
                          title={isQueued ? `Stop ${track.name} — queued for the next launch line` : `Stop ${track.name}`}
                          className={[
                            'h-7 w-full bg-[#262a31] border border-black/20 flex items-center justify-center text-zinc-700 hover:text-zinc-200 hover:bg-[#2f343c]',
                            queuedRing,
                          ].filter(Boolean).join(' ')}
                        >
                          <Square className="h-2.5 w-2.5 fill-current" />
                        </button>
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() => selectAndLaunch(sceneIndex)}
                  disabled={!hasClips}
                  className={[
                    'min-h-7 border-b border-black/70 px-1.5 flex items-center gap-1 text-black',
                    sceneColor,
                    activeScene === sceneIndex ? 'brightness-125' : 'hover:brightness-110',
                    !hasClips ? 'opacity-45 cursor-not-allowed' : '',
                  ].join(' ')}
                  aria-label={`Launch main scene ${sceneName}`}
                >
                  <Play className="h-3 w-3 fill-current shrink-0" />
                  <span className="min-w-0 truncate text-[10px] font-bold">{String(sceneIndex + 1).padStart(2, '0')} {sceneName}</span>
                </button>
              </React.Fragment>
            );
          })}

          <div className="sticky left-0 z-10 bg-[#3b3f47] border-r-2 border-t-2 border-black/70 px-2 py-2 text-[9px] font-bold text-zinc-200">
            Mixer
          </div>
          {tracks.map((track, trackIndex) => (
            <TrackMixer
              key={`mixer-${track.name}-${trackIndex}`}
              track={displayTrack(track, trackIndex)}
              trackNumber={trackIndex + 1}
              level={trackLevels[trackIndex] ?? 0}
              mixIndex={trackIndex}
              onToggleMute={toggleTrackMute}
              onToggleSolo={toggleTrackSolo}
            />
          ))}
          <div className="bg-[#454a54] border-t-2 border-black/70 px-2 py-2">
            <div className="flex items-end justify-center gap-2">
              <div className="h-28 w-5 border border-black/80 bg-[#101215] p-px flex items-end">
                <div className="w-full bg-linear-to-t from-emerald-500 via-lime-400 to-red-500" style={{ height: meterHeight(masterLevel) }} />
              </div>
              <div className="min-w-0">
                <div className="mb-1 rounded bg-[#202329] px-1 py-0.5 text-center text-[9px] font-mono text-zinc-100">
                  {masterMeterLabel}
                </div>
                <div className="text-[10px] font-black text-zinc-100">Main</div>
                <div className="text-[8px] font-mono text-zinc-400">1 / 2</div>
              </div>
            </div>
            <button
              type="button"
              onClick={stopScene}
              className="mt-2 h-7 w-full border border-red-900/70 bg-[#3a1719] text-[9px] font-black uppercase tracking-wider text-red-100 hover:bg-[#5a2024]"
            >
              Stop All
            </button>
          </div>
        </div>
      </div>

      {launchError && (
        <div className="shrink-0 border-t border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[8px] font-mono text-amber-100">
          {launchError}
        </div>
      )}
    </div>
  );
};

const TrackMixer: React.FC<{
  track: DawTrack;
  trackNumber: number;
  level: number;
  mixIndex: number;
  onToggleMute?: (mixIndex: number) => void;
  onToggleSolo?: (mixIndex: number) => void;
}> = ({
  track,
  trackNumber,
  level,
  mixIndex,
  onToggleMute,
  onToggleSolo,
}) => {
  const db = linearToDb(level);
  const label = db <= -71 ? '-inf' : db.toFixed(1);
  return (
    <div className="bg-[#343841] border-r-2 border-t-2 border-black/70 px-2 py-2 min-w-0">
      <div className="h-16 border border-black/80 bg-[#1b1e23] px-1 py-1 text-[8px] font-bold text-zinc-200">
        <div className="flex items-center justify-between gap-1">
          <span>Audio From</span>
          <span className="text-zinc-500">Ext. In</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-1">
          <span>Monitor</span>
          <span className="text-zinc-500">Auto</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-1">
          <span>Audio To</span>
          <span className="text-zinc-500">Main</span>
        </div>
      </div>
      <div className="mt-2 flex items-end justify-center gap-2">
        <div className="flex flex-col items-center gap-1">
          <div className="rounded bg-[#15171b] px-1 py-0.5 text-[9px] font-mono text-zinc-100">
            {label}
          </div>
          <div className="h-7 w-7 rounded-full border-2 border-black/80 bg-[#242832] grid place-items-center">
            <div className="h-3 w-px bg-zinc-300" style={{ transform: `rotate(${track.pan * 55}deg)`, transformOrigin: '50% 100%' }} />
          </div>
          <div className="h-6 w-6 grid place-items-center bg-pink-300 text-[11px] font-black text-black">
            {trackNumber}
          </div>
          {/* These had no onClick, no aria-label and no aria-pressed — the unmuted
              state was a bare Headphones SVG with no accessible name at all. They
              now reflect and drive the imported track's real state. */}
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => onToggleSolo?.(mixIndex)}
              aria-label={`Solo ${track.name}`}
              aria-pressed={!!track.solo}
              title={`Solo ${track.name}`}
              className={`h-5 w-6 text-[9px] font-bold ${track.solo ? 'bg-sky-400 text-black' : 'bg-[#202329] text-zinc-300 hover:text-white'}`}
            >
              S
            </button>
            <button
              type="button"
              onClick={() => onToggleMute?.(mixIndex)}
              aria-label={`${track.mute ? 'Unmute' : 'Mute'} ${track.name}`}
              aria-pressed={!!track.mute}
              title={`${track.mute ? 'Unmute' : 'Mute'} ${track.name}`}
              className={`h-5 w-6 text-[9px] font-bold ${track.mute ? 'bg-amber-400 text-black' : 'bg-[#202329] text-zinc-300 hover:text-white'}`}
            >
              {track.mute ? 'M' : <Headphones className="mx-auto h-3 w-3" />}
            </button>
          </div>
        </div>
        <div className="h-28 w-5 border border-black/80 bg-[#101215] p-px flex items-end">
          <div className="w-full bg-linear-to-t from-emerald-500 via-lime-400 to-red-500" style={{ height: meterHeight(level) }} />
        </div>
        <div className="h-28 w-5 border border-black/80 bg-[#15171b] relative">
          <div className="absolute inset-x-1 bg-zinc-300" style={{ top: `${Math.round((1 - dbToVolume(track.volume_db)) * 76 + 16)}%`, height: 6 }} />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[8px] font-mono text-zinc-400">
        <span className="inline-flex items-center gap-1">
          <Volume2 className="h-3 w-3" />
          {track.volume_db.toFixed(1)} dB
        </span>
        <span>{track.type}</span>
      </div>
    </div>
  );
};
