import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Info, Minus, Plus, Save, Send, Trash2, Unlink } from 'lucide-react';
import { usePianoRollStore, pianoNotesToMidiNotes, type PianoNote } from '../../state/pianoRollStore';
import { usePlaybackStore } from '../../state/playbackStore';
import { getEngineCtx } from '../../state/playerStore';
import { useEditorStore, computePeaks } from '../../state/editorStore';
import { downloadMidi, parseMidi } from '../../utils/midi';
import { logError, logInfo } from '../../state/logStore';
import { MidiMapper } from './MidiMapper';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { renderStepNotesToBlob } from '../../lib/midiSynth';
import { triggerPianoNote } from '../../lib/pianoTrigger';
import { parseSheetFile } from '../../lib/sheetImportClient';
import { ownsKey } from '../../lib/keyScope';
import {
  CORNER_KEY,
  DockFlyout,
  FIELD,
  FIELD_LEGEND,
  FIELD_VALUE,
  FLYOUT_CARD,
  KEY_ON,
  KEY_PLAY_REST,
  RANGE,
  RailKey,
  STRIP_ICON_KEY,
  StripKey,
  KEY_REST,
} from './midiDockKit';

const NOTE_HEIGHT = 12;
const HEADER_HEIGHT = 22;
const KEYBOARD_WIDTH = 64;
const STEP_PX_MIN = 6;
const STEP_PX_MAX_BUTTON = 48;
const STEP_PX_MAX_WHEEL = 64;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlackKey = (midi: number) => [1, 3, 6, 8, 10].includes(midi % 12);
const noteLabel = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

const ROLL_HELP =
  'Click empty cell = add · Click note = select / second click = delete · Drag right edge = resize · Delete key removes selection · Right-click note for actions · Ctrl+wheel = zoom · Shift+wheel = scroll';

// triggerPianoNote / triggerPianoNoteFromMidi live in lib/pianoTrigger so the
// global Web MIDI listener + Sway surface can play a note without importing this
// whole component graph. The piano roll uses `triggerPianoNote` for its own
// scheduling (imported above).
const PIANO_MIDI_PARAMS = [
  { key: 'bpm' as const,        label: 'BPM',         min: 40,  max: 240, autoCc: 14, integer: true },
  { key: 'totalSteps' as const, label: 'Total Steps', min: 16,  max: 256, autoCc: 15, integer: true },
];

/** Render the current pattern offline to a WAV Blob. Used by SEND TO EDITOR.
 *  Delegates to the shared step renderer in `lib/midiSynth`. */
const renderPianoRollToBlob = (
  notes: PianoNote[],
  bpm: number,
  totalSteps: number,
): Promise<{ blob: Blob; duration: number }> =>
  renderStepNotesToBlob(notes, bpm, totalSteps);

const useMasterGainRef = () => {
  const masterGain = usePlaybackStore((s) => (s.muted ? 0 : s.volume / 100));
  const masterRef = useRef(masterGain);
  useEffect(() => { masterRef.current = masterGain; }, [masterGain]);
  return masterRef;
};

/* ── the roll's controls, laid out by the MIDI dock (MidiPanel) ─────────────
   Each piece subscribes to only what it shows, so a playhead tick or a note
   edit re-renders the key that reads it rather than the whole tab. */

/** The footer's hard-cornered transport glyphs, fill-only in currentColor. */
const Glyph: React.FC<{ d: string }> = ({ d }) => (
  <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" focusable="false" className="w-3 h-3">
    <path d={d} />
  </svg>
);
const GLYPH_PLAY = 'M3 1.5 12.5 7 3 12.5Z';
const GLYPH_STOP = 'M2.5 2.5h9v9h-9z';

/**
 * PLAY / STOP, BPM and STEPS. Hosts the roll's playback scheduler: this key is
 * mounted whenever the MIDI tab is, exactly as the roll is. `startDisabled`
 * stops PLAY starting a hidden roll; STOP always works.
 */
export const PianoRollTransport: React.FC<{ startDisabled?: boolean }> = ({ startDisabled = false }) => {
  const bpm = usePianoRollStore((s) => s.bpm);
  const totalSteps = usePianoRollStore((s) => s.totalSteps);
  const isPlaying = usePianoRollStore((s) => s.isPlaying);
  const setBpm = usePianoRollStore((s) => s.setBpm);
  const setTotalSteps = usePianoRollStore((s) => s.setTotalSteps);
  const setPlaying = usePianoRollStore((s) => s.setPlaying);
  const setCurrentStep = usePianoRollStore((s) => s.setCurrentStep);
  const masterRef = useMasterGainRef();
  const playTimerRef = useRef<number | null>(null);

  const stopPlayback = useCallback(() => {
    if (playTimerRef.current != null) {
      window.clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }
    setPlaying(false);
  }, [setPlaying]);

  // Time-based lookahead scheduler: notes fire at their exact time
  // (step * stepSec), so FRACTIONAL step positions (32nd/64th notes and
  // micro-timing offsets) play — not just integer 16ths. Loops seamlessly by
  // scheduling each note's next occurrence every `total` steps. It resumes from
  // the store's current step, which every tick writes.
  useEffect(() => {
    if (!isPlaying) return;
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    const stepSec = 60 / Math.max(40, bpm) / 4;
    const lookahead = 0.12; // seconds scheduled ahead each tick
    const startTime = ctx.currentTime + 0.06;
    const startStep = usePianoRollStore.getState().currentStep;
    const total = Math.max(1, totalSteps);
    let cursor = startStep - 1e-4; // absolute step scheduled up to (exclusive)

    const tick = () => {
      const now = ctx.currentTime;
      const targetAbs = startStep + (now + lookahead - startTime) / stepSec;
      for (const n of usePianoRollStore.getState().notes) {
        let occ = n.step + Math.ceil((cursor - n.step) / total) * total;
        if (occ <= cursor) occ += total;
        while (occ <= targetAbs) {
          const when = startTime + (occ - startStep) * stepSec;
          triggerPianoNote(n.note, n.velocity, Math.max(now, when), n.length * stepSec, masterRef.current);
          occ += total;
        }
      }
      cursor = targetAbs;
      const elapsedAbs = startStep + (now - startTime) / stepSec;
      const pos = ((elapsedAbs % total) + total) % total;
      setCurrentStep(pos);
    };
    playTimerRef.current = window.setInterval(tick, 25);
    return () => {
      if (playTimerRef.current != null) {
        window.clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [isPlaying, bpm, totalSteps, setCurrentStep, masterRef]);

  const handlePlayToggle = () => {
    if (isPlaying) {
      stopPlayback();
      return;
    }
    // Start from the top; the lookahead scheduler (effect above) fires notes,
    // including step 0, at their exact times.
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    setCurrentStep(0);
    setPlaying(true);
    logInfo('piano-roll', `Playing ${usePianoRollStore.getState().notes.length} notes at ${bpm} BPM`);
  };

  return (
    <>
      <button
        type="button"
        onClick={handlePlayToggle}
        disabled={startDisabled && !isPlaying}
        aria-label={isPlaying ? 'Stop' : 'Play'}
        title={isPlaying ? 'Stop' : startDisabled ? 'Play: the arpeggiator is showing, and runs from its own Play' : 'Play'}
        className={`${STRIP_ICON_KEY} w-7 ${isPlaying ? KEY_ON : KEY_PLAY_REST}`}
      >
        <Glyph d={isPlaying ? GLYPH_STOP : GLYPH_PLAY} />
      </button>
      <div className={FIELD}>
        <label htmlFor="piano-roll-bpm" className={FIELD_LEGEND}>BPM</label>
        <input
          id="piano-roll-bpm"
          type="number"
          name="piano-roll-bpm"
          min={40}
          max={240}
          value={bpm}
          onChange={(e) => setBpm(parseInt(e.target.value) || 120)}
          className={`${FIELD_VALUE} w-9 bg-transparent border-none outline-none`}
        />
      </div>
      <div className={FIELD}>
        <label htmlFor="piano-roll-total-steps" className={FIELD_LEGEND}>Steps</label>
        <input
          id="piano-roll-total-steps"
          type="number"
          name="piano-roll-total-steps"
          min={16}
          max={4096}
          step={16}
          value={totalSteps}
          onChange={(e) => setTotalSteps(parseInt(e.target.value) || 32)}
          className={`${FIELD_VALUE} w-11 bg-transparent border-none outline-none`}
        />
      </div>
    </>
  );
};

/** Zoom out · step width · zoom in. The width is shared with the grid. */
export const PianoRollZoom: React.FC<{ stepPx: number; onStepPxChange: (px: number) => void }> = ({
  stepPx,
  onStepPxChange,
}) => (
  <>
    <button
      type="button"
      onClick={() => onStepPxChange(Math.max(STEP_PX_MIN, stepPx - 2))}
      aria-label="Zoom out"
      title="Zoom out"
      className={`${STRIP_ICON_KEY} ${KEY_REST}`}
    >
      <Minus aria-hidden="true" className="w-3 h-3" />
    </button>
    <span className="w-5 text-center text-[9px] font-mono et-ink-2 tabular-nums" title="Step width (px)">
      {Math.round(stepPx)}
    </span>
    <button
      type="button"
      onClick={() => onStepPxChange(Math.min(STEP_PX_MAX_BUTTON, stepPx + 2))}
      aria-label="Zoom in"
      title="Zoom in"
      className={`${STRIP_ICON_KEY} ${KEY_REST}`}
    >
      <Plus aria-hidden="true" className="w-3 h-3" />
    </button>
  </>
);

/** Q and SWING sliders with APPLY: the timing feel, applied on demand. */
export const PianoRollFeel: React.FC = () => {
  const noteCount = usePianoRollStore((s) => s.notes.length);
  const [quantizePct, setQuantizePct] = useState(100);
  const [swingPct, setSwingPct] = useState(0);

  const applyTimingFeel = () => {
    const { notes, replaceAll } = usePianoRollStore.getState();
    if (notes.length === 0) return;
    const q = Math.max(0, Math.min(1, quantizePct / 100));
    const swing = Math.max(-0.49, Math.min(0.49, swingPct / 100));
    const adjusted = notes.map((note) => {
      const quantizedStep = Math.round(note.step);
      const quantizedLength = Math.max(1, Math.round(note.length));
      let step = note.step + (quantizedStep - note.step) * q;
      const length = Math.max(1, note.length + (quantizedLength - note.length) * q);
      const gridStep = Math.round(step);
      // Delay or pull back the off-16ths in each beat. Positive = swing/rag lag;
      // negative = push/syncopate ahead. Keep step >= 0 so the phrase stays valid.
      if (gridStep % 2 === 1) step = Math.max(0, step + swing);
      return { ...note, step, length };
    });
    replaceAll(adjusted);
    logInfo('piano-roll', `Applied timing feel: quantize ${quantizePct}% · swing/rag ${swingPct}%`);
  };

  return (
    <>
      <div className={FIELD} title="Quantize: pulls notes toward the grid (100 = dead on)">
        <label htmlFor="piano-roll-quantize" className={FIELD_LEGEND}>Q</label>
        <input
          id="piano-roll-quantize"
          type="range"
          name="piano-roll-quantize"
          min={0}
          max={100}
          value={quantizePct}
          onChange={(e) => setQuantizePct(parseInt(e.target.value) || 0)}
          className={RANGE}
        />
        <span className={`${FIELD_VALUE} w-5`}>{quantizePct}</span>
      </div>
      <div className={FIELD} title="Swing (rag): delays (+) or pushes (−) the off-16ths, in percent of a step">
        <label htmlFor="piano-roll-swing-rag" className={FIELD_LEGEND}>Swing</label>
        <input
          id="piano-roll-swing-rag"
          type="range"
          name="piano-roll-swing-rag"
          min={-50}
          max={50}
          value={swingPct}
          onChange={(e) => setSwingPct(parseInt(e.target.value) || 0)}
          className={RANGE}
        />
        <span className={`${FIELD_VALUE} w-6`}>{swingPct > 0 ? '+' : ''}{swingPct}</span>
      </div>
      <StripKey
        onClick={applyTimingFeel}
        disabled={noteCount === 0}
        aria-label="Apply timing feel"
        title="Apply the quantize and swing amounts to every note"
        icon={<Check className="w-3 h-3" />}
        legend="Apply"
      />
    </>
  );
};

/** "8 notes", and the playhead's step while the roll plays. */
export const PianoRollNoteCount: React.FC = () => {
  const count = usePianoRollStore((s) => s.notes.length);
  const isPlaying = usePianoRollStore((s) => s.isPlaying);
  const currentStep = usePianoRollStore((s) => (s.isPlaying ? Math.floor(s.currentStep) : 0));
  const totalSteps = usePianoRollStore((s) => s.totalSteps);
  return (
    <span className="shrink-0 text-[9px] font-mono et-ink-2 whitespace-nowrap tabular-nums">
      {isPlaying && (
        <span className="et-ink-3 mr-1.5" title="Playhead step">
          {currentStep + 1}/{totalSteps}
        </span>
      )}
      {count} note{count === 1 ? '' : 's'}
    </span>
  );
};

/** MAP: the roll's MIDI mapper. A mapped CC moves BPM / total steps. */
export const PianoRollMapKey: React.FC = () => (
  <MidiMapper
    title="PIANO"
    accent="theme"
    variant="key"
    storageKey="sa3-midi-map:piano-v1"
    params={PIANO_MIDI_PARAMS}
    onChange={(key, value) => {
      const { setBpm, setTotalSteps } = usePianoRollStore.getState();
      if (key === 'bpm') setBpm(Math.round(value));
      else if (key === 'totalSteps') {
        const stepped = Math.max(16, Math.round(value / 16) * 16);
        setTotalSteps(stepped);
      }
    }}
  />
);

/**
 * EDIT: render the notes to audio and add them to the waveform editor. Once a
 * clip is linked the key reads SAVE (latched) and re-renders that clip in
 * place; the corner target unlinks it.
 */
export const PianoRollEditKey: React.FC = () => {
  const noteCount = usePianoRollStore((s) => s.notes.length);
  const editingClipId = usePianoRollStore((s) => s.editingClipId);
  const setEditingClip = usePianoRollStore((s) => s.setEditingClip);
  const [isBouncing, setIsBouncing] = useState(false);
  const [clipMenuOpen, setClipMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<HTMLButtonElement>(null);

  const handleSendToEditor = async () => {
    const { notes, bpm, totalSteps } = usePianoRollStore.getState();
    if (notes.length === 0) {
      logError('piano-roll', 'No notes to bounce');
      return;
    }
    setIsBouncing(true);
    const start = performance.now();
    try {
      const { blob, duration } = await renderPianoRollToBlob(notes, bpm, totalSteps);
      const { peaks } = await computePeaks(blob, 240);
      const editor = useEditorStore.getState();
      // Snapshot the notes so re-editing later sees the exact same state.
      const noteSnapshot: PianoNote[] = notes.map((n) => ({ ...n }));

      if (editingClipId) {
        const existing = editor.clips.find((c) => c.id === editingClipId);
        if (existing) {
          editor.updateClip(editingClipId, {
            audioBlob: blob,
            mimeType: 'audio/wav',
            sourceDuration: duration,
            durationSec: duration,
            offsetIntoSource: 0,
            peaks,
            sourcePianoRoll: noteSnapshot,
            sourceBpm: bpm,
            sourceTotalSteps: totalSteps,
            sourceKind: 'piano-roll',
            label: existing.label.startsWith('roll_')
              ? `roll_${bpm}bpm_${notes.length}n`
              : existing.label,
          });
          logInfo('piano-roll', `Updated editor clip ${editingClipId.slice(0, 8)} (${duration.toFixed(2)}s, ${notes.length} notes)`);
          const ms = (performance.now() - start).toFixed(0);
          logInfo('piano-roll', `Re-bounce took ${ms}ms`);
          return;
        }
        // The clip the roll was bound to is gone — fall through to create a new one.
        setEditingClip(null);
      }

      const trackId = editor.addTrack({ name: `Piano ${bpm} BPM` });
      const trackColor = useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#a855f7';
      const newClipId = editor.addClipToTrack({
        trackId,
        label: `roll_${bpm}bpm_${notes.length}n`,
        audioBlob: blob,
        mimeType: 'audio/wav',
        sourceDuration: duration,
        offsetIntoSource: 0,
        durationSec: duration,
        startSec: 0,
        color: trackColor,
        sourceKind: 'piano-roll',
        sourcePianoRoll: noteSnapshot,
        sourceBpm: bpm,
        sourceTotalSteps: totalSteps,
      });
      editor.cachePeaks(newClipId, peaks);
      // Bind the roll to the new clip so subsequent Send-to-Editor edits in place.
      setEditingClip(newClipId);
      const ms = (performance.now() - start).toFixed(0);
      logInfo('piano-roll', `Bounced ${notes.length} notes → editor (${duration.toFixed(2)}s in ${ms}ms)`);
    } catch (e) {
      logError('piano-roll', `Bounce failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setIsBouncing(false);
    }
  };

  const linked = !!editingClipId;
  const name = isBouncing
    ? 'Edit: bouncing to the editor'
    : linked
      ? `Save to the linked editor clip ${editingClipId.slice(0, 8)}`
      : 'Edit: send to the editor';
  return (
    <div
      ref={wrapRef}
      className="relative"
      onContextMenu={(e) => {
        if (!linked) return;
        e.preventDefault();
        setClipMenuOpen(true);
      }}
    >
      <RailKey
        ref={keyRef}
        onClick={() => void handleSendToEditor()}
        disabled={isBouncing || noteCount === 0}
        aria-label={name}
        title={linked
          ? `Linked to clip ${editingClipId.slice(0, 8)}: re-render and update it in place. Right-click or the corner to unlink.`
          : 'Render these notes to audio and add to the waveform editor as a new track'}
        on={linked}
        icon={linked
          ? <Save className={`w-3 h-3 ${isBouncing ? 'animate-pulse' : ''}`} />
          : <Send className={`w-3 h-3 ${isBouncing ? 'animate-pulse' : ''}`} />}
        legend={linked ? 'Save' : 'Edit'}
      />
      {linked && (
        <button
          type="button"
          onClick={() => setEditingClip(null)}
          aria-label="Unlink from the editor clip"
          title="Detach: future renders will create a new editor clip instead of updating the linked one"
          className={CORNER_KEY}
        >
          <Unlink aria-hidden="true" className="w-2.5 h-2.5" />
        </button>
      )}
      {/* Right-click on SAVE: the same two actions as full-size menu items, so
          UNLINK does not depend on the 12px corner target. */}
      <DockFlyout
        open={clipMenuOpen && linked}
        anchorRef={wrapRef}
        returnFocusRef={keyRef}
        onClose={() => setClipMenuOpen(false)}
        placement="right"
        id="piano-roll-clip-menu"
        role="menu"
        aria-label="Linked editor clip"
        className={`w-28 p-1 flex flex-col gap-0.5 ${FLYOUT_CARD}`}
      >
        <StripKey
          role="menuitem"
          onClick={() => {
            setClipMenuOpen(false);
            void handleSendToEditor();
          }}
          disabled={isBouncing || noteCount === 0}
          title="Re-render the notes and update the linked editor clip in place"
          icon={<Save className="w-3 h-3" />}
          legend="Save"
          className="w-full justify-start"
        />
        <StripKey
          role="menuitem"
          onClick={() => {
            setClipMenuOpen(false);
            setEditingClip(null);
          }}
          title="Detach: future renders will create a new editor clip instead of updating the linked one"
          icon={<Unlink className="w-3 h-3" />}
          legend="Unlink"
          className="w-full justify-start"
        />
      </DockFlyout>
    </div>
  );
};

/** CLEAR: remove every note. */
export const PianoRollClearKey: React.FC = () => (
  <RailKey
    onClick={() => usePianoRollStore.getState().clear()}
    aria-label="Clear every note"
    title="Remove every note"
    icon={<Trash2 className="w-3 h-3" />}
    legend="Clear"
  />
);

/** Download the roll as a Standard MIDI File at its own BPM. */
export const exportRollMidi = (): void => {
  const { notes, bpm } = usePianoRollStore.getState();
  if (notes.length === 0) {
    logError('piano-roll', 'No notes to export');
    return;
  }
  const ppq = 480;
  const midiNotes = pianoNotesToMidiNotes(notes, ppq);
  downloadMidi(
    {
      ppq,
      bpm,
      tracks: [
        { name: 'Piano Roll', notes: midiNotes },
      ],
    },
    'piano-roll',
  );
  logInfo('piano-roll', `Exported ${notes.length} notes as MIDI`);
};

export const importMidiFileToRoll = (file: File): void => {
  file.arrayBuffer().then((buf) => {
    try {
      const data = parseMidi(new Uint8Array(buf));
      // Flatten all tracks' notes into a single piano-roll layer.
      const stepTicks = data.ppq / 4;
      const flat: PianoNote[] = [];
      for (const track of data.tracks) {
        for (const n of track.notes) {
          flat.push({
            id: `imp-${Math.random().toString(36).slice(2)}-${flat.length}`,
            note: n.note,
            step: Math.round(n.tick / stepTicks),
            length: Math.max(1, Math.round(n.durationTicks / stepTicks)),
            velocity: n.velocity,
          });
        }
      }
      if (flat.length === 0) {
        logError('piano-roll', `No notes found in "${file.name}"`);
        return;
      }
      flat.sort((a, b) => a.step - b.step);
      // importNotes auto-fits the grid length AND pitch range to the import.
      usePianoRollStore.getState().importNotes(flat, data.bpm);
      logInfo('piano-roll', `Imported ${flat.length} notes from "${file.name}" at ${Math.round(data.bpm)} BPM`);
    } catch (e) {
      logError('piano-roll', `MIDI import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }).catch((e) => logError('piano-roll', `Could not read file: ${e instanceof Error ? e.message : String(e)}`));
};

export const importSheetFileToRoll = (file: File): void => {
  void (async () => {
    try {
      const score = await parseSheetFile(file);
      // Flatten all parts into a single piano-roll layer (step/length already
      // on the 16th grid from the backend).
      const flat: PianoNote[] = [];
      for (const track of score.tracks) {
        for (const n of track.notes) {
          flat.push({
            id: `sheet-${Math.random().toString(36).slice(2)}-${flat.length}`,
            note: n.pitch,
            step: n.step,
            length: Math.max(1, n.length),
            velocity: n.velocity,
          });
        }
      }
      if (flat.length === 0) {
        logError('piano-roll', `No notes found in "${file.name}"`);
        return;
      }
      flat.sort((a, b) => a.step - b.step);
      usePianoRollStore.getState().importNotes(flat, score.bpm);
      logInfo(
        'piano-roll',
        `Imported ${flat.length} notes from score "${file.name}" (${score.format}) at ${Math.round(score.bpm)} BPM`,
      );
    } catch (e) {
      logError('piano-roll', `Sheet import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
};

/* ── the grid: keyboard column, ruler, notes ──────────────────────────────── */

export const PianoRoll: React.FC<{ stepPx: number; onStepPxChange: (px: number) => void }> = ({
  stepPx,
  onStepPxChange,
}) => {
  const notes = usePianoRollStore((s) => s.notes);
  const totalSteps = usePianoRollStore((s) => s.totalSteps);
  const lowestNote = usePianoRollStore((s) => s.lowestNote);
  const highestNote = usePianoRollStore((s) => s.highestNote);
  const selectedNoteId = usePianoRollStore((s) => s.selectedNoteId);
  const isPlaying = usePianoRollStore((s) => s.isPlaying);
  const currentStep = usePianoRollStore((s) => s.currentStep);
  const recordedRange = usePianoRollStore((s) => s.recordedRange);

  const addNote = usePianoRollStore((s) => s.addNote);
  const removeNote = usePianoRollStore((s) => s.removeNote);
  const updateNote = usePianoRollStore((s) => s.updateNote);
  const setSelectedNote = usePianoRollStore((s) => s.setSelectedNote);
  const clear = usePianoRollStore((s) => s.clear);
  const noteMenu = useContextMenu<PianoNote>();
  const masterRef = useMasterGainRef();

  const noteCount = highestNote - lowestNote + 1;
  const gridHeight = noteCount * NOTE_HEIGHT;
  const gridWidth = totalSteps * stepPx;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  const keyboardRowsRef = useRef<HTMLDivElement | null>(null);

  // Map y-pixel inside the grid to a MIDI note. Top row = highestNote.
  const yToNote = useCallback(
    (y: number): number => highestNote - Math.floor(y / NOTE_HEIGHT),
    [highestNote],
  );
  const xToStep = useCallback((x: number): number => Math.floor(x / stepPx), [stepPx]);

  const handleGridClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0) return;
    const targetNote = yToNote(y);
    const targetStep = xToStep(x);
    if (targetStep < 0 || targetStep >= totalSteps) return;
    // If clicked on an existing note → remove or select.
    const hit = notes.find(
      (n) => n.note === targetNote && targetStep >= n.step && targetStep < n.step + n.length,
    );
    if (hit) {
      if (selectedNoteId === hit.id) {
        removeNote(hit.id);
      } else {
        setSelectedNote(hit.id);
      }
      return;
    }
    // Otherwise add a 1-step note.
    addNote({ note: targetNote, step: targetStep, length: 2, velocity: 96 });
    triggerPianoNote(targetNote, 96, getEngineCtx().currentTime + 0.02, 0.2, masterRef.current);
  };

  // Right-drag a note to extend its length.
  const resizeRef = useRef<{ id: string; startX: number; initialLength: number } | null>(null);
  const onNotePointerDown = (e: React.PointerEvent, note: PianoNote, edge: 'right' | 'body') => {
    e.stopPropagation();
    setSelectedNote(note.id);
    if (edge === 'right') {
      resizeRef.current = { id: note.id, startX: e.clientX, initialLength: note.length };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const op = resizeRef.current;
    if (!op) return;
    const dx = e.clientX - op.startX;
    const deltaSteps = Math.round(dx / stepPx);
    const newLen = Math.max(1, op.initialLength + deltaSteps);
    updateNote(op.id, { length: newLen });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (resizeRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      resizeRef.current = null;
    }
  };

  // Delete / Backspace removes selected note.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // Only delete a note when the piano roll is the surface the user is on;
      // otherwise Delete in the EDIT timeline removed a clip AND a note. The
      // scope is the whole MIDI tab (MidiPanel), so a hidden roll (the ARP face
      // is showing) must not act on it.
      if (!ownsKey('piano-roll')) return;
      if (rootRef.current?.offsetParent === null) return;
      if (selectedNoteId) {
        e.preventDefault();
        removeNote(selectedNoteId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedNoteId, removeNote]);

  const handleGridScroll = () => {
    if (keyboardRowsRef.current && gridScrollRef.current) {
      keyboardRowsRef.current.scrollTop = gridScrollRef.current.scrollTop;
    }
  };

  const handleGridWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = gridScrollRef.current;
    if (!el) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left + el.scrollLeft;
      const oldStepPx = stepPx;
      const nextStepPx = Math.max(STEP_PX_MIN, Math.min(STEP_PX_MAX_WHEEL, oldStepPx * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      onStepPxChange(nextStepPx);
      requestAnimationFrame(() => {
        el.scrollLeft = cursorX * (nextStepPx / oldStepPx) - (e.clientX - rect.left);
      });
      return;
    }
    if (e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
  };

  // Center the vertical scroll on the note content so it's visible in the tall
  // full-piano grid (~88 rows). Re-centers when the content pitch range changes
  // (a capture / import / clip load), not on edits within the current range.
  const contentLo = notes.length ? notes.reduce((m, n) => Math.min(m, n.note), 127) : 60;
  const contentHi = notes.length ? notes.reduce((m, n) => Math.max(m, n.note), 0) : 72;
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const midNote = (contentLo + contentHi) / 2;
    const midY = (highestNote - midNote) * NOTE_HEIGHT;
    el.scrollTop = Math.max(0, midY - el.clientHeight / 2);
    if (keyboardRowsRef.current) keyboardRowsRef.current.scrollTop = el.scrollTop;
  }, [contentLo, contentHi, highestNote]);

  // Build keyboard rows + grid rows for rendering.
  const rows: number[] = [];
  for (let n = highestNote; n >= lowestNote; n -= 1) rows.push(n);

  return (
    <div ref={rootRef} className="h-full flex flex-col bg-[#07050a] overflow-hidden relative">
      {/* Body */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Keyboard column */}
        <div className="shrink-0 overflow-hidden bg-[#0c0a12] border-r border-white/5" style={{ width: KEYBOARD_WIDTH }}>
          <div
            className="bg-black/40 border-b border-white/5 flex items-center justify-center"
            style={{ height: HEADER_HEIGHT }}
            title={ROLL_HELP}
          >
            <Info aria-hidden="true" className="w-3 h-3 et-ink-3" />
            <span className="sr-only">{ROLL_HELP}</span>
          </div>
          <div ref={keyboardRowsRef} className="overflow-hidden" style={{ height: `calc(100% - ${HEADER_HEIGHT}px)` }}>
            <div style={{ height: gridHeight }}>
              {rows.map((midi) => {
                const black = isBlackKey(midi);
                const isC = midi % 12 === 0;
                return (
                  <div
                    key={midi}
                    onClick={() => triggerPianoNote(midi, 100, getEngineCtx().currentTime + 0.02, 0.25, masterRef.current)}
                    className={`flex items-center justify-end pr-1 text-[8px] font-mono cursor-pointer transition-shadow border-b border-black/40 hover:shadow-[inset_0_0_0_100px_rgb(var(--et-accent)/0.3)] ${black ? 'bg-zinc-900 text-zinc-600' : isC ? 'bg-zinc-200 text-zinc-700' : 'bg-zinc-300 text-zinc-700'}`}
                    style={{ height: NOTE_HEIGHT }}
                    title={`Preview ${noteLabel(midi)}`}
                  >
                    {isC ? noteLabel(midi) : ''}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Grid column */}
        <div
          ref={gridScrollRef}
          className="flex-1 overflow-auto"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onScroll={handleGridScroll}
          onWheel={handleGridWheel}
        >
          {/* Ruler */}
          <div className="sticky top-0 z-20 bg-black/60 border-b border-white/5 flex" style={{ height: HEADER_HEIGHT, width: gridWidth, minWidth: '100%' }}>
            {Array.from({ length: Math.ceil(totalSteps / 4) }).map((_, beat) => (
              <div key={beat} className="border-r border-white/5 flex items-center px-1 text-[8px] font-mono text-zinc-500" style={{ width: stepPx * 4 }}>
                {beat + 1}
              </div>
            ))}
          </div>

          <div
            ref={gridRef}
            onClick={handleGridClick}
            className="relative cursor-crosshair"
            style={{ width: gridWidth, height: gridHeight }}
          >
            {/* Row backgrounds (alternating black/white key tint + 1-beat lines) */}
            {rows.map((midi, idx) => (
              <div
                key={midi}
                className={`absolute left-0 right-0 border-b ${isBlackKey(midi) ? 'bg-white/2' : 'bg-white/4'} ${midi % 12 === 0 ? 'border-white/10' : 'border-black/30'}`}
                style={{ top: idx * NOTE_HEIGHT, height: NOTE_HEIGHT }}
              />
            ))}
            {/* Vertical beat/step lines */}
            {Array.from({ length: totalSteps + 1 }).map((_, i) => (
              <div
                key={i}
                className={`absolute top-0 bottom-0 ${i % 4 === 0 ? 'border-l border-white/10' : 'border-l border-white/3'}`}
                style={{ left: i * stepPx }}
              />
            ))}
            {/* Recorded-region highlight: marks the last live take without
                shrinking the grid (the rest of the 256 stays empty). */}
            {recordedRange && recordedRange.endStep > recordedRange.startStep && (
              <div
                className="absolute top-0 bottom-0 bg-[rgb(var(--et-accent)/0.08)] border-x border-[rgb(var(--et-accent)/0.4)] pointer-events-none"
                style={{
                  left: recordedRange.startStep * stepPx,
                  width: (recordedRange.endStep - recordedRange.startStep) * stepPx,
                }}
              />
            )}
            {/* Playhead: a 1px line in the theme's primary ink, which holds
                contrast on the grid and across the accent-filled notes. No glow. */}
            {isPlaying && (
              <div
                className="absolute top-0 bottom-0 w-px bg-[rgb(var(--et-ink))] z-30 pointer-events-none"
                style={{ left: currentStep * stepPx + stepPx / 2 }}
              />
            )}
            {/* Notes */}
            {notes.map((n) => {
              if (n.note < lowestNote || n.note > highestNote) return null;
              const row = highestNote - n.note;
              const left = n.step * stepPx;
              const width = Math.max(4, n.length * stepPx - 1);
              const top = row * NOTE_HEIGHT;
              const selected = n.id === selectedNoteId;
              return (
                <div
                  key={n.id}
                  data-piano-note="1"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (selectedNoteId === n.id) removeNote(n.id);
                    else setSelectedNote(n.id);
                  }}
                  onPointerDown={(e) => onNotePointerDown(e, n, 'body')}
                  onContextMenu={(e) => { e.stopPropagation(); setSelectedNote(n.id); noteMenu.open(e, n); }}
                  className={`absolute rounded-sm border z-10 bg-[rgb(var(--et-accent))] transition-[filter] ${selected ? 'border-white brightness-125' : 'border-black/40 hover:brightness-110'}`}
                  style={{ left, width, top: top + 1, height: NOTE_HEIGHT - 2 }}
                  title={`${noteLabel(n.note)} · step ${n.step + 1} · ${n.length} step${n.length === 1 ? '' : 's'}`}
                >
                  <div
                    onPointerDown={(e) => onNotePointerDown(e, n, 'right')}
                    className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/50"
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Right-click menu for a single note. */}
      {(() => {
        const n = noteMenu.payload;
        if (!n) return null;
        const clampVel = (v: number) => Math.max(1, Math.min(127, v));
        const items: ContextMenuItem[] = [
          {
            type: 'item',
            label: 'Duplicate (after)',
            hint: 'step+len',
            onSelect: () => {
              addNote({ note: n.note, step: n.step + n.length, length: n.length, velocity: n.velocity });
            },
          },
          {
            type: 'item',
            label: 'Velocity +10',
            hint: `${n.velocity}`,
            disabled: n.velocity >= 127,
            onSelect: () => updateNote(n.id, { velocity: clampVel(n.velocity + 10) }),
          },
          {
            type: 'item',
            label: 'Velocity −10',
            hint: `${n.velocity}`,
            disabled: n.velocity <= 1,
            onSelect: () => updateNote(n.id, { velocity: clampVel(n.velocity - 10) }),
          },
          {
            type: 'item',
            label: 'Lengthen (+1 step)',
            onSelect: () => updateNote(n.id, { length: n.length + 1 }),
          },
          {
            type: 'item',
            label: 'Shorten (−1 step)',
            disabled: n.length <= 1,
            onSelect: () => updateNote(n.id, { length: Math.max(1, n.length - 1) }),
          },
          {
            type: 'item',
            label: 'Nudge left',
            disabled: n.step <= 0,
            onSelect: () => updateNote(n.id, { step: Math.max(0, n.step - 1) }),
          },
          {
            type: 'item',
            label: 'Nudge right',
            onSelect: () => updateNote(n.id, { step: n.step + 1 }),
          },
          { type: 'separator' },
          {
            type: 'item',
            label: 'Clear all notes',
            icon: <Trash2 className="w-3 h-3" />,
            hint: `${notes.length}`,
            onSelect: clear,
          },
          {
            type: 'item',
            label: 'Delete note',
            hint: 'Del',
            danger: true,
            onSelect: () => removeNote(n.id),
          },
        ];
        return (
          <ContextMenu
            position={noteMenu.position}
            onClose={noteMenu.close}
            items={items}
            title={`${noteLabel(n.note)} · step ${n.step + 1}`}
            minWidth="12rem"
          />
        );
      })()}
    </div>
  );
};
