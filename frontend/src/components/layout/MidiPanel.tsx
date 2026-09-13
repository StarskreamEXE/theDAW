/**
 * MidiPanel - the unified MIDI tab (merged Piano + Vocal).
 *
 * The shared Piano Roll is the surface; everything else feeds or operates on it.
 * Top to bottom:
 *   - the SETTINGS strip: the roll's transport, instrument, zoom and timing
 *     feel, the library song field with ANALYZE (LOAD / VALIDATE in its menu),
 *     a status readout, the note count and the MIDI mapper (MAP);
 *   - the body: the ACTION rail (REC, IMPORT, EXPORT, EDIT, AI, BEAT, ARP,
 *     VOICE, CLEAR), the roll grid (or the arpeggiator face), the vocal
 *     artifact rail when an artifact is loaded, and the Vocal2MIDI column when
 *     VOICE is on;
 *   - the SHAPE row (VirtuosoControls).
 * Vocal is one INPUT option: a live mic recording is converted to notes through
 * the SAME backend basic-pitch path as "Analyze" (far better than the live YIN),
 * and dropped into the roll without shrinking the grid (the take is highlighted).
 * A mic monitor runs while the tab is open so the input level is always visible
 * inside the REC key. No synthesis here.
 */

import {
  Activity,
  AudioLines,
  Brush,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  Drum,
  FileCheck2,
  FolderOpen,
  Loader2,
  Mic,
  MicVocal,
  Music4,
  Search,
  Square,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { DESKTOP_DROP_ORIGIN, LIBRARY_ID_MIME, dropHasLibraryOrFiles, entriesFromDrop } from '../../lib/libraryDrop';
import type { RenderNote } from '../../lib/midiSynth';
import { renderDrumBeatBlob, vocalizeEffect } from '../../lib/vocalBeat';
import {
  armInpaintGuide,
  downloadVocalMidi,
  fetchVocalArtifact,
  type ArtifactNote,
  type VocalArtifactDoc,
} from '../../lib/vocalExport';
import {
  startInputMonitor,
  type InputMonitor,
} from '../../lib/vocalToMidi';
import { IoSurfaceSelect } from '../audio/IoDeviceSelect';
import { useIoDevicesStore, useResolvedSurface } from '../../state/ioDevicesStore';
import { useLibraryStore } from '../../state/libraryStore';
import { logInfo, logWarn } from '../../state/logStore';
import { describeMicFailure, shouldAnnounceMicFailure } from '../../lib/micErrors';
import { usePianoRollStore, type PianoNote } from '../../state/pianoRollStore';
import { usePlayerStore } from '../../state/playerStore';
import { useBottomPanelStore } from '../../state/bottomPanelStore';
import {
  PianoRoll,
  PianoRollClearKey,
  PianoRollEditKey,
  PianoRollFeel,
  PianoRollMapKey,
  PianoRollNoteCount,
  PianoRollTransport,
  PianoRollZoom,
  exportRollMidi,
  importMidiFileToRoll,
  importSheetFileToRoll,
  playedRollNotes,
} from '../audio/PianoRoll';
import { ArpeggiatorPanel } from '../audio/ArpeggiatorPanel';
import { VirtuosoControls } from '../audio/VirtuosoControls';
import { Vocal2MidiPanel } from '../audio/vocal2midi/Vocal2MidiPanel';
import { AiComposePopover } from '../audio/AiComposePopover';
import { MidiImportPopover } from '../audio/MidiImportPopover';
import { InstrumentPicker } from '../audio/InstrumentPicker';
import {
  CORNER_KEY,
  DockFlyout,
  FIELD,
  FLYOUT_CARD,
  RailKey,
  STRIP_ICON_KEY,
  Sep,
  StripKey,
  keyTone,
  useOrbClearance,
  useStoredToggle,
} from '../audio/midiDockKit';

/** The rail's "more keys this way" cue: a thin band over the rail's end. */
const RAIL_CUE =
  'absolute inset-x-0 z-20 h-3.5 flex items-center justify-center et-ink-2 hover:et-ink';

const stepSec = (bpm: number): number => 60 / bpm / 4;

/** Where the VOICE key remembers whether the Vocal2MIDI column is shown. */
const VOICE_COLUMN_KEY = 'thedaw-midi-voice-column-v1';

const artifactToPiano = (notes: ArtifactNote[], bpm: number): PianoNote[] => {
  const ss = stepSec(bpm);
  return notes.map((n, i) => ({
    id: `art-${i}-${n.start_ms}`,
    note: n.pitch,
    step: Math.max(0, Math.round(n.start_ms / 1000 / ss)),
    length: Math.max(1, Math.round((n.end_ms - n.start_ms) / 1000 / ss)),
    velocity: n.velocity,
  }));
};

const pianoToArtifact = (notes: PianoNote[], bpm: number): ArtifactNote[] => {
  const ss = stepSec(bpm);
  return notes.map((n) => ({
    start_ms: Math.round(n.step * ss * 1000),
    end_ms: Math.round((n.step + n.length) * ss * 1000),
    pitch: n.note,
    velocity: n.velocity,
  }));
};

const pianoToRender = (notes: PianoNote[], bpm: number): RenderNote[] => {
  const ss = stepSec(bpm);
  return notes.map((n) => ({
    midi: n.note,
    startSec: n.step * ss,
    durationSec: Math.max(0.05, n.length * ss),
    velocity: n.velocity,
  }));
};

/**
 * The input level, drawn as a thin bar up the REC key's left edge while the
 * monitor is open. Runs its own rAF so the 60fps level updates never re-render
 * the parent panel (which embeds the Piano Roll). A sibling of the key, not a
 * child: a meter cannot live inside a button.
 */
const RecLevel: React.FC<{ monitorRef: React.MutableRefObject<InputMonitor | null>; recording: boolean }> = ({
  monitorRef,
  recording,
}) => {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setLevel(monitorRef.current?.getLevel() ?? 0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [monitorRef]);
  const pct = Math.round(level * 100);
  return (
    <div
      role="meter"
      aria-label="Microphone input level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="pointer-events-none absolute left-0.5 top-1 bottom-1 w-0.5 rounded-full bg-black/50 overflow-hidden flex flex-col justify-end"
    >
      <div
        className={`w-full rounded-full ${recording ? 'bg-red-400' : 'bg-[rgb(var(--et-ink-2))]'}`}
        style={{ height: `${Math.max(level * 100, 4)}%` }}
      />
    </div>
  );
};

export const MidiPanel: React.FC = () => {
  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const entries = useLibraryStore((s) => s.entries);
  const [assetId, setAssetId] = useState('');
  // What the search box shows (a friendly title); the actual API uses assetId.
  const [assetQuery, setAssetQuery] = useState('');
  const [assetOpen, setAssetOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('idle');
  // ANALYZE's per-second job message. Shown in the readout while it runs, but
  // kept out of the live region, which announces only `status`.
  const [progress, setProgress] = useState('');
  const [artifact, setArtifact] = useState<VocalArtifactDoc | null>(null);
  const [validateMsg, setValidateMsg] = useState('');
  const [arpOn, setArpOn] = useState(false);
  const [voiceOn, setVoiceOn] = useStoredToggle(VOICE_COLUMN_KEY, true);
  // Step width is shared by the strip's zoom keys and the grid's ctrl+wheel.
  const [stepPx, setStepPx] = useState(16);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [inputMenuOpen, setInputMenuOpen] = useState(false);
  const [songMenuOpen, setSongMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const rollBpm = usePianoRollStore((s) => s.bpm);
  // The device comes from the global I/O menu (Settings -> Inputs & outputs),
  // with a per-surface override in the REC key's input menu. It used to be a
  // useState seeded from localStorage with NO try/catch — which threw during
  // render in a browser with site data blocked — and the SING pitch lane kept a
  // second, never-reconciled copy of the very same key.
  const deviceId = useResolvedSurface('midiVocal').deviceId;
  const micPerm = useIoDevicesStore((s) => s.micPermission);
  const monitorRef = useRef<InputMonitor | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordStartRef = useRef(0);
  const recWrapRef = useRef<HTMLDivElement>(null);
  const recInputKeyRef = useRef<HTMLButtonElement>(null);
  const songMenuKeyRef = useRef<HTMLButtonElement>(null);
  const exportKeyRef = useRef<HTMLButtonElement>(null);
  // The rail scrolls when the dock is short; the cues say which way more keys
  // are. The orb, parked on the bottom-left corner, can cover the rail's foot,
  // so the rail ends above it.
  const railRef = useRef<HTMLDivElement>(null);
  const railScrollRef = useRef<HTMLDivElement>(null);
  const railContentRef = useRef<HTMLDivElement>(null);
  const [railMore, setRailMore] = useState({ up: false, down: false });
  // Keys drop from 24px to 22px (and the gaps to 1px) only when that is what
  // keeps the whole rail in view without scrolling.
  const [railCompact, setRailCompact] = useState(false);
  const railOrb = useOrbClearance(railRef);

  useEffect(() => {
    const el = railScrollRef.current;
    if (!el) return;
    const update = () => {
      const content = railContentRef.current;
      if (content) {
        // Compact iff the full-height rail would not fit. The full height is
        // derived the same way in both states, so the switch cannot flap.
        const keys = Array.from(content.children).filter((c) => (c as HTMLElement).offsetHeight > 0).length;
        const saving = keys * 2 + Math.max(0, keys - 1);
        setRailCompact((wasCompact) => {
          const fullHeight = content.offsetHeight + (wasCompact ? saving : 0);
          return fullHeight > el.clientHeight + 1;
        });
      }
      const up = el.scrollTop > 1;
      const down = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setRailMore((p) => (p.up === up && p.down === down ? p : { up, down }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    if (railContentRef.current) ro?.observe(railContentRef.current);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, []);

  const scrollRail = (dir: 1 | -1) => {
    const el = railScrollRef.current;
    if (el) el.scrollBy({ top: dir * Math.max(24, el.clientHeight - 28), behavior: 'smooth' });
  };

  // Default the asset field to the selected library item (override freely). Show
  // the friendly title in the box while keeping the real id for the API.
  useEffect(() => {
    if (selectedEntryId && !assetId) {
      setAssetId(selectedEntryId);
      const sel = useLibraryStore.getState().entries.find((e) => e.id === selectedEntryId);
      if (sel) setAssetQuery(sel.title);
    }
  }, [selectedEntryId, assetId]);

  // Pick a library entry into the asset field: store the real id, show the title.
  const pickAsset = useCallback((id: string, title: string) => {
    setAssetId(id);
    setAssetQuery(title);
    setAssetOpen(false);
  }, []);

  // Library entries whose title matches the current search text (cap the list).
  const assetMatches = (() => {
    const q = assetQuery.trim().toLowerCase();
    const audio = entries.filter((e) => e.kind === 'audio');
    const list = q ? audio.filter((e) => e.title.toLowerCase().includes(q)) : audio;
    return list.slice(0, 12);
  })();

  const refreshInputs = useCallback(async () => {
    await useIoDevicesStore.getState().refresh();
  }, []);

  // Always-on input monitor while the tab is open: opens the mic + an analyser so
  // the level is visible even when not recording. Re-opens when the device
  // changes; releases the mic when the tab unmounts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const monitor = await startInputMonitor(deviceId || undefined);
        if (cancelled) {
          monitor.stop();
          return;
        }
        monitorRef.current = monitor;
        setMonitorOpen(true);
        void refreshInputs();
      } catch (e) {
        if (!cancelled) {
          // Re-enumerate first: a device that went away raises the "not
          // connected" notice from the store, in one place.
          void refreshInputs();
          // A machine with no microphone is not a fault, and this effect re-runs
          // on every device change and remount — so classify it, say it once,
          // and only call it a warning when something is actually wrong.
          const failure = describeMicFailure(e, 'the level meter');
          if (shouldAnnounceMicFailure(failure, 'the level meter')) {
            (failure.benign ? logInfo : logWarn)('vocal', failure.message);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
      try {
        recorderRef.current?.stop();
      } catch {
        /* not recording */
      }
      recorderRef.current = null;
      monitorRef.current?.stop();
      monitorRef.current = null;
      setMonitorOpen(false);
    };
  }, [deviceId, refreshInputs]);

  const loadArtifact = useCallback(async (id: string) => {
    const doc = await fetchVocalArtifact(id);
    if (!doc) {
      setStatus('no artifact for asset (analyze it first)');
      return;
    }
    setArtifact(doc);
    const bpm = doc.timing?.tempo_bpm || usePianoRollStore.getState().bpm;
    usePianoRollStore.getState().importNotes(artifactToPiano(doc.notes, bpm), bpm);
    setStatus(`loaded ${doc.notes.length} notes`);
  }, []);

  // Record the mic, then convert through the backend basic-pitch path and place
  // the take in the roll WITHOUT shrinking the grid (it stays >= 256 steps).
  const toggleRecord = useCallback(() => {
    if (recording) {
      recorderRef.current?.stop(); // onstop does the conversion
      return;
    }
    const monitor = monitorRef.current;
    if (!monitor) {
      setStatus('no mic - check permission / input device');
      return;
    }
    try {
      const rec = new MediaRecorder(monitor.stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = async () => {
        setRecording(false);
        const elapsedSec = (performance.now() - recordStartRef.current) / 1000;
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        logInfo(
          'vocal',
          `recording stopped - ${(blob.size / 1024).toFixed(0)}KB, converting via basic-pitch`,
        );
        setBusy(true);
        setStatus('converting recording to notes...');
        try {
          const fd = new FormData();
          fd.append('file', blob, 'recording.webm');
          const res = await fetch('/api/vocal/audio-to-notes', { method: 'POST', body: fd });
          const data = await res.json();
          const notes: ArtifactNote[] = data.notes ?? [];
          const bpm = usePianoRollStore.getState().bpm;
          const piano = artifactToPiano(notes, bpm);
          const endStep = Math.max(1, Math.ceil(elapsedSec / stepSec(bpm)));
          usePianoRollStore.getState().placeRecording(piano, { startStep: 0, endStep });
          setStatus(`recorded ${piano.length} notes (${elapsedSec.toFixed(1)}s)`);
          logInfo('vocal', `recording -> ${piano.length} notes via basic-pitch`);
        } catch (e) {
          setStatus(`convert error: ${String(e)}`);
          logWarn('vocal', `audio-to-notes failed: ${String(e)}`);
        } finally {
          setBusy(false);
          recorderRef.current = null;
        }
      };
      recorderRef.current = rec;
      recordStartRef.current = performance.now();
      rec.start();
      setRecording(true);
      setStatus('recording - sing, then stop');
      const track = monitor.stream.getAudioTracks()[0];
      const st = track?.getSettings?.() ?? {};
      logInfo(
        'vocal',
        `recording from "${track?.label || 'default'}" ${st.sampleRate ?? '?'}Hz muted=${track?.muted}`,
      );
      window.setTimeout(() => {
        if (recorderRef.current && (monitorRef.current?.getLevel() ?? 0) < 0.02) {
          logWarn('vocal', 'no mic signal during recording (level ~0%) - wrong input or muted');
        }
      }, 1500);
    } catch (e) {
      setStatus(`record error: ${String(e)}`);
      logWarn('vocal', `record error: ${String(e)}`);
    }
  }, [recording]);

  const analyze = useCallback(async () => {
    if (!assetId) {
      setStatus('enter or select an asset id');
      return;
    }
    setBusy(true);
    setStatus('analyzing vocal...');
    try {
      const res = await fetch('/api/vocal/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_id: assetId, transcribe: true }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`prepare ${res.status}: ${detail.slice(0, 200)}`);
      }
      const { job } = await res.json();
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const jr = await fetch(`/api/vocal/jobs/${job.id}`);
        const jd = await jr.json();
        setProgress(jd.message || jd.status);
        if (jd.status === 'done') {
          await loadArtifact(assetId);
          break;
        }
        if (jd.status === 'failed' || jd.status === 'cancelled') {
          setStatus(`analyze ${jd.status}: ${jd.error ?? ''}`);
          break;
        }
      }
    } catch (e) {
      setStatus(`analyze error: ${String(e)}`);
    } finally {
      setProgress('');
      setBusy(false);
    }
  }, [assetId, loadArtifact]);

  const exportMidi = useCallback(() => {
    const { notes, bpm } = usePianoRollStore.getState();
    if (!notes.length) {
      setStatus('no notes to export');
      return;
    }
    // downloadVocalMidi wraps the canonical RenderNote->SMF writer. Export exactly
    // what is in the roll (post-edit), not the stale artifact.
    downloadVocalMidi(pianoToArtifact(notes, bpm), 'midi');
    setStatus(`exported ${notes.length} notes to .mid`);
  }, []);

  const validate = useCallback(async () => {
    if (!assetId) return;
    // The strip's readout carries the result too: the artifact rail that shows
    // validateMsg exists only once an artifact is loaded.
    let msg: string;
    try {
      const r = await fetch(`/api/vocal/validate/${assetId}`);
      const d = await r.json();
      msg = d.ok
        ? `round-trip ${d.count_in} to ${d.count_out}, drift ${d.max_drift_ms}ms`
        : `validate: ${d.error}`;
    } catch (e) {
      msg = `validate error: ${String(e)}`;
    }
    setValidateMsg(msg);
    setStatus(msg);
  }, [assetId]);

  const makeBeat = useCallback(async () => {
    const { notes, bpm, lanes, totalSteps } = usePianoRollStore.getState();
    if (!notes.length) {
      setStatus('no notes for a beat');
      return;
    }
    // The beat renders once, so it gets the lane repeats written out.
    const render = pianoToRender(playedRollNotes(notes, lanes, totalSteps), bpm);
    setStatus('rendering beat...');
    try {
      const { blob } = await renderDrumBeatBlob(render);
      const span = Math.max(...render.map((r) => r.startSec)) + 0.5;
      const fx = vocalizeEffect(render, span);
      // The beat routes through the footer player so the global transport,
      // visualizer, and HUD own its playback instead of a detached element.
      const player = usePlayerStore.getState();
      await player.load(blob, { label: 'MIDI beat' });
      // The beat preview is a one-shot. load() applies the store's loop flag
      // (default true) and has no per-load override, so the visible footer loop
      // toggle is switched off before play; re-enabling it is one click.
      const { isLooping, toggleLoop } = usePlayerStore.getState();
      if (isLooping) toggleLoop();
      player.play();
      setStatus(`beat playing - fx idea: ${fx.effectId} (${fx.reason})`);
    } catch (e) {
      setStatus(`beat error: ${String(e)}`);
    }
  }, []);

  const inpaintSegment = useCallback(
    async (i: number) => {
      if (!artifact) return;
      const ok = await armInpaintGuide(artifact, i);
      setStatus(
        ok
          ? 'inpaint guide armed - open MAKE and Generate to re-sing the segment'
          : 'segment has no mask window (starts at 0)',
      );
    },
    [artifact],
  );

  const listOpen = assetOpen && assetMatches.length > 0;

  return (
    // data-keyscope: this tab and the EDIT timeline both bind Delete; see
    // lib/keyScope. The scope is the whole tab, so a hover over the strip, the
    // rail or the SHAPE row still hands Delete to the roll, as its old toolbar did.
    <div data-keyscope="piano-roll" className="h-full w-full flex flex-col bg-zinc-950 text-zinc-200">
      {/* ── SETTINGS strip ───────────────────────────────────────────────── */}
      <div className="shrink-0 h-7 flex flex-nowrap items-center gap-1 px-1.5 border-b border-white/8 bg-black/40">
        {/* With the ARP face up the roll is hidden, so PLAY cannot start it
            (the arpeggiator has its own); a roll already playing can still stop. */}
        <PianoRollTransport startDisabled={arpOn} />
        <Sep />
        <InstrumentPicker compact />
        <Sep />
        <PianoRollZoom stepPx={stepPx} onStepPxChange={setStepPx} />
        <Sep />
        <PianoRollFeel />
        <Sep />

        {/* Analyze a library vocal into the roll — search by name, drop a
            library item here instead of pasting a raw id, or drop an audio
            file from the desktop (it imports to the library, then lands here). */}
        <div
          className={`${FIELD} relative w-44`}
          onDragOver={(e) => {
            if (dropHasLibraryOrFiles(e.dataTransfer)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={(e) => {
            const dt = e.dataTransfer;
            if (!dropHasLibraryOrFiles(dt)) return;
            e.preventDefault();
            const id = dt.getData(LIBRARY_ID_MIME);
            // A desktop drop imports its first audio file, then picks it.
            void entriesFromDrop(dt, { entries: useLibraryStore.getState().entries, origin: DESKTOP_DROP_ORIGIN, max: 1 }).then(([first]) => {
              if (first) {
                pickAsset(first.id, first.title);
                if (!id) logInfo('vocal', `Imported "${first.title}" from the desktop into the song box`);
              } else if (id) {
                // An id the library does not know: keep the raw id, as before.
                pickAsset(id, id);
              }
            });
          }}
        >
          <Search aria-hidden="true" className="w-3 h-3 shrink-0 et-ink-3" />
          <label htmlFor="midi-asset-id" className="sr-only">
            Search library song
          </label>
          <input
            id="midi-asset-id"
            name="midi-asset-id"
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="midi-asset-listbox"
            aria-expanded={listOpen}
            value={assetQuery}
            onChange={(e) => {
              setAssetQuery(e.target.value);
              setAssetId(e.target.value.trim());
              setAssetOpen(true);
            }}
            onFocus={() => setAssetOpen(true)}
            onBlur={() => window.setTimeout(() => setAssetOpen(false), 150)}
            placeholder="Song"
            title="Type a song name (or drop a library item or an audio file here). Pick a result to use it — no need to paste a raw id."
            className="flex-1 min-w-0 h-full bg-transparent border-none outline-none text-[10px] font-mono et-ink"
          />
          {listOpen && (
            <div
              id="midi-asset-listbox"
              role="listbox"
              aria-label="Library songs"
              className={`absolute left-0 top-full mt-1 z-50 w-64 max-h-56 overflow-y-auto ${FLYOUT_CARD}`}
            >
              {assetMatches.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  role="option"
                  aria-selected={e.id === assetId}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => pickAsset(e.id, e.title)}
                  className={`w-full text-left px-2 py-1.5 text-[10px] border-b border-white/5 last:border-0 transition-shadow hover:shadow-[inset_0_0_0_100px_rgba(255,255,255,0.06)] ${
                    e.id === assetId ? 'text-[rgb(var(--et-accent))]' : 'text-zinc-200'
                  }`}
                >
                  <span className="block truncate">{e.title}</span>
                  <span className="block truncate text-[8px] font-mono et-ink-3">{e.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <StripKey
          onClick={() => void analyze()}
          disabled={busy}
          title="Detect notes, pitch and lyrics from the library vocal (basic-pitch) and load them into the roll"
          icon={busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />}
          legend="Analyze"
        />
        <button
          ref={songMenuKeyRef}
          type="button"
          onClick={() => setSongMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={songMenuOpen}
          aria-controls="midi-song-menu"
          aria-label="More song actions"
          title="Load or validate the song's artifact"
          className={`${STRIP_ICON_KEY} ${keyTone({ on: songMenuOpen })}`}
        >
          <ChevronDown aria-hidden="true" className="w-3 h-3" />
        </button>
        <DockFlyout
          open={songMenuOpen}
          anchorRef={songMenuKeyRef}
          onClose={() => setSongMenuOpen(false)}
          placement="below"
          align="end"
          id="midi-song-menu"
          role="menu"
          aria-label="Song actions"
          className={`w-32 p-1 flex flex-col gap-0.5 ${FLYOUT_CARD}`}
        >
          <StripKey
            role="menuitem"
            onClick={() => {
              setSongMenuOpen(false);
              if (assetId) void loadArtifact(assetId);
            }}
            disabled={busy || !assetId}
            title="Load an already-analyzed artifact's notes + lyrics into the roll without re-detecting"
            icon={<FolderOpen className="w-3 h-3" />}
            legend="Load"
            className="w-full justify-start"
          />
          <StripKey
            role="menuitem"
            onClick={() => {
              setSongMenuOpen(false);
              void validate();
            }}
            disabled={!assetId}
            title="Check the notes survive a notes -> MIDI -> notes round-trip and report any timing drift"
            icon={<FileCheck2 className="w-3 h-3" />}
            legend="Validate"
            className="w-full justify-start"
          />
        </DockFlyout>

        <div
          className="flex-1 min-w-0 px-1 text-right truncate text-[9px] font-mono et-ink-3"
          title={progress || (status === 'idle' ? undefined : status)}
        >
          {progress && <span>{progress}</span>}
          <span role="status" className={progress ? 'sr-only' : undefined}>
            {status === 'idle' ? '' : status}
          </span>
        </div>
        <PianoRollNoteCount />
        <PianoRollMapKey />
      </div>

      {/* ── body: ACTION rail · roll (or arpeggiator) · artifact rail · Voice ─ */}
      <div className="flex-1 min-h-0 flex">
        <div
          ref={railRef}
          role="group"
          aria-label="MIDI actions"
          className="relative w-10 shrink-0 flex flex-col border-r border-white/8 bg-black/40"
          style={railOrb.bottom ? { paddingBottom: railOrb.bottom } : undefined}
        >
          <div ref={railScrollRef} className="flex-1 min-h-0 overflow-y-auto no-scrollbar scroll-py-4">
            <div
              ref={railContentRef}
              data-compact={railCompact || undefined}
              className="group/rail flex flex-col gap-0.5 data-compact:gap-px p-0.5"
            >
              {/* REC: the always-on monitor records; the corner opens the input. */}
              <div
                ref={recWrapRef}
                className="relative shrink-0"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setInputMenuOpen(true);
                }}
              >
                <RailKey
                  onClick={toggleRecord}
                  disabled={busy || micPerm === 'denied'}
                  rec={recording}
                  aria-label={recording ? 'Stop recording' : 'Record vocal to notes'}
                  title={
                    recording
                      ? 'Stop recording'
                      : micPerm === 'denied'
                        ? 'Microphone blocked: allow it for this app, then choose the input from the corner menu'
                        : 'Record (mic -> notes via basic-pitch). Right-click or the corner for the input device.'
                  }
                  icon={recording ? <Square className="w-3 h-3" /> : <Mic className="w-3 h-3" />}
                  legend="Rec"
                />
                {monitorOpen && <RecLevel monitorRef={monitorRef} recording={recording} />}
                <button
                  ref={recInputKeyRef}
                  type="button"
                  onClick={() => setInputMenuOpen((v) => !v)}
                  aria-haspopup="dialog"
                  aria-expanded={inputMenuOpen}
                  aria-controls="midi-rec-input"
                  aria-label="Recording input device"
                  title="Microphone input"
                  className={CORNER_KEY}
                >
                  <ChevronRight aria-hidden="true" className="w-2.5 h-2.5" />
                </button>
              </div>
              <DockFlyout
                open={inputMenuOpen}
                anchorRef={recWrapRef}
                returnFocusRef={recInputKeyRef}
                onClose={() => setInputMenuOpen(false)}
                placement="right"
                id="midi-rec-input"
                role="dialog"
                aria-label="Microphone input"
                className={`w-64 p-2 flex flex-col items-start gap-1.5 ${FLYOUT_CARD}`}
              >
                {/* Vocal input — an override of the global microphone (Settings).
                    One printed word; the select's accessible name stays full. */}
                <IoSurfaceSelect
                  surface="midiVocal"
                  id="midi-input-device"
                  label="Microphone input"
                  legend="Input"
                  showLabel
                  labelClassName="text-[8px] font-mono uppercase tracking-widest et-ink-3"
                  className="w-full max-w-none text-[10px]"
                />
                {micPerm === 'denied' && (
                  <span className="text-[9px] font-mono text-red-300">mic blocked</span>
                )}
              </DockFlyout>

              <MidiImportPopover onImportFile={importMidiFileToRoll} onImportSheetFile={importSheetFileToRoll} />

              <RailKey
                ref={exportKeyRef}
                onClick={() => setExportMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={exportMenuOpen}
                aria-controls="midi-export-menu"
                aria-label="Export MIDI"
                title="Download the roll as a Standard MIDI (.mid) file"
                on={exportMenuOpen}
                icon={<Download className="w-3 h-3" />}
                legend="Export"
              />
              <DockFlyout
                open={exportMenuOpen}
                anchorRef={exportKeyRef}
                onClose={() => setExportMenuOpen(false)}
                placement="right"
                id="midi-export-menu"
                role="menu"
                aria-label="Export MIDI"
                className={`w-28 p-1 flex flex-col gap-0.5 ${FLYOUT_CARD}`}
              >
                <StripKey
                  role="menuitem"
                  onClick={() => {
                    setExportMenuOpen(false);
                    exportRollMidi();
                  }}
                  title="The roll at its own BPM, one track named Piano Roll (piano-roll.mid)"
                  icon={<Download className="w-3 h-3" />}
                  legend="Roll"
                  className="w-full justify-start"
                />
                <StripKey
                  role="menuitem"
                  onClick={() => {
                    setExportMenuOpen(false);
                    exportMidi();
                  }}
                  title="Through the vocal export writer: the same notes, seconds-exact (midi.mid); the status line reports it"
                  icon={<Download className="w-3 h-3" />}
                  legend="Vocal"
                  className="w-full justify-start"
                />
              </DockFlyout>

              <PianoRollEditKey />

              <AiComposePopover
                currentBpm={rollBpm}
                onGenerated={(result) => usePianoRollStore.getState().importNotes(result.notes, result.bpm)}
              />

              <RailKey
                onClick={() => void makeBeat()}
                aria-label="Beat from the notes"
                title="Render a General MIDI drum beat from the notes (low/mid/high -> kick/snare/hat) and play it"
                icon={<Drum className="w-3 h-3" />}
                legend="Beat"
              />
              <RailKey
                onClick={() => setArpOn((v) => !v)}
                aria-pressed={arpOn}
                aria-label="Arp: chord-progression arpeggiator"
                title={arpOn ? 'Back to the piano roll' : 'Chord-progression arpeggiator'}
                on={arpOn}
                icon={<Music4 className="w-3 h-3" />}
                legend="Arp"
              />
              <RailKey
                onClick={() => setVoiceOn(!voiceOn)}
                aria-pressed={voiceOn}
                aria-label="Voice: the Vocal2MIDI column"
                title={voiceOn ? 'Hide the Vocal2MIDI column' : 'Show the Vocal2MIDI column'}
                on={voiceOn}
                icon={<AudioLines className="w-3 h-3" />}
                legend="Voice"
              />
              <PianoRollClearKey />
            </div>
          </div>
          {/* Pointer cues for a rail taller than the dock; keyboard focus
              scrolls a key into view on its own, so they stay out of Tab. */}
          {railMore.up && (
            <button
              type="button"
              tabIndex={-1}
              onClick={() => scrollRail(-1)}
              aria-label="Scroll the actions up"
              title="More actions above"
              className={`${RAIL_CUE} top-0`}
              style={{ background: 'linear-gradient(to bottom, var(--et-panel, #0c0a12) 45%, transparent)' }}
            >
              <ChevronUp aria-hidden="true" className="w-3 h-3" />
            </button>
          )}
          {railMore.down && (
            <button
              type="button"
              tabIndex={-1}
              onClick={() => scrollRail(1)}
              aria-label="Scroll the actions down"
              title="More actions below"
              className={RAIL_CUE}
              style={{
                bottom: railOrb.bottom,
                background: 'linear-gradient(to top, var(--et-panel, #0c0a12) 45%, transparent)',
              }}
            >
              <ChevronDown aria-hidden="true" className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* The arpeggiator stays mounted but hidden so its transport keeps
            running when toggling back to the roll. */}
        <div className="flex-1 min-w-0 relative">
          <div className={arpOn ? 'hidden' : 'absolute inset-0'}>
            <PianoRoll stepPx={stepPx} onStepPxChange={setStepPx} />
          </div>
          <div className={arpOn ? 'absolute inset-0' : 'hidden'}>
            <ArpeggiatorPanel />
          </div>
        </div>

        {!arpOn && artifact && (
          <div className="w-64 shrink-0 border-l border-white/8 overflow-y-auto p-2 space-y-3">
            <section>
              <h3 className="text-[8px] font-mono uppercase tracking-widest et-ink-3 mb-1">
                Lyrics
              </h3>
              <p className="text-[10px] text-zinc-300 whitespace-pre-wrap wrap-break-word">
                {artifact.lyrics?.text || (
                  <span className="et-ink-3">none (analyze with transcription)</span>
                )}
              </p>
              <StripKey
                onClick={() => useBottomPanelStore.getState().showTab('sing')}
                aria-label="Sing: open the lyrics in the SING tab"
                title="Sing along, edit or time the lyrics in the SING tab"
                icon={<MicVocal className="w-3 h-3" />}
                legend="Sing"
                className="mt-1"
              />
            </section>

            <section>
              <h3 className="text-[8px] font-mono uppercase tracking-widest et-ink-3 mb-1">
                Segments
              </h3>
              {artifact.segments?.length ? (
                <ul className="space-y-1">
                  {artifact.segments.map((s, i) => (
                    <li key={s.id} className="flex items-center gap-1.5">
                      <span className="flex-1 min-w-0 truncate text-[10px] font-mono text-zinc-400">
                        {(s.start_ms / 1000).toFixed(2)}-{(s.end_ms / 1000).toFixed(2)}s {s.kind}
                      </span>
                      <StripKey
                        onClick={() => void inpaintSegment(i)}
                        aria-label={`Inpaint segment ${i + 1}`}
                        title="Arm an inpaint guide for this segment"
                        icon={<Brush className="w-3 h-3" />}
                        legend="Inpaint"
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[10px] et-ink-3">none</p>
              )}
            </section>

            {validateMsg && (
              <p className="text-[9px] font-mono text-zinc-400 wrap-break-word">{validateMsg}</p>
            )}
          </div>
        )}

        {/* Vocal2MIDI suite — the full vocal-to-MIDI tool as a collapsible right
            column, shown while VOICE is on. Its recorder/AI/editor write notes
            into the piano roll. */}
        {!arpOn && voiceOn && <Vocal2MidiPanel />}
      </div>

      {/* ── SHAPE row ────────────────────────────────────────────────────── */}
      <VirtuosoControls songEntryId={assetId || undefined} />
    </div>
  );
};
