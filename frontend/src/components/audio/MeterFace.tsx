/**
 * MeterFace — the SHAPE row's METER face: the piano roll's meter map, its
 * polymeter lanes and the syncopation amounts, inline on one row.
 *
 *   BARS    the selected meter change's bars, stepped change to change
 *   BEATS   its numerator; the /4 /8 /16 keys its unit; GROUPS its grouping
 *   ADD     a change at the playhead's bar; the trash key removes the selected one
 *   LANES   one key per lane in its roll look; + adds a lane, the trash key
 *           removes the active one
 *   LOOP    the active lane's loop in steps (Shift steps a bar)
 *   SYNC / ACCENT  the Virtuoso amounts
 *   GEN     LOOM's rules written into the active lane, from a flyout
 *   MATCH   the meter map, pickup, tempo and lanes of the song in the strip
 *
 * The logic is lib/meterFace.ts. Meter edits write the store with setState:
 * setMeterMap merges a segment that repeats its neighbour's meter, which would
 * take the selected change away while BEATS steps through that meter.
 */
import React from 'react';
import { create } from 'zustand';
import { AudioWaveform, Blocks, ChevronLeft, ChevronRight, Dices, Minus, Plus, Send, Trash2 } from 'lucide-react';
import { usePianoRollStore } from '../../state/pianoRollStore';
import { useVirtuosoStore } from '../../state/virtuosoStore';
import { useStatusBarStore } from '../../state/statusBarStore';
import { logError, logInfo, logWarn } from '../../state/logStore';
import { fetchRhythm } from '../../lib/rhythmSeed';
import { GEN_RULES } from '../../lib/rollLoom';
import { GEN_DEFAULT_OPTS, GEN_KINDS, type GenKind, type GenOpts } from '../../lib/loomGen';
import { normalizeMeterMap, stepsPerBar } from '../../lib/meterMap';
import {
  BEATS_MAX, BEATS_MIN, UNITS, addChange, clampSelection, formatOption, genOptionSpecs, genPreview, genStatus, genTarget,
  genWrite, groupChoices, groupsValue, laneForms, lanePitches, matchApply, matchError, meterLabel, newLaneCycle,
  parseGroupsValue, removeChange, segmentAtStep, segmentLabel, setBeats, setGroups, setUnit, stepLoop, stepOption,
  type GateChoice, type GenSettings, type LaneForm, type MeterEdit,
} from '../../lib/meterFace';
import {
  DockFlyout, FIELD, FIELD_LEGEND, FIELD_VALUE, FLYOUT_CARD, KEY_REST, MINI_ICON_KEY, MINI_KEY, RANGE, STRIP_ICON_KEY,
  STRIP_KEY, Sep, StripKey, keyTone,
} from './midiDockKit';

type Level = 'info' | 'warn' | 'error';

/** A result for the status bar and the LOG. */
const post = (text: string, level: Level = 'info'): void => {
  useStatusBarStore.getState().setText(text);
  (level === 'error' ? logError : level === 'warn' ? logWarn : logInfo)('midi', text);
};

/** MATCH can outlive the face (a flip to SHAPE mid-analysis), so its busy flag is shared. */
const useMatchBusy = create<{ busy: boolean }>(() => ({ busy: false }));

/* ── lane swatches: PianoRoll.tsx's lane forms, in the one accent ─────────── */

const accentStripes = (angle: number): React.CSSProperties => ({
  backgroundImage: `repeating-linear-gradient(${angle}deg, rgb(var(--et-accent)) 0 2px, rgb(var(--et-accent) / 0.16) 2px 4px)`,
});
const SWATCH: Record<LaneForm, { className: string; style?: React.CSSProperties }> = {
  solid: { className: 'bg-[rgb(var(--et-accent))] border-black/40' },
  outline: { className: 'bg-[rgb(var(--et-accent)/0.14)] border-[rgb(var(--et-accent))]' },
  stripe: { className: 'border-[rgb(var(--et-accent)/0.8)]', style: accentStripes(135) },
  hatch: {
    className: 'bg-[rgb(var(--et-accent)/0.14)] border-[rgb(var(--et-accent))]',
    style: { backgroundImage: 'repeating-linear-gradient(45deg, rgb(var(--et-accent) / 0.55) 0 1px, transparent 1px 5px)' },
  },
  stripe45: { className: 'border-[rgb(var(--et-accent)/0.8)]', style: accentStripes(45) },
};

const LaneSwatch: React.FC<{ form: LaneForm }> = ({ form }) => (
  <span aria-hidden="true" className={`w-3 h-2 shrink-0 rounded-xs border ${SWATCH[form].className}`} style={SWATCH[form].style} />
);

/* ── a legend, a minus key, the value, a plus key ─────────────────────────── */

interface StepperProps {
  id: string;
  legend?: string;
  title: string;
  value: string;
  downLabel: string;
  upLabel: string;
  /** `byBar` is true on a Shift-click. */
  onStep: (dir: -1 | 1, byBar: boolean) => void;
  downDisabled?: boolean;
  upDisabled?: boolean;
  valueClass?: string;
}

const Stepper: React.FC<StepperProps> = ({ id, legend, title, value, downLabel, upLabel, onStep, downDisabled, upDisabled, valueClass = 'min-w-4' }) => (
  <div className={FIELD} title={title}>
    {legend && <span className={FIELD_LEGEND}>{legend}</span>}
    <button
      type="button"
      className={`${MINI_ICON_KEY} ${KEY_REST}`}
      aria-label={downLabel}
      aria-describedby={`${id}-value`}
      disabled={downDisabled}
      onClick={(e) => onStep(-1, e.shiftKey)}
    >
      <Minus aria-hidden="true" className="w-3 h-3" />
    </button>
    <span id={`${id}-value`} aria-live="polite" className={`${FIELD_VALUE} ${valueClass}`}>{value}</span>
    <button
      type="button"
      className={`${MINI_ICON_KEY} ${KEY_REST}`}
      aria-label={upLabel}
      aria-describedby={`${id}-value`}
      disabled={upDisabled}
      onClick={(e) => onStep(1, e.shiftKey)}
    >
      <Plus aria-hidden="true" className="w-3 h-3" />
    </button>
  </div>
);

/* ── GEN settings, kept across face flips for the session ─────────────────── */

type GateKind = GateChoice['kind'];

interface GenUi {
  kind: GenKind;
  optsByKind: Record<GenKind, GenOpts>;
  /** A steps value the user set, and the pass length it was set for; a new pass length follows it again. */
  steps: { value: number; forLen: number } | null;
  gate: GateKind;
  pct: number;
  period: number;
  laps: number[];
  seed: number;
}

const freshGenUi = (): GenUi => ({
  kind: 'euclid',
  optsByKind: Object.fromEntries(GEN_KINDS.map((k) => [k, { ...GEN_DEFAULT_OPTS[k] }])) as Record<GenKind, GenOpts>,
  steps: null,
  gate: 'open',
  pct: 70,
  period: 2,
  laps: [1],
  seed: 4821,
});

let genMemory: GenUi | null = null;

const GATE_KEYS: Array<{ kind: GateKind; legend: string; title: string }> = [
  { kind: 'open', legend: 'Open', title: 'Open: every step the rule plays is written' },
  { kind: 'chance', legend: 'Chance', title: "Chance: each step plays when LOOM's seeded die lands under the percent" },
  { kind: 'lap', legend: 'Lap', title: 'Lap: only the chosen passes of every period play' },
];

const UNIT_TITLES: Record<number, string> = { 4: 'Quarter-note beats', 8: 'Eighth-note beats', 16: 'Sixteenth-note beats' };

const barsText = (first: number, last: number): string => (first === last ? `${first + 1}` : `${first + 1}-${last + 1}`);

export const MeterFace: React.FC<{ songEntryId?: string }> = ({ songEntryId }) => {
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);
  const totalSteps = usePianoRollStore((s) => s.totalSteps);
  const lanes = usePianoRollStore((s) => s.lanes);
  const activeLane = usePianoRollStore((s) => s.activeLane);
  const sync = useVirtuosoStore((s) => s.amounts.sync);
  const accent = useVirtuosoStore((s) => s.amounts.accent);
  const setAmount = useVirtuosoStore((s) => s.setAmount);
  const keyV = useVirtuosoStore((s) => s.key);
  const modeV = useVirtuosoStore((s) => s.mode);
  const matchBusy = useMatchBusy((s) => s.busy);

  const segs = React.useMemo(() => normalizeMeterMap(meterMap, false), [meterMap]);
  // The selection opens on the segment under the playhead and is clamped on
  // every render, so removed segments never leave it pointing past the end.
  const [sel, setSel] = React.useState(() => {
    const r = usePianoRollStore.getState();
    return segmentAtStep(r.meterMap, r.currentStep, r.pickupSteps);
  });
  const selected = clampSelection(segs, sel);
  const seg = segs[selected];
  const meter = seg.meter;
  const lane = lanes.find((l) => l.id === activeLane) ?? lanes[0];
  const forms = React.useMemo(() => laneForms(lanes, activeLane), [lanes, activeLane]);

  const writeMap = (edit: MeterEdit): void => {
    usePianoRollStore.setState({ meterMap: edit.meterMap });
    setSel(edit.selected);
  };

  const onAdd = (): void => {
    const r = usePianoRollStore.getState();
    writeMap(addChange(r.meterMap, selected, r.currentStep, r.pickupSteps));
  };
  const onRemove = (): void => {
    const edit = removeChange(usePianoRollStore.getState().meterMap, selected);
    if (edit) writeMap(edit);
  };

  const onAddLane = (): void => {
    const r = usePianoRollStore.getState();
    r.setActiveLane(r.addLane(newLaneCycle(r.meterMap)));
  };
  const onRemoveLane = (): void => {
    const r = usePianoRollStore.getState();
    if (r.activeLane !== 0) r.removeLane(r.activeLane);
  };
  const onLoop = (dir: -1 | 1, byBar: boolean): void => {
    const r = usePianoRollStore.getState();
    const l = r.lanes.find((x) => x.id === r.activeLane);
    if (!l || l.id === 0) return;
    r.setLaneCycle(l.id, stepLoop(l.cycleSteps, dir, byBar, stepsPerBar(meter), r.totalSteps));
  };

  /* GEN */
  const genKeyRef = React.useRef<HTMLButtonElement>(null);
  const [genOpen, setGenOpen] = React.useState(false);
  const [gen, setGenState] = React.useState<GenUi>(() => genMemory ?? freshGenUi());
  const setGen = (patch: Partial<GenUi>): void =>
    setGenState((prev) => {
      const next = { ...prev, ...patch };
      genMemory = next;
      return next;
    });

  const target = genTarget({ meterMap: segs, pickupSteps, lanes, activeLane, totalSteps }, selected);
  const autoSteps = Math.max(1, Math.round(target.passLen));
  const ruleSteps = gen.steps && gen.steps.forLen === target.passLen ? gen.steps.value : autoSteps;
  const gate: GateChoice =
    gen.gate === 'chance' ? { kind: 'chance', pct: gen.pct } : gen.gate === 'lap' ? { kind: 'lap', period: gen.period, laps: gen.laps } : { kind: 'open' };
  const opts = gen.optsByKind[gen.kind];
  const settings: GenSettings = { kind: gen.kind, opts, steps: ruleSteps, gate, seed: gen.seed };
  const pitches = React.useMemo(() => lanePitches(keyV, modeV), [keyV, modeV]);
  const preview = genOpen ? genPreview(settings, pitches, target.lane) : [];
  const previewHits = preview.filter(Boolean).length;
  const targetRange = target.bars ? barsText(target.bars.first, target.bars.last) : String(target.cycle);
  const targetTitle = target.bars
    ? `Writes bars ${barsText(target.bars.first, target.bars.last)} of lane ${target.name}, one rule pass per bar`
    : `Writes one ${target.cycle}-step cycle of lane ${target.name}, which repeats with the lane`;

  const setOpt = (key: string, value: number): void => {
    if (key === 'steps') setGen({ steps: { value, forLen: target.passLen } });
    else setGen({ optsByKind: { ...gen.optsByKind, [gen.kind]: { ...opts, [key]: value } } });
  };

  const onWrite = (): void => {
    const r = usePianoRollStore.getState();
    const res = genWrite(r, selected, settings, pitches, `gen-${Date.now().toString(36)}`);
    r.replaceAll(res.notes);
    post(genStatus(res.written, res.target.name), res.written ? 'info' : 'warn');
  };

  /* MATCH */
  const onMatch = async (): Promise<void> => {
    if (!songEntryId || useMatchBusy.getState().busy) return;
    useMatchBusy.setState({ busy: true });
    useStatusBarStore.getState().setText("MATCH IS READING THE SONG'S RHYTHM.");
    try {
      const analysis = await fetchRhythm(songEntryId, { run: true });
      const r = usePianoRollStore.getState();
      const res = matchApply(r, analysis);
      if (res.apply) {
        r.setMeterMap(res.apply.meterMap);
        r.setPickupSteps(res.apply.pickupSteps);
        if (res.apply.bpm != null) r.setBpm(res.apply.bpm);
        if (res.apply.lanes) r.setLanes(res.apply.lanes);
        const after = usePianoRollStore.getState();
        setSel(segmentAtStep(after.meterMap, after.currentStep, after.pickupSteps));
      }
      post(res.status, res.level);
    } catch (err) {
      post(matchError(err), 'error');
    } finally {
      useMatchBusy.setState({ busy: false });
    }
  };

  const groups = groupChoices(meter);
  const loopValue = lane.id === 0 || lane.cycleSteps == null ? 'All' : String(lane.cycleSteps);
  const barLen = Math.round(stepsPerBar(meter));

  return (
    <>
      <div className={FIELD} title="Bars of the selected meter change">
        <button
          type="button"
          className={`${MINI_ICON_KEY} ${KEY_REST}`}
          aria-label="Previous meter change"
          aria-describedby="mf-bars-value"
          title="Previous meter change"
          disabled={selected === 0}
          onClick={() => setSel(selected - 1)}
        >
          <ChevronLeft aria-hidden="true" className="w-3 h-3" />
        </button>
        <span className={FIELD_LEGEND}>Bars</span>
        <span id="mf-bars-value" aria-live="polite" className={`${FIELD_VALUE} min-w-6`}>
          {segmentLabel(segs, selected, totalSteps, pickupSteps)}
        </span>
        <button
          type="button"
          className={`${MINI_ICON_KEY} ${KEY_REST}`}
          aria-label="Next meter change"
          aria-describedby="mf-bars-value"
          title="Next meter change"
          disabled={selected >= segs.length - 1}
          onClick={() => setSel(selected + 1)}
        >
          <ChevronRight aria-hidden="true" className="w-3 h-3" />
        </button>
      </div>

      <Stepper
        id="mf-beats"
        legend="Beats"
        title="Beats in a bar of the selected change (1-32). A new count clears the groups."
        value={String(meter.num)}
        downLabel="Fewer beats"
        upLabel="More beats"
        downDisabled={meter.num <= BEATS_MIN}
        upDisabled={meter.num >= BEATS_MAX}
        onStep={(dir) => writeMap(setBeats(segs, selected, meter.num + dir))}
      />

      <div role="group" aria-label="Unit" className="shrink-0 inline-flex gap-px">
        {UNITS.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={meter.den === d}
            title={`Unit: ${UNIT_TITLES[d]}`}
            className={`${STRIP_KEY} ${keyTone({ on: meter.den === d })}`}
            onClick={() => writeMap(setUnit(segs, selected, d))}
          >
            <span>/{d}</span>
          </button>
        ))}
      </div>

      <div className={FIELD} title="Groups: how the beats of a bar gather under accents">
        <label htmlFor="mf-groups" className={FIELD_LEGEND}>Groups</label>
        <select
          id="mf-groups"
          name="mf-groups"
          value={groupsValue(meter.groups)}
          onChange={(e) => writeMap(setGroups(segs, selected, parseGroupsValue(e.target.value)))}
          className="h-4.5 max-w-20 bg-transparent border-none outline-none text-[10px] font-mono et-ink cursor-pointer"
        >
          {groups.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
      </div>

      <StripKey
        onClick={onAdd}
        aria-label="Add a meter change at the playhead"
        title={`Start a change at the playhead's bar with ${meterLabel(meter)}, then edit it.`}
        icon={<Plus className="w-3 h-3" />}
        legend="Add"
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={seg.bar === 0}
        aria-label={`Remove the meter change at bar ${seg.bar + 1}`}
        title={seg.bar === 0 ? 'Bar 1 always keeps a meter' : `Remove the meter change at bar ${seg.bar + 1}`}
        className={`${STRIP_ICON_KEY} ${KEY_REST}`}
      >
        <Trash2 aria-hidden="true" className="w-3 h-3" />
      </button>

      <Sep />

      <div role="group" aria-label="Lanes" className="shrink-0 inline-flex gap-px">
        {lanes.map((l) => (
          <button
            key={l.id}
            type="button"
            aria-pressed={l.id === activeLane}
            aria-label={`Lane ${l.name}`}
            title={`Lane ${l.name}: ${l.cycleSteps ? `loops every ${l.cycleSteps} steps` : 'runs the whole roll'}. New notes go into the pressed lane.`}
            className={`${STRIP_KEY} ${keyTone({ on: l.id === activeLane })}`}
            onClick={() => usePianoRollStore.getState().setActiveLane(l.id)}
          >
            <LaneSwatch form={forms.get(l.id) ?? 'solid'} />
            <span className="max-w-12 truncate">{l.name}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onAddLane}
        aria-label="Add a lane"
        title={`Add a lane that loops one bar of ${meterLabel(segs[0].meter)}, and draw into it`}
        className={`${STRIP_ICON_KEY} ${KEY_REST}`}
      >
        <Plus aria-hidden="true" className="w-3 h-3" />
      </button>
      <button
        type="button"
        onClick={onRemoveLane}
        disabled={activeLane === 0}
        aria-label={`Remove lane ${lane.name}`}
        title={activeLane === 0 ? 'Lane A always stays' : `Remove lane ${lane.name}; its notes move to lane A`}
        className={`${STRIP_ICON_KEY} ${KEY_REST}`}
      >
        <Trash2 aria-hidden="true" className="w-3 h-3" />
      </button>

      <Stepper
        id="mf-loop"
        legend="Loop"
        title={lane.id === 0 ? 'Lane A runs the whole roll' : `Lane ${lane.name} loops every ${loopValue === 'All' ? 'roll' : `${loopValue} steps`}. Shift-click steps a bar of ${barLen}.`}
        value={loopValue}
        valueClass="min-w-5"
        downLabel={`Shorter loop for lane ${lane.name}`}
        upLabel={`Longer loop for lane ${lane.name}`}
        downDisabled={lane.id === 0 || lane.cycleSteps === 1}
        upDisabled={lane.id === 0 || lane.cycleSteps == null}
        onStep={onLoop}
      />

      <Sep />

      {([
        { k: 'sync', legend: 'Sync', label: 'Syncopation', value: sync, title: 'Syncopation amount: moves strong-beat notes onto the anticipations' },
        { k: 'accent', legend: 'Accent', label: 'Accent', value: accent, title: 'Accent amount: lifts the notes that start a group' },
      ] as const).map(({ k, legend, label, value, title }) => (
        <div key={k} className={FIELD} title={title}>
          <label htmlFor={`mf-${k}`} className={FIELD_LEGEND}>{legend}</label>
          <input
            id={`mf-${k}`}
            name={`mf-${k}`}
            type="range"
            min={0}
            max={100}
            value={Math.round(value * 100)}
            onChange={(e) => setAmount(k, (parseInt(e.target.value, 10) || 0) / 100)}
            aria-label={`${label} amount`}
            className={RANGE}
          />
          <span className={`${FIELD_VALUE} w-5`}>{Math.round(value * 100)}</span>
        </div>
      ))}

      <span className="flex-1 min-w-1" />

      <StripKey
        ref={genKeyRef}
        onClick={() => setGenOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={genOpen}
        aria-controls="mf-gen"
        title="Generate: write notes into the active lane with one of LOOM's rules"
        on={genOpen}
        icon={<Blocks className="w-3 h-3" />}
        legend="Gen"
      />
      <StripKey
        onClick={() => void onMatch()}
        disabled={!songEntryId}
        aria-busy={matchBusy}
        aria-label="Match the meter to the song"
        title={
          songEntryId
            ? "Match: take the meter map, pickup, tempo and lanes from the song's rhythm analysis (analyzing it first when needed)"
            : "Pick a song in the strip's song field to match its meter"
        }
        icon={<AudioWaveform className={`w-3 h-3 ${matchBusy ? 'animate-pulse' : ''}`} />}
        legend="Match"
      />

      <DockFlyout
        open={genOpen}
        anchorRef={genKeyRef}
        onClose={() => setGenOpen(false)}
        placement="above"
        align="end"
        id="mf-gen"
        role="dialog"
        aria-label="Gen: write notes with a LOOM rule"
        className={`w-120 max-w-[92vw] ${FLYOUT_CARD}`}
      >
        <div className="flex flex-col gap-1.5 p-2">
          <div className="flex items-center gap-2 pb-1.5 border-b border-white/8">
            <span className="text-[9px] font-black uppercase tracking-[0.18em] et-ink">Gen</span>
            <span className="inline-flex items-center gap-1 text-[10px] font-mono et-ink-2" title={targetTitle}>
              <LaneSwatch form={forms.get(target.lane) ?? 'solid'} />
              <span>{target.name}</span>
              <span className="et-ink-3">{targetRange}</span>
            </span>
          </div>

          <div className="flex items-start gap-1">
            <span id="mf-gen-rule-legend" className={`${FIELD_LEGEND} w-10 shrink-0 pt-1`}>Rule</span>
            <div role="group" aria-labelledby="mf-gen-rule-legend" className="flex flex-wrap gap-px">
              {GEN_RULES.map((r) => (
                <button
                  key={r.kind}
                  type="button"
                  aria-pressed={gen.kind === r.kind}
                  title={`${r.legend}: ${r.title}`}
                  className={`${MINI_KEY} ${keyTone({ on: gen.kind === r.kind })}`}
                  onClick={() => setGen({ kind: r.kind })}
                >
                  <span>{r.legend}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1 flex-wrap pl-11">
            {genOptionSpecs(gen.kind).map((spec) => {
              const value = spec.key === 'steps' ? ruleSteps : Number(opts[spec.key] ?? 0);
              return (
                <Stepper
                  key={spec.key}
                  id={`mf-gen-${spec.key}`}
                  legend={spec.legend}
                  title={spec.title}
                  value={formatOption(value, spec)}
                  downLabel={`Less ${spec.legend.toLowerCase()}`}
                  upLabel={`More ${spec.legend.toLowerCase()}`}
                  downDisabled={value <= spec.min}
                  upDisabled={value >= spec.max}
                  onStep={(dir) => setOpt(spec.key, stepOption(value, spec, dir))}
                />
              );
            })}
          </div>

          <div className="flex items-center gap-1 flex-wrap">
            <span id="mf-gen-gate-legend" className={`${FIELD_LEGEND} w-10 shrink-0`}>Gate</span>
            <div role="group" aria-labelledby="mf-gen-gate-legend" className="flex gap-px">
              {GATE_KEYS.map((g) => (
                <button
                  key={g.kind}
                  type="button"
                  aria-pressed={gen.gate === g.kind}
                  title={g.title}
                  className={`${MINI_KEY} ${keyTone({ on: gen.gate === g.kind })}`}
                  onClick={() => setGen({ gate: g.kind })}
                >
                  <span>{g.legend}</span>
                </button>
              ))}
            </div>
            {gen.gate === 'chance' && (
              <Stepper
                id="mf-gen-pct"
                title="Percent of steps the die lets through"
                value={`${gen.pct}%`}
                valueClass="min-w-7"
                downLabel="Lower chance"
                upLabel="Higher chance"
                downDisabled={gen.pct <= 0}
                upDisabled={gen.pct >= 100}
                onStep={(dir) => setGen({ pct: Math.max(0, Math.min(100, gen.pct + dir * 5)) })}
              />
            )}
            {gen.gate === 'lap' && (
              <>
                <Stepper
                  id="mf-gen-period"
                  legend="Period"
                  title="Passes in one period of the lap gate"
                  value={String(gen.period)}
                  downLabel="Shorter period"
                  upLabel="Longer period"
                  downDisabled={gen.period <= 1}
                  upDisabled={gen.period >= 8}
                  onStep={(dir) => {
                    const period = Math.max(1, Math.min(8, gen.period + dir));
                    const laps = gen.laps.filter((x) => x <= period);
                    setGen({ period, laps: laps.length ? laps : [1] });
                  }}
                />
                <span id="mf-gen-laps-legend" className={FIELD_LEGEND}>Laps</span>
                <div role="group" aria-labelledby="mf-gen-laps-legend" className="flex gap-px">
                  {Array.from({ length: gen.period }, (_, i) => i + 1).map((n) => {
                    const on = gen.laps.includes(n);
                    return (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={on}
                        aria-label={`Lap ${n}`}
                        title={`Pass ${n} of every ${gen.period} ${on ? 'plays' : 'rests'}`}
                        className={`${MINI_KEY} ${keyTone({ on })}`}
                        onClick={() => setGen({ laps: on ? gen.laps.filter((x) => x !== n) : [...gen.laps, n].sort((a, b) => a - b) })}
                      >
                        <span>{n}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <div className="flex items-center gap-1">
            <span className={`${FIELD_LEGEND} w-10 shrink-0`} aria-hidden="true" />
            <div className={FIELD} title="Seed: the same seed writes the same notes">
              <label htmlFor="mf-gen-seed" className={FIELD_LEGEND}>Seed</label>
              <input
                id="mf-gen-seed"
                name="mf-gen-seed"
                type="number"
                min={0}
                max={999999}
                value={gen.seed}
                onChange={(e) => setGen({ seed: Math.max(0, Math.min(999999, parseInt(e.target.value, 10) || 0)) })}
                className="w-16 h-4 bg-transparent border-none outline-none text-[10px] font-mono et-ink tabular-nums"
              />
              <button
                type="button"
                className={`${MINI_ICON_KEY} ${KEY_REST}`}
                aria-label="New seed"
                title="Roll a new seed"
                onClick={() => setGen({ seed: Math.floor(Math.random() * 10000) })}
              >
                <Dices aria-hidden="true" className="w-3 h-3" />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <span className={`${FIELD_LEGEND} w-10 shrink-0`} aria-hidden="true">Pass</span>
            <div
              role="img"
              aria-label={`First pass: ${previewHits} of ${ruleSteps} steps play`}
              className="flex-1 min-w-0 h-4 flex items-end gap-px"
            >
              {preview.map((hit, i) => (
                <span key={i} className={`flex-1 min-w-px rounded-xs ${hit ? 'h-4 bg-[rgb(var(--et-accent))]' : 'h-2 bg-white/10'}`} />
              ))}
            </div>
            <span className={`${FIELD_VALUE} min-w-10`}>{previewHits}/{ruleSteps}</span>
          </div>

          <div className="flex items-center gap-2 pt-1.5 border-t border-white/8">
            <StripKey
              onClick={onWrite}
              on
              aria-label={`Write the rule into lane ${target.name}`}
              title={`${targetTitle}, replacing the lane's notes there`}
              icon={<Send className="w-3 h-3" />}
              legend="Write"
            />
          </div>
        </div>
      </DockFlyout>
    </>
  );
};
