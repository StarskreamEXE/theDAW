import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Info, Minus, Plus, Save, Send, Trash2, Unlink } from 'lucide-react';
import { DEFAULT_LANES, usePianoRollStore, pianoNotesToMidiNotes, type PianoNote } from '../../state/pianoRollStore';
import { usePlaybackStore } from '../../state/playbackStore';
import { getEngineCtx } from '../../state/playerStore';
import { useEditorStore, computePeaks } from '../../state/editorStore';
import { downloadMidi, parseMidi } from '../../utils/midi';
import { logError, logInfo } from '../../state/logStore';
import type { Meter } from '../../lib/colony';
import {
  barAt,
  bars as meterBars,
  gridLines,
  meterEquals,
  meterMapToMidiEvents,
  midiEventsToMeterMap,
  normalizeMeterMap,
  roundUpToBar,
  unrollLanes,
  type BarSpan,
  type PolyLane,
} from '../../lib/meterMap';
import { playedRollNotes, rollClipFields } from '../../lib/rollClip';
import { syncopationByBar } from '../../lib/syncopation';
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
/** Step lines draw only from this step width up; below it the bar, group and beat tiers carry the grid. */
const STEP_LINES_MIN_PX = 10;
/** The pickup cell prints its legend from this width (px) up; a narrower one keeps it in its title. */
const PICKUP_LEGEND_MIN_PX = 36;
/** Notes and lane repeats draw this far (px) past each side of the view, so a scroll redraws them only after crossing it. */
const WINDOW_OVERSCAN_PX = 960;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlackKey = (midi: number) => [1, 3, 6, 8, 10].includes(midi % 12);
const noteLabel = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

/** The ruler's meter text: "7/8 3+2+2", "5/4 2+3", "4/4". */
const meterLabel = (m: Meter): string => `${m.num}/${m.den}${m.groups.length > 1 ? ` ${m.groups.join('+')}` : ''}`;

/** One SVG path of vertical lines at `steps`, from y0 to y1, on whole pixels. */
const linesPath = (steps: readonly number[], stepPx: number, y0: number, y1: number): string => {
  let d = '';
  for (const s of steps) d += `M${Math.round(s * stepPx) + 0.5} ${y0}V${y1}`;
  return d;
};

/** The notes as they sound, lane repeats written out and lane ids dropped (lib/rollClip); every hand-off that plays a note list once takes it. */
export { playedRollNotes };

/**
 * A lane note's look, all in the one accent. The active lane draws solid; each
 * other lane takes the next form by its rank among the inactive lanes:
 * outlined, striped, then outlined with a sparse hatch and striped the other way.
 * `edge` is the border colour, which a selected note replaces with white.
 * `minPx` is the narrowest a note of the form draws, so a one-step outlined or
 * striped note keeps its form at the smallest zoom.
 */
interface LaneForm { fill: string; edge: string; minPx: number; style?: React.CSSProperties }
const stripes = (angle: number): React.CSSProperties => ({
  backgroundImage: `repeating-linear-gradient(${angle}deg, rgb(var(--et-accent)) 0 2px, rgb(var(--et-accent) / 0.16) 2px 4px)`,
});
const SOLID_FORM: LaneForm = { fill: 'bg-[rgb(var(--et-accent))]', edge: 'border-black/40', minPx: 4 };
const LANE_FORMS: readonly LaneForm[] = [
  { fill: 'bg-[rgb(var(--et-accent)/0.14)]', edge: 'border-[rgb(var(--et-accent))]', minPx: 8 },
  { fill: '', edge: 'border-[rgb(var(--et-accent)/0.8)]', minPx: 8, style: stripes(135) },
  {
    fill: 'bg-[rgb(var(--et-accent)/0.14)]',
    edge: 'border-[rgb(var(--et-accent))]',
    minPx: 8,
    style: { backgroundImage: 'repeating-linear-gradient(45deg, rgb(var(--et-accent) / 0.55) 0 1px, transparent 1px 5px)' },
  },
  { fill: '', edge: 'border-[rgb(var(--et-accent)/0.8)]', minPx: 8, style: stripes(45) },
];

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
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);
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
  // the store's current step, which every tick writes. It plays the lanes
  // unrolled. Each tick reads the notes, lanes, length and BPM from the store,
  // so an edit while playing (a note, a meter, a lane's loop) changes what plays
  // next without a restart, and a step already scheduled is never scheduled again.
  useEffect(() => {
    if (!isPlaying) return;
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    const lookahead = 0.12; // seconds scheduled ahead each tick
    const startStep = usePianoRollStore.getState().currentStep;
    // Absolute step `clock.step` sounds at `clock.time`; a tempo change re-anchors the clock at the cursor.
    const clock = { step: startStep, time: ctx.currentTime + 0.06, stepSec: 0 };
    // Absolute step s is roll step (s - lap.base) mod lap.total; a length change re-anchors the lap at the cursor.
    const lap = { base: 0, total: 0 };
    let cursor = startStep - 1e-4; // absolute step scheduled up to (inclusive)
    // Unroll once per note, lane or length edit, not once per tick.
    let source: { notes: PianoNote[]; lanes: PolyLane[]; total: number } | null = null;
    let played: PianoNote[] = [];

    const tick = () => {
      const now = ctx.currentTime;
      const { notes, lanes, totalSteps: steps, bpm: tempo } = usePianoRollStore.getState();
      const total = Math.max(1, steps);
      const stepSec = 60 / Math.max(40, tempo) / 4;
      if (clock.stepSec === 0) clock.stepSec = stepSec;
      else if (stepSec !== clock.stepSec) {
        clock.time += (cursor - clock.step) * clock.stepSec;
        clock.step = cursor;
        clock.stepSec = stepSec;
      }
      if (lap.total === 0) lap.total = total;
      else if (total !== lap.total) {
        // The playhead keeps its place, or starts over when the roll now ends before it.
        const pos = (((cursor - lap.base) % lap.total) + lap.total) % lap.total;
        lap.base = pos < total ? cursor - pos : cursor + 1e-4;
        lap.total = total;
      }
      if (!source || source.notes !== notes || source.lanes !== lanes || source.total !== total) {
        source = { notes, lanes, total };
        played = unrollLanes(notes, lanes, total);
      }
      const targetAbs = clock.step + (now + lookahead - clock.time) / stepSec;
      for (const n of played) {
        const first = lap.base + n.step;
        let occ = first + Math.ceil((cursor - first) / total) * total;
        if (occ <= cursor) occ += total;
        while (occ <= targetAbs) {
          const when = clock.time + (occ - clock.step) * stepSec;
          triggerPianoNote(n.note, n.velocity, Math.max(now, when), n.length * stepSec, masterRef.current);
          occ += total;
        }
      }
      cursor = Math.max(cursor, targetAbs);
      const elapsedAbs = clock.step + (now - clock.time) / stepSec;
      setCurrentStep((((elapsedAbs - lap.base) % total) + total) % total);
    };
    playTimerRef.current = window.setInterval(tick, 25);
    return () => {
      if (playTimerRef.current != null) {
        window.clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [isPlaying, setCurrentStep, masterRef]);

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

  // STEPS moves by one bar of the meter the roll ends in, and a new length
  // lands on the next bar line in the direction of the change, whatever the meter.
  // A step from the arrow keys or the spin buttons applies at once. A typed
  // length applies on Enter or when the field loses focus, so the store never
  // rounds a first digit up to a bar line while the rest is still being typed.
  const endBarSteps = barAt(meterMap, Math.max(0, totalSteps - 1e-6), pickupSteps).len;
  const [stepsDraft, setStepsDraft] = useState<string | null>(null);
  const changeTotalSteps = (v: number) => {
    if (!Number.isFinite(v)) return;
    setTotalSteps(v > totalSteps ? roundUpToBar(meterMap, v, pickupSteps) : barAt(meterMap, v, pickupSteps).start);
  };
  const commitStepsDraft = () => {
    if (stepsDraft === null) return;
    setStepsDraft(null);
    changeTotalSteps(parseInt(stepsDraft));
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
          step={endBarSteps}
          value={stepsDraft ?? totalSteps}
          onChange={(e) => {
            // Typing arrives as an InputEvent; a step from the arrows or the spin buttons as a plain Event.
            if ('inputType' in e.nativeEvent) {
              setStepsDraft(e.target.value);
              return;
            }
            setStepsDraft(null);
            changeTotalSteps(parseInt(e.target.value));
          }}
          onBlur={commitStepsDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitStepsDraft();
            else if (e.key === 'Escape') setStepsDraft(null);
          }}
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
    const { notes, replaceAll, meterMap, pickupSteps } = usePianoRollStore.getState();
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
      // Parity counts from the bar's start, so after a bar with an odd number of
      // steps (5/16, 7/16) the next bar's downbeat stays on the beat.
      const fromBar = Math.round(gridStep - barAt(meterMap, gridStep, pickupSteps).start);
      if (fromBar % 2 === 1) step = Math.max(0, step + swing);
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
      const { setBpm, setTotalSteps, meterMap, pickupSteps } = usePianoRollStore.getState();
      if (key === 'bpm') setBpm(Math.round(value));
      else if (key === 'totalSteps') {
        // Up to the next bar line of the roll's meter.
        setTotalSteps(Math.max(16, roundUpToBar(meterMap, Math.round(value), pickupSteps)));
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
    const roll = usePianoRollStore.getState();
    const { bpm, totalSteps } = roll;
    if (roll.notes.length === 0) {
      logError('piano-roll', 'No notes to bounce');
      return;
    }
    // The editor plays a clip's notes once, so it gets the lane repeats written
    // out (sourcePianoRoll). The roll's own notes, meter map, pickup and lanes are
    // copied beside them, so re-editing later sees the exact same state.
    const fields = rollClipFields(roll);
    const notes = fields.sourcePianoRoll;
    setIsBouncing(true);
    const start = performance.now();
    try {
      const { blob, duration } = await renderPianoRollToBlob(notes, bpm, totalSteps);
      const { peaks } = await computePeaks(blob, 240);
      const editor = useEditorStore.getState();

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
            ...fields,
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
        ...fields,
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

/** Save the roll as a Standard MIDI File at its own BPM and time signatures, lane repeats written out. */
export const exportRollMidi = async (): Promise<void> => {
  const { notes: stored, bpm, totalSteps, lanes, meterMap, pickupSteps } = usePianoRollStore.getState();
  if (stored.length === 0) {
    logError('piano-roll', 'No notes to export');
    return;
  }
  const notes = playedRollNotes(stored, lanes, totalSteps);
  const ppq = 480;
  const midiNotes = pianoNotesToMidiNotes(notes, ppq);
  const result = await downloadMidi(
    {
      ppq,
      bpm,
      tempos: [{ tick: 0, bpm }],
      // One FF 58 per meter change, a partial bar at tick 0 for a pickup.
      timeSignatures: meterMapToMidiEvents(meterMap, ppq, pickupSteps),
      tracks: [
        { name: 'Piano Roll', notes: midiNotes },
      ],
    },
    'piano-roll',
  );
  // A cancelled or failed save exported nothing; saveFile already logged a failure.
  if (result.path) logInfo('piano-roll', `Exported ${notes.length} notes as MIDI to ${result.path}`);
  else if (result.downloaded) logInfo('piano-roll', `Exported ${notes.length} notes as MIDI`);
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
      // The file's time signatures and pickup; a file with none is 4/4. Its notes
      // carry no lanes, so the roll's lanes reset to lane A alone.
      const { map, pickupSteps } = midiEventsToMeterMap(data.timeSignatures ?? [], data.ppq);
      // importNotes auto-fits the grid length (to a bar line of that map) AND pitch range to the import.
      usePianoRollStore.getState().importNotes(flat, data.bpm, { meterMap: map, pickupSteps, lanes: [...DEFAULT_LANES] });
      logInfo('piano-roll', `Imported ${flat.length} notes from "${file.name}" at ${Math.round(data.bpm)} BPM in ${meterLabel(map[0].meter)}`);
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
      // The score's first time signature holds for the whole roll; a score with
      // none, or one the roll cannot draw, is 4/4. Its notes start at step 0 and
      // carry no lanes, so the roll's lanes reset to lane A alone.
      const [num, den] = score.time_signature ?? [];
      const meterMap = normalizeMeterMap([{ bar: 0, meter: { num: Number(num), den: Number(den), groups: [] } }]);
      usePianoRollStore.getState().importNotes(flat, score.bpm, { meterMap, pickupSteps: 0, lanes: [...DEFAULT_LANES] });
      logInfo(
        'piano-roll',
        `Imported ${flat.length} notes from score "${file.name}" (${score.format}) at ${Math.round(score.bpm)} BPM in ${meterLabel(meterMap[0].meter)}`,
      );
    } catch (e) {
      logError('piano-roll', `Sheet import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
};

/* ── the grid: keyboard column, ruler, notes ──────────────────────────────── */

/**
 * The ruler: one cell per bar, as wide as the bar and clipped at the roll's
 * end, with its number ("Pickup" on a pickup wide enough to hold it), the meter
 * wherever it changes, a syncopation band along the top, and over the cells the
 * bar lines (the grid's own bar tier) with group and beat ticks. The band's
 * strength is each bar's LHL score over the highest score in the whole roll, so
 * a bar reads the same at any scroll.
 */
const RollRuler = React.memo(function RollRuler({
  spans,
  lhl,
  tiers,
  stepPx,
  totalSteps,
}: {
  spans: BarSpan[];
  lhl: number[];
  tiers: { bar: number[]; group: number[]; beat: number[] };
  stepPx: number;
  totalSteps: number;
}) {
  const width = totalSteps * stepPx;
  const ticks = useMemo(
    () => ({
      bar: linesPath(tiers.bar, stepPx, 0, HEADER_HEIGHT),
      group: linesPath(tiers.group, stepPx, 14, 21),
      beat: linesPath(tiers.beat, stepPx, 18, 21),
    }),
    [tiers, stepPx],
  );
  const max = useMemo(() => lhl.reduce((m, v) => Math.max(m, v), 0), [lhl]);

  return (
    // An opaque ground in the theme's canvas: notes and loop lines scrolled under the ruler stay off its ticks and text.
    <div className="sticky top-0 z-20 bg-[#07050a] border-b border-white/5" style={{ height: HEADER_HEIGHT, width, minWidth: '100%' }}>
      {spans.map((b, i) => {
        const prev = i > 0 ? spans[i - 1] : null;
        const change = b.bar >= 0 && (!prev || prev.bar < 0 || !meterEquals(prev.meter, b.meter));
        const score = lhl[i] ?? 0;
        const alpha = 0.12 + 0.88 * (max > 0 ? Math.min(1, score / max) : 0);
        const cellPx = Math.max(0, Math.min(b.len, totalSteps - b.start)) * stepPx;
        return (
          <div
            key={b.start}
            data-ruler-bar="1"
            className="absolute top-0 bottom-0 overflow-hidden flex items-center gap-1 pl-1 text-[8px] leading-none font-mono text-zinc-500 tabular-nums whitespace-nowrap"
            style={{ left: b.start * stepPx, width: cellPx }}
            title={`${b.bar < 0 ? 'Pickup' : `Bar ${b.bar + 1}`} syncopation ${score.toFixed(2)}`}
          >
            <div
              data-sync-band="1"
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-0.75"
              style={{ backgroundColor: `rgb(var(--et-accent) / ${alpha.toFixed(3)})` }}
            />
            {b.bar >= 0 ? b.bar + 1 : cellPx >= PICKUP_LEGEND_MIN_PX ? 'Pickup' : null}
            {change && <span className="font-semibold et-ink">{meterLabel(b.meter)}</span>}
          </div>
        );
      })}
      <svg
        aria-hidden="true"
        focusable="false"
        className="absolute top-0 left-0 h-full pointer-events-none"
        width={width}
        shapeRendering="crispEdges"
      >
        <path d={ticks.beat} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.2)]" />
        <path d={ticks.group} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.4)]" />
        <path d={ticks.bar} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.2)]" />
      </svg>
    </div>
  );
});

/**
 * The step range the grid shows, widened by the overscan on each side and
 * snapped out to whole overscan blocks, so a scroll changes it only when it
 * crosses a block. Until the grid is measured it is the roll's start, one
 * window wide plus the overscan.
 */
function useStepWindow(scrollRef: React.RefObject<HTMLDivElement | null>, stepPx: number): { from: number; to: number } {
  const [win, setWin] = useState(() => ({ from: 0, to: (window.innerWidth + 2 * WINDOW_OVERSCAN_PX) / stepPx }));
  // A passive effect: the grid's scroll element takes its ref after this child's layout effects run.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const x0 = Math.floor(el.scrollLeft / WINDOW_OVERSCAN_PX) * WINDOW_OVERSCAN_PX - WINDOW_OVERSCAN_PX;
      const x1 = Math.ceil((el.scrollLeft + el.clientWidth) / WINDOW_OVERSCAN_PX) * WINDOW_OVERSCAN_PX + WINDOW_OVERSCAN_PX;
      const next = { from: Math.max(0, x0) / stepPx, to: x1 / stepPx };
      setWin((w) => (w.from === next.from && w.to === next.to ? w : next));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener('scroll', schedule, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', schedule);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, stepPx]);
  return win;
}

/**
 * Lane repeats: drawn under the stored notes, never clicked, and out of the
 * accessibility tree (the stored note speaks for them). Only the repeats inside
 * `win` (the view and its overscan) render, so a long roll with a short loop
 * stays light. A repeat keeps its lane's edge at full strength and fades only its fill.
 */
const LaneRepeats = React.memo(function LaneRepeats({
  repeats,
  laneOf,
  stepPx,
  lowestNote,
  highestNote,
  win,
}: {
  repeats: PianoNote[];
  laneOf: (lane: number | undefined) => { form: LaneForm; name: string };
  stepPx: number;
  lowestNote: number;
  highestNote: number;
  win: { from: number; to: number };
}) {
  return (
    <div aria-hidden="true" className="pointer-events-none">
      {repeats.map((n) => {
        if (n.note < lowestNote || n.note > highestNote) return null;
        if (n.step > win.to || n.step + n.length < win.from) return null;
        const { form } = laneOf(n.lane);
        return (
          <div
            key={n.id}
            data-lane-repeat="1"
            className={`absolute rounded-sm border overflow-hidden z-5 ${form.edge}`}
            style={{
              left: n.step * stepPx,
              width: Math.max(form.minPx, n.length * stepPx - 1),
              top: (highestNote - n.note) * NOTE_HEIGHT + 1,
              height: NOTE_HEIGHT - 2,
            }}
          >
            <div className={`absolute inset-0 opacity-38 ${form.fill}`} style={form.style} />
          </div>
        );
      })}
    </div>
  );
});

/** The MIDI notes from the top row down. */
const rowNotes = (lowestNote: number, highestNote: number): number[] => {
  const rows: number[] = [];
  for (let n = highestNote; n >= lowestNote; n -= 1) rows.push(n);
  return rows;
};

/** The keyboard column's keys, one per row; a click previews the pitch. Re-renders only when the range changes. */
const KeyboardKeys = React.memo(function KeyboardKeys({
  lowestNote,
  highestNote,
  masterRef,
}: {
  lowestNote: number;
  highestNote: number;
  masterRef: { current: number };
}) {
  return (
    <>
      {rowNotes(lowestNote, highestNote).map((midi) => {
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
    </>
  );
});

/** The grid's row backgrounds: alternating black/white key tint and row lines. Re-renders only when the range changes. */
const RowBackgrounds = React.memo(function RowBackgrounds({ lowestNote, highestNote }: { lowestNote: number; highestNote: number }) {
  return (
    <>
      {rowNotes(lowestNote, highestNote).map((midi, idx) => (
        <div
          key={midi}
          className={`absolute left-0 right-0 border-b ${isBlackKey(midi) ? 'bg-white/2' : 'bg-white/4'} ${midi % 12 === 0 ? 'border-white/10' : 'border-black/30'}`}
          style={{ top: idx * NOTE_HEIGHT, height: NOTE_HEIGHT }}
        />
      ))}
    </>
  );
});

/** The playhead: a 1px line in the theme's primary ink, which holds contrast on
 *  the grid and across the accent-filled notes. No glow. Only this re-renders
 *  as the roll plays. */
const RollPlayhead: React.FC<{ stepPx: number }> = ({ stepPx }) => {
  const isPlaying = usePianoRollStore((s) => s.isPlaying);
  const currentStep = usePianoRollStore((s) => s.currentStep);
  if (!isPlaying) return null;
  return (
    <div
      className="absolute top-0 bottom-0 w-px bg-[rgb(var(--et-ink))] z-30 pointer-events-none"
      style={{ left: currentStep * stepPx + stepPx / 2 }}
    />
  );
};

export const PianoRoll: React.FC<{ stepPx: number; onStepPxChange: (px: number) => void }> = ({
  stepPx,
  onStepPxChange,
}) => {
  const notes = usePianoRollStore((s) => s.notes);
  const totalSteps = usePianoRollStore((s) => s.totalSteps);
  const lowestNote = usePianoRollStore((s) => s.lowestNote);
  const highestNote = usePianoRollStore((s) => s.highestNote);
  const selectedNoteId = usePianoRollStore((s) => s.selectedNoteId);
  const recordedRange = usePianoRollStore((s) => s.recordedRange);
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);
  const lanes = usePianoRollStore((s) => s.lanes);
  const activeLane = usePianoRollStore((s) => s.activeLane);

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
  // The steps in view plus the overscan: notes and lane repeats outside it do not render.
  const view = useStepWindow(gridScrollRef, stepPx);

  // The meter as the grid draws it: bars, the three line tiers, the notes as
  // they play (lane repeats written out) and each bar's syncopation score.
  const barSpans = useMemo(() => meterBars(meterMap, totalSteps, pickupSteps), [meterMap, totalSteps, pickupSteps]);
  const tiers = useMemo(() => gridLines(meterMap, totalSteps, pickupSteps), [meterMap, totalSteps, pickupSteps]);
  // The scores read only each note's step, velocity and lane, so an edit that
  // changes none of them (a resize, a pitch move) keeps the previous note list
  // here and skips the unroll and the scoring.
  const onsetRef = useRef<PianoNote[]>(notes);
  const onsetNotes = useMemo(() => {
    const prev = onsetRef.current;
    const same = prev.length === notes.length
      && prev.every((p, i) => p === notes[i] || (p.step === notes[i].step && p.velocity === notes[i].velocity && p.lane === notes[i].lane));
    if (!same) onsetRef.current = notes;
    return onsetRef.current;
  }, [notes]);
  // The same scores keep the same array, so the ruler skips an edit that moves no onset.
  const lhlRef = useRef<number[]>([]);
  const barLhl = useMemo(() => {
    const played = unrollLanes(onsetNotes, lanes, totalSteps);
    const next = syncopationByBar(played, meterMap, totalSteps, pickupSteps).map((b) => b.lhl);
    const prev = lhlRef.current;
    if (prev.length === next.length && prev.every((v, i) => v === next[i])) return prev;
    lhlRef.current = next;
    return next;
  }, [onsetNotes, lanes, meterMap, totalSteps, pickupSteps]);

  // Each tier is one SVG path, so the grid's node count stays flat at any
  // length. Step lines skip the steps a stronger tier already draws.
  const gridPaths = useMemo(() => {
    const drawn = new Set([...tiers.bar, ...tiers.group, ...tiers.beat]);
    const steps: number[] = [];
    if (stepPx >= STEP_LINES_MIN_PX) for (let i = 0; i <= totalSteps; i += 1) if (!drawn.has(i)) steps.push(i);
    return {
      step: linesPath(steps, stepPx, 0, gridHeight),
      beat: linesPath(tiers.beat, stepPx, 0, gridHeight),
      group: linesPath(tiers.group, stepPx, 0, gridHeight),
      bar: linesPath(tiers.bar, stepPx, 0, gridHeight),
    };
  }, [tiers, stepPx, totalSteps, gridHeight]);

  // The notes in looping lanes, kept as the same array while none of them
  // changes, so an edit in a lane that does not loop leaves the repeats alone.
  const loopNotesRef = useRef<PianoNote[]>([]);
  const loopNotes = useMemo(() => {
    const looping = new Set(lanes.filter((l) => l.cycleSteps != null && l.cycleSteps > 0 && l.cycleSteps < totalSteps).map((l) => l.id));
    const next = looping.size ? notes.filter((n) => n.lane !== undefined && looping.has(n.lane)) : [];
    const prev = loopNotesRef.current;
    if (prev.length === next.length && prev.every((n, i) => n === next[i])) return prev;
    loopNotesRef.current = next;
    return next;
  }, [notes, lanes, totalSteps]);

  // A looping lane's repeats: its notes unrolled, less each copy that sits at
  // its note's stored step. A note placed past its lane's first cycle wraps, so
  // its first copy is a repeat too. A copy after the first has the id `<id>~<k>`.
  const repeats = useMemo(() => {
    const byId = new Map(loopNotes.map((n) => [n.id, n]));
    return unrollLanes(loopNotes, lanes, totalSteps).filter((u) => {
      const src = byId.get(u.id) ?? byId.get(u.id.slice(0, u.id.lastIndexOf('~')));
      return !(src && Math.abs(src.step - u.step) < 1e-6);
    });
  }, [loopNotes, lanes, totalSteps]);

  const loopEnds = useMemo(
    () => lanes.filter((l): l is PolyLane & { cycleSteps: number } => l.cycleSteps != null && l.cycleSteps > 0 && l.cycleSteps < totalSteps),
    [lanes, totalSteps],
  );

  const laneOf = useMemo(() => {
    const forms = new Map<number, { form: LaneForm; name: string }>();
    let rank = 0;
    for (const l of lanes) {
      if (l.id === activeLane) forms.set(l.id, { form: SOLID_FORM, name: l.name });
      else {
        forms.set(l.id, { form: LANE_FORMS[rank % LANE_FORMS.length], name: l.name });
        rank += 1;
      }
    }
    // A note whose lane is gone plays as lane 0 (unrollLanes passes it through), so it draws as lane 0.
    return (lane: number | undefined) => forms.get(lane ?? 0) ?? forms.get(0) ?? { form: SOLID_FORM, name: 'A' };
  }, [lanes, activeLane]);

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
    // If clicked on an existing note → select it, or remove it when it was
    // already selected before this press. Only stored notes count; a lane
    // repeat is drawn, not stored, and clicks pass through it.
    const hit = notes.find(
      (n) => n.note === targetNote && targetStep >= n.step && targetStep < n.step + n.length,
    );
    if (hit) {
      const press = pressRef.current;
      pressRef.current = null;
      const wasSelected = press ? press.id === hit.id && press.wasSelected : selectedNoteId === hit.id;
      if (wasSelected) {
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

  // A press on a note selects it. The click that ends the press deletes the
  // note only when it was selected before the press and the press did not
  // resize it, so the first click selects and a second click deletes.
  const pressRef = useRef<{ id: string; wasSelected: boolean } | null>(null);
  // Right-drag a note to extend its length.
  const resizeRef = useRef<{ id: string; startX: number; initialLength: number } | null>(null);
  const onNotePointerDown = (e: React.PointerEvent, note: PianoNote, edge: 'right' | 'body') => {
    e.stopPropagation();
    pressRef.current = { id: note.id, wasSelected: usePianoRollStore.getState().selectedNoteId === note.id };
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
    if (Math.abs(dx) >= 3 && pressRef.current?.id === op.id) pressRef.current.wasSelected = false;
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
              <KeyboardKeys lowestNote={lowestNote} highestNote={highestNote} masterRef={masterRef} />
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
          <RollRuler spans={barSpans} lhl={barLhl} tiers={tiers} stepPx={stepPx} totalSteps={totalSteps} />

          <div
            ref={gridRef}
            // A press that starts off every note clears a note press that ended without a click.
            onPointerDown={() => { pressRef.current = null; }}
            onClick={handleGridClick}
            className="relative cursor-crosshair"
            style={{ width: gridWidth, height: gridHeight }}
          >
            <RowBackgrounds lowestNote={lowestNote} highestNote={highestNote} />
            {/* Vertical lines: bar lines strongest, then group starts, beats and
                (when a step is wide enough) steps. */}
            <svg
              aria-hidden="true"
              focusable="false"
              className="absolute top-0 left-0 pointer-events-none"
              width={gridWidth}
              height={gridHeight}
              shapeRendering="crispEdges"
            >
              {gridPaths.step && <path d={gridPaths.step} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.03)]" />}
              <path d={gridPaths.beat} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.06)]" />
              <path d={gridPaths.group} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.12)]" />
              <path d={gridPaths.bar} fill="none" strokeWidth={1} className="stroke-[rgb(var(--et-line)/0.2)]" />
            </svg>
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
            {/* Loop ends: a dashed line where each looping lane starts over. The
                tag, the lane's swatch and its cycle in steps, sticks under the
                ruler while the grid scrolls and sits between neighbouring loop
                lines: right of its line, or left of it when the next line is too
                close on the right and the left has room. Each lane's tag sits a
                row lower so tags of nearby loops never overlap. Its title and
                accessible name say it in words. */}
            {loopEnds.map((l, i) => {
              const { form } = laneOf(l.id);
              const name = `Lane ${l.name} loops every ${l.cycleSteps} steps`;
              const tagPx = 16 + 5 * String(l.cycleSteps).length;
              const others = loopEnds.map((o) => o.cycleSteps);
              const roomRight = (Math.min(totalSteps, ...others.filter((c) => c > l.cycleSteps)) - l.cycleSteps) * stepPx;
              const roomLeft = (l.cycleSteps - Math.max(0, ...others.filter((c) => c < l.cycleSteps))) * stepPx;
              const onLeft = roomRight < tagPx && roomLeft >= tagPx;
              return (
                <div
                  key={l.id}
                  className="absolute top-0 bottom-0 w-0 border-l border-dashed border-[rgb(var(--et-ink)/0.5)] z-15 pointer-events-none"
                  style={{ left: l.cycleSteps * stepPx }}
                >
                  <span
                    role="img"
                    aria-label={name}
                    title={name}
                    data-loop-tag="1"
                    className={`sticky flex w-max items-center gap-0.5 ${onLeft ? '-ml-0.5 -translate-x-full' : 'ml-0.5'} px-0.5 py-0.5 rounded-xs bg-[#0a080f] text-[8px] leading-none font-mono font-semibold et-ink tabular-nums whitespace-nowrap pointer-events-auto`}
                    style={{ top: HEADER_HEIGHT + 4 + i * 16, marginTop: 4 + i * 16 }}
                  >
                    <span className={`w-2 h-2 rounded-xs border ${form.fill} ${form.edge}`} style={form.style} />
                    {l.cycleSteps}
                  </span>
                </div>
              );
            })}
            <RollPlayhead stepPx={stepPx} />
            <LaneRepeats
              repeats={repeats}
              laneOf={laneOf}
              stepPx={stepPx}
              lowestNote={lowestNote}
              highestNote={highestNote}
              win={view}
            />
            {/* Notes */}
            {notes.map((n) => {
              if (n.note < lowestNote || n.note > highestNote) return null;
              if (n.step > view.to || n.step + n.length < view.from) return null;
              const row = highestNote - n.note;
              const left = n.step * stepPx;
              const lane = laneOf(n.lane);
              // The form's minimum drawn width grows the note to the right only; its start and stored length stay.
              const width = Math.max(lane.form.minPx, n.length * stepPx - 1);
              const top = row * NOTE_HEIGHT;
              const selected = n.id === selectedNoteId;
              return (
                <div
                  key={n.id}
                  data-piano-note="1"
                  onClick={(e) => {
                    e.stopPropagation();
                    const press = pressRef.current;
                    pressRef.current = null;
                    if (press?.id === n.id && press.wasSelected) removeNote(n.id);
                    else setSelectedNote(n.id);
                  }}
                  onPointerDown={(e) => onNotePointerDown(e, n, 'body')}
                  onContextMenu={(e) => { e.stopPropagation(); setSelectedNote(n.id); noteMenu.open(e, n); }}
                  className={`absolute rounded-sm border z-10 transition-[filter] ${lane.form.fill} ${selected ? 'border-white brightness-125' : `${lane.form.edge} hover:brightness-110`}`}
                  style={{ ...lane.form.style, left, width, top: top + 1, height: NOTE_HEIGHT - 2 }}
                  title={`${noteLabel(n.note)} · step ${n.step + 1} · ${n.length} step${n.length === 1 ? '' : 's'}${lanes.length > 1 ? ` · lane ${lane.name}` : ''}`}
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
              // The copy stays in the source note's lane, not the active one.
              addNote({ note: n.note, step: n.step + n.length, length: n.length, velocity: n.velocity, lane: n.lane ?? 0 });
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
