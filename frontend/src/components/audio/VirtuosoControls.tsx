/**
 * VirtuosoControls — the MIDI dock's SHAPE row: the virtuoso transforms
 * (harmony / ragtime / runs / polyrhythm / humanize) under the piano roll, so
 * they are reachable from both the roll and the arpeggiator face. Each amount is
 * a native range (arrow keys step it); changes re-render the roll live from the
 * captured source. Key, scale, style and the groove reference sit beside them.
 * CAPTURE snapshots the current roll as the morph base; SONG assembles a full
 * multi-section arrangement; FORM opens the song-structure editor above the row,
 * which lays out the sections (role, bar count, meter) the build uses.
 *
 * A SHAPE | METER switch at the row's left end flips it to the METER face
 * (MeterFace.tsx), remembered across sessions; the row keeps its height, its
 * orb clearance and its single line on both faces.
 */
import React from 'react';
import { Camera, ChevronLeft, ChevronRight, Columns3, ListMusic, Plus, RotateCcw, X } from 'lucide-react';
import { useVirtuosoStore } from '../../state/virtuosoStore';
import { LibraryPicker, MIDI_ONLY_TABS } from './LibraryPicker';
import { MeterFace } from './MeterFace';
import { logError } from '../../state/logStore';
import { meterLabel, parseMeterLabel, sectionMeterChoices } from '../../lib/meterFace';
import {
  STYLES,
  STYLE_NAMES,
  ROLES,
  ROLE_LABELS,
  defaultSections,
  type VirtuosoAmounts,
  type StyleName,
  type Role,
} from '../../lib/virtuosoTransform';
import {
  DOCK_SELECT,
  DockFlyout,
  FIELD,
  FIELD_LEGEND,
  FIELD_VALUE,
  FLYOUT_CARD,
  KEY_REST,
  MINI_ICON_KEY,
  MINI_KEY,
  RANGE,
  STRIP_KEY,
  Sep,
  StripKey,
  keyTone,
  useOrbClearance,
  useStoredToggle,
} from './midiDockKit';

/** The row's face: SHAPE (off) or METER (on). */
const SHAPE_FACE_KEY = 'thedaw-midi-shape-face-v1';

const KEYS = 'C C# D D# E F F# G G# A A# B'.split(' ');
const MODES = [
  'ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian',
  'major', 'minor', 'melodic', 'harmonic',
];

/** Legend = the one printed word; label = the full name for the tooltip and the
 *  accessible name (which always contains the legend). */
const SLIDERS: Array<{ k: keyof VirtuosoAmounts; legend: string; label: string }> = [
  { k: 'harmony', legend: 'Harmony', label: 'Harmony' },
  { k: 'ragtime', legend: 'Ragtime', label: 'Ragtime' },
  { k: 'runs', legend: 'Runs', label: 'Runs' },
  { k: 'rhythm', legend: 'Poly', label: 'Polyrhythm' },
  { k: 'humanize', legend: 'Humanize', label: 'Humanize' },
];

const sectionField =
  'h-4 bg-black/50 border border-white/10 rounded-xs px-1 text-[9px] font-mono text-zinc-200 outline-none';

const SongStructure: React.FC = () => {
  // Select raw state and derive the effective list with useMemo — calling
  // effectiveSections() inside the selector returns a fresh array each render
  // (the default path) and drives an infinite re-render loop.
  const rawSections = useVirtuosoStore((s) => s.sections);
  const style = useVirtuosoStore((s) => s.style);
  const setSectionRole = useVirtuosoStore((s) => s.setSectionRole);
  const setSectionBars = useVirtuosoStore((s) => s.setSectionBars);
  const setSectionMeter = useVirtuosoStore((s) => s.setSectionMeter);
  const addSection = useVirtuosoStore((s) => s.addSection);
  const removeSection = useVirtuosoStore((s) => s.removeSection);
  const moveSection = useVirtuosoStore((s) => s.moveSection);
  const resetSections = useVirtuosoStore((s) => s.resetSections);
  const custom = rawSections != null;
  const sections = React.useMemo(() => rawSections ?? defaultSections(style), [rawSections, style]);

  const totalBars = sections.reduce((n, x) => n + x.bars, 0);

  return (
    <div className="flex flex-col gap-1.5 p-2">
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-black uppercase tracking-[0.18em] et-ink">Form</span>
        <span className="text-[8px] font-mono et-ink-3">
          {sections.length} sections / {totalBars} bars{custom ? '' : ' (style default)'}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={addSection}
          aria-label="Add a section"
          title="Add a section"
          className={`${MINI_KEY} ${KEY_REST}`}
        >
          <Plus aria-hidden="true" className="w-3 h-3" />
          <span>Add</span>
        </button>
        <button
          type="button"
          onClick={resetSections}
          aria-label="Reset the form"
          title="Discard the custom layout and follow the style's default structure."
          className={`${MINI_KEY} ${KEY_REST}`}
        >
          <RotateCcw aria-hidden="true" className="w-3 h-3" />
          <span>Reset</span>
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {sections.map((sec, i) => (
          <div key={i} className="flex items-center gap-0.5 rounded-xs border border-white/10 bg-white/3 px-1 py-0.5">
            <span className="text-[8px] font-mono et-ink-3 w-3 text-right">{i + 1}</span>
            <button
              type="button"
              className={`${MINI_ICON_KEY} ${KEY_REST}`}
              aria-label={`Move section ${i + 1} earlier`}
              title="Earlier"
              onClick={() => moveSection(i, -1)}
            >
              <ChevronLeft aria-hidden="true" className="w-3 h-3" />
            </button>
            <label htmlFor={`vt-sec-role-${i}`} className="sr-only">{`Section ${i + 1} role`}</label>
            <select
              id={`vt-sec-role-${i}`}
              name={`vt-sec-role-${i}`}
              value={sec.role}
              onChange={(e) => setSectionRole(i, e.target.value as Role)}
              className={sectionField}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
            <label htmlFor={`vt-sec-bars-${i}`} className="sr-only">{`Section ${i + 1} bars`}</label>
            <input
              id={`vt-sec-bars-${i}`}
              name={`vt-sec-bars-${i}`}
              type="number"
              min={1}
              max={16}
              value={sec.bars}
              onChange={(e) => setSectionBars(i, parseInt(e.target.value, 10) || 1)}
              className={`${sectionField} w-9`}
            />
            <label htmlFor={`vt-sec-meter-${i}`} className="sr-only">{`Section ${i + 1} meter`}</label>
            <select
              id={`vt-sec-meter-${i}`}
              name={`vt-sec-meter-${i}`}
              value={sec.meter ? meterLabel(sec.meter) : ''}
              onChange={(e) => setSectionMeter(i, parseMeterLabel(e.target.value))}
              title="The section's time signature; Roll follows the piano roll's meter map"
              className={sectionField}
            >
              <option value="">Roll</option>
              {sectionMeterChoices(sec.meter).map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            <button
              type="button"
              className={`${MINI_ICON_KEY} ${KEY_REST}`}
              aria-label={`Move section ${i + 1} later`}
              title="Later"
              onClick={() => moveSection(i, 1)}
            >
              <ChevronRight aria-hidden="true" className="w-3 h-3" />
            </button>
            <button
              type="button"
              className={`${MINI_ICON_KEY} ${KEY_REST}`}
              aria-label={`Remove section ${i + 1}`}
              title="Remove"
              onClick={() => removeSection(i)}
            >
              <X aria-hidden="true" className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

/** `songEntryId`: the library entry chosen in the strip's song field, whose
 *  rhythm analysis MATCH reads the meter map from. */
export const VirtuosoControls: React.FC<{ songEntryId?: string }> = ({ songEntryId }) => {
  const [meterFace, setMeterFace] = useStoredToggle(SHAPE_FACE_KEY, false);
  const amounts = useVirtuosoStore((s) => s.amounts);
  const setAmount = useVirtuosoStore((s) => s.setAmount);
  const keyV = useVirtuosoStore((s) => s.key);
  const modeV = useVirtuosoStore((s) => s.mode);
  const setKey = useVirtuosoStore((s) => s.setKey);
  const setMode = useVirtuosoStore((s) => s.setMode);
  const style = useVirtuosoStore((s) => s.style);
  const setStyle = useVirtuosoStore((s) => s.setStyle);
  const songMode = useVirtuosoStore((s) => s.songMode);
  const captureSource = useVirtuosoStore((s) => s.captureSource);
  const resetToSource = useVirtuosoStore((s) => s.resetToSource);
  const buildSong = useVirtuosoStore((s) => s.buildSong);
  const groove = useVirtuosoStore((s) => s.groove);
  const setGrooveFromBytes = useVirtuosoStore((s) => s.setGrooveFromBytes);
  const clearGroove = useVirtuosoStore((s) => s.clearGroove);
  const [showStructure, setShowStructure] = React.useState(false);
  const [pickGroove, setPickGroove] = React.useState(false);
  const formKeyRef = React.useRef<HTMLButtonElement>(null);
  // The app's assistant orb parks on the bottom-left corner, over this row's
  // start; the row's content begins past it (and ends before it on the right).
  const rowRef = React.useRef<HTMLDivElement>(null);
  const orb = useOrbClearance(rowRef);

  return (
    <>
      <div
        ref={rowRef}
        style={orb.left || orb.right ? { paddingLeft: orb.left || undefined, paddingRight: orb.right || undefined } : undefined}
        className="shrink-0 h-7.5 flex flex-nowrap items-center gap-1 px-1.5 border-t border-white/8 bg-black/40"
        role="group"
        aria-label={meterFace ? 'Meter: time signatures, lanes and generators' : 'Shape: virtuoso transforms'}
      >
        <div role="group" aria-label="Row" className="shrink-0 inline-flex gap-px">
          <button
            type="button"
            aria-pressed={!meterFace}
            title="Shape: the virtuoso transforms"
            className={`${STRIP_KEY} ${keyTone({ on: !meterFace })}`}
            onClick={() => setMeterFace(false)}
          >
            <span>Shape</span>
          </button>
          <button
            type="button"
            aria-pressed={meterFace}
            title="Meter: time signatures, groups, lanes, syncopation and generators"
            className={`${STRIP_KEY} ${keyTone({ on: meterFace })}`}
            onClick={() => setMeterFace(true)}
          >
            <span>Meter</span>
          </button>
        </div>

        <Sep />

        {meterFace ? (
          <MeterFace songEntryId={songEntryId} />
        ) : (
        <div
          className="contents"
          title="Morph the piano roll into virtuoso lines. Dial each amount; the roll re-renders live from the captured source."
        >
        {SLIDERS.map(({ k, legend, label }) => (
          <div key={k} className={FIELD} title={`${label} amount`}>
            <label htmlFor={`vt-${k}`} className={FIELD_LEGEND}>{legend}</label>
            <input
              id={`vt-${k}`}
              name={`vt-${k}`}
              type="range"
              min={0}
              max={100}
              value={Math.round(amounts[k] * 100)}
              onChange={(e) => setAmount(k, (parseInt(e.target.value, 10) || 0) / 100)}
              aria-label={`${label} amount`}
              className={RANGE}
            />
            <span className={`${FIELD_VALUE} w-5`}>{Math.round(amounts[k] * 100)}</span>
          </div>
        ))}

        <Sep />

        <label htmlFor="vt-key" className="sr-only">Key</label>
        <select
          id="vt-key" name="vt-key" value={keyV} onChange={(e) => setKey(e.target.value)}
          title="Key the transforms use"
          className={`${DOCK_SELECT} w-12`}
        >
          {KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <label htmlFor="vt-mode" className="sr-only">Scale</label>
        <select
          id="vt-mode" name="vt-mode" value={modeV} onChange={(e) => setMode(e.target.value)}
          title="Scale the transforms use"
          className={`${DOCK_SELECT} w-24 capitalize`}
        >
          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>

        <div className={FIELD} title="Composition style for SONG (sets the scale, section structure, dynamics and feel)">
          <label htmlFor="vt-style" className={FIELD_LEGEND}>Style</label>
          <select
            id="vt-style" name="vt-style" value={style} onChange={(e) => setStyle(e.target.value as StyleName)}
            className="h-4.5 max-w-28 bg-transparent border-none outline-none text-[10px] font-mono et-ink cursor-pointer"
          >
            {STYLE_NAMES.map((s) => <option key={s} value={s}>{STYLES[s].label}</option>)}
          </select>
        </div>

        <div
          className={FIELD}
          title="Drive the Humanize timing/feel from a reference song's groove (a Library track's transcribed MIDI). Timing pocket + rhythmic emphasis are learned; transcription does not recover dynamics."
        >
          <span className={FIELD_LEGEND}>Groove</span>
          {groove ? (
            <>
              <span className="max-w-24 truncate text-[10px] font-mono et-ink" title={groove.name}>{groove.name}</span>
              <button
                type="button"
                className={`${MINI_ICON_KEY} ${KEY_REST}`}
                aria-label="Clear groove reference"
                title="Clear groove reference"
                onClick={clearGroove}
              >
                <X aria-hidden="true" className="w-3 h-3" />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setPickGroove(true)}
              aria-label="Pick a groove reference"
              title="Pick a groove reference"
              className={`${MINI_KEY} ${KEY_REST}`}
            >
              <span>Pick</span>
            </button>
          )}
        </div>

        <span className="flex-1 min-w-1" />

        <StripKey
          onClick={captureSource}
          title="Snapshot the current piano roll as the morph source (re-grab after changing the arp or notes)."
          icon={<Camera className="w-3 h-3" />}
          legend="Capture"
        />
        <StripKey
          onClick={resetToSource}
          title="Reset amounts to zero and restore the captured source to the roll."
          icon={<RotateCcw className="w-3 h-3" />}
          legend="Reset"
        />
        <StripKey
          ref={formKeyRef}
          onClick={() => setShowStructure((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={showStructure}
          aria-controls="vt-structure"
          title="Open the song-structure configurator: lay out the sections (intro, theme, build, chorus, solo, climax, outro) and their length that SONG uses."
          on={showStructure}
          icon={<Columns3 className="w-3 h-3" />}
          legend="Form"
        />
        <StripKey
          onClick={buildSong}
          aria-pressed={songMode}
          title="Build a full, developing arrangement from the source in the chosen style/structure, with voice-leading, a melody, a crescendo, and rubato. While built, the sliders reshape the whole song; Reset returns to the phrase."
          on={songMode}
          icon={<ListMusic className="w-3 h-3" />}
          legend="Song"
        />
        </div>
        )}
      </div>

      <DockFlyout
        open={showStructure && !meterFace}
        anchorRef={formKeyRef}
        onClose={() => setShowStructure(false)}
        placement="above"
        align="end"
        id="vt-structure"
        role="dialog"
        aria-label="Song form"
        className={`w-150 max-w-[90vw] ${FLYOUT_CARD}`}
      >
        <SongStructure />
      </DockFlyout>

      <LibraryPicker
        open={pickGroove}
        title="Pick a groove reference"
        subtitle="Its timing and velocities become the groove template"
        tabs={MIDI_ONLY_TABS}
        allowFiles
        showInstrument
        onClose={() => setPickGroove(false)}
        onPick={(pick) => {
          setPickGroove(false);
          if (pick.kind !== 'midi') return;
          const ok = setGrooveFromBytes(pick.bytes, pick.label);
          if (!ok) logError('virtuoso', 'That MIDI had no notes to learn a groove from.');
        }}
      />
    </>
  );
};
