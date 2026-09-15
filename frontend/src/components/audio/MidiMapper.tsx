/**
 * Shared MIDI mapper popup, mounted next to features that want a
 * controller-friendly interface (Piano, Sequence). Matches the same
 * pill → LEARN editor pattern the VJ sidecar uses, but is generic:
 * the caller passes a list of `MidiParamDef`s describing what's
 * mappable, plus an `onChange(key, value)` callback fired whenever
 * a mapped CC produces a fresh value. Mappings persist to
 * localStorage under `storageKey`.
 *
 * Two forms: the floating top-right `pill` (the SEQUENCE tab), and a `key`
 * for a toolbar strip (the MIDI dock's MAP key), whose panel opens below it
 * in a flyout the dock cannot clip.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Cable, Music2, Plug, X, RotateCcw, Crosshair, Zap } from 'lucide-react';
import { rowPage } from '../../lib/arpLayout';
import { listRowsFit } from '../../lib/dockTip';
import { subscribeToMidi } from '../../state/midiBus';
import { enableMidi } from '../../state/midiTriggerStore';
import { CueKey, DockFlyout, FLYOUT_CARD, STRIP_GLYPH, StripKey } from './midiDockKit';

/** The MAP card's cue line under its binding list: a 12px line and the 2px gap above it. */
const MAP_CUE_LINE_PX = 14;

export interface MidiParamDef<K extends string = string> {
  key: K;
  label: string;
  min: number;
  max: number;
  /** CC# this param auto-maps to on first run. null = no auto-map. */
  autoCc: number | null;
  /** True if the param value should be rounded to an integer (BPM,
   *  step count, etc). */
  integer?: boolean;
}

export interface MidiMapping {
  kind: 'cc' | 'note';
  /** CC# (0-127) or note number. */
  number: number;
  /** Channel 0-15 or null = any. */
  channel: number | null;
  inverted?: boolean;
}

interface MidiMapperProps<K extends string = string> {
  /** Human label shown in the panel header (e.g. "PIANO" / "SEQUENCE"). */
  title: string;
  /** Mappable parameters this surface exposes. */
  params: ReadonlyArray<MidiParamDef<K>>;
  /** Fires when a mapped CC produces a new value for one of `params`. */
  onChange: (key: K, value: number) => void;
  /** localStorage key for the mappings dictionary. Make this unique
   *  per surface so Piano and Sequence don't collide. */
  storageKey: string;
  /** Color accent — affects the pill border and active LEARN highlight.
   *  `theme` draws everything in the theme's accent (`--et-accent`). */
  accent?: 'purple' | 'cyan' | 'emerald' | 'theme';
  /** `pill` floats top-right of its positioned parent; `key` is a MAP key. */
  variant?: 'pill' | 'key';
}

function scaleCcValue(value: number, def: MidiParamDef): number {
  const clamped = Math.max(0, Math.min(127, value));
  const norm = clamped / 127;
  const scaled = def.min + norm * (def.max - def.min);
  return def.integer ? Math.round(scaled) : scaled;
}

function loadMappings<K extends string>(
  storageKey: string,
  params: ReadonlyArray<MidiParamDef<K>>,
): Record<K, MidiMapping> {
  const out: Record<string, MidiMapping> = {};
  // Seed with auto-map defaults so a fresh user sees something
  // wired up to their controller immediately.
  for (const def of params) {
    if (def.autoCc !== null) {
      out[def.key] = { kind: 'cc', number: def.autoCc, channel: null };
    }
  }
  if (typeof window === 'undefined') return out as Record<K, MidiMapping>;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, MidiMapping>;
      const keys = new Set(params.map((p) => p.key));
      for (const [k, v] of Object.entries(parsed)) {
        if (keys.has(k as K) && v && typeof v.number === 'number') out[k] = v;
      }
    }
  } catch {
    /* corrupted store; fall back to defaults */
  }
  return out as Record<K, MidiMapping>;
}

function saveMappings(storageKey: string, m: Record<string, MidiMapping>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(m));
  } catch {
    /* quota / private mode — silently skip */
  }
}

const ACCENTS = {
  purple: {
    pillBorder: 'border-purple-500/40',
    pillBg: 'bg-purple-500/10',
    pillText: 'text-purple-200',
    pillDot: 'bg-purple-400',
    icon: 'text-purple-300',
    headerText: 'text-purple-200',
    headerBorder: 'border-purple-500/20',
    panelBorder: 'border-purple-500/40',
    learn: 'border-amber-400/60 bg-amber-500/15 text-amber-200',
    learnHover: 'hover:text-purple-200 hover:border-purple-500/40',
    learningText: 'text-amber-300',
    idleText: 'text-zinc-500',
    inverted: 'border-purple-500/40 text-purple-200 bg-purple-500/15',
    invertHover: 'hover:text-purple-200',
    clearHover: 'hover:text-rose-300 hover:border-rose-500/40',
  },
  cyan: {
    pillBorder: 'border-cyan-500/40',
    pillBg: 'bg-cyan-500/10',
    pillText: 'text-cyan-200',
    pillDot: 'bg-cyan-400',
    icon: 'text-cyan-300',
    headerText: 'text-cyan-200',
    headerBorder: 'border-cyan-500/20',
    panelBorder: 'border-cyan-500/40',
    learn: 'border-amber-400/60 bg-amber-500/15 text-amber-200',
    learnHover: 'hover:text-cyan-200 hover:border-cyan-500/40',
    learningText: 'text-amber-300',
    idleText: 'text-zinc-500',
    inverted: 'border-purple-500/40 text-purple-200 bg-purple-500/15',
    invertHover: 'hover:text-purple-200',
    clearHover: 'hover:text-rose-300 hover:border-rose-500/40',
  },
  emerald: {
    pillBorder: 'border-emerald-500/40',
    pillBg: 'bg-emerald-500/10',
    pillText: 'text-emerald-200',
    pillDot: 'bg-emerald-400',
    icon: 'text-emerald-300',
    headerText: 'text-emerald-200',
    headerBorder: 'border-emerald-500/20',
    panelBorder: 'border-emerald-500/40',
    learn: 'border-amber-400/60 bg-amber-500/15 text-amber-200',
    learnHover: 'hover:text-emerald-200 hover:border-emerald-500/40',
    learningText: 'text-amber-300',
    idleText: 'text-zinc-500',
    inverted: 'border-purple-500/40 text-purple-200 bg-purple-500/15',
    invertHover: 'hover:text-purple-200',
    clearHover: 'hover:text-rose-300 hover:border-rose-500/40',
  },
  // The theme's one accent. Ink uses the et-ink utilities, which no theme
  // remap overrides, so their hover variants actually paint.
  theme: {
    pillBorder: 'border-white/10',
    pillBg: 'bg-white/10',
    pillText: 'et-ink-2',
    pillDot: 'bg-[rgb(var(--et-accent))]',
    icon: 'text-[rgb(var(--et-accent))]',
    headerText: 'et-ink',
    headerBorder: 'border-white/10',
    panelBorder: 'border-white/10',
    learn: 'border-[rgb(var(--et-accent))] bg-white/10 text-[rgb(var(--et-accent))]',
    learnHover: 'hover:et-ink hover:border-white/25',
    learningText: 'text-[rgb(var(--et-accent))]',
    idleText: 'et-ink-3',
    inverted: 'border-[rgb(var(--et-accent))] text-[rgb(var(--et-accent))] bg-white/10',
    invertHover: 'hover:et-ink',
    clearHover: 'hover:et-ink hover:border-white/25',
  },
} as const;

export function MidiMapper<K extends string = string>({
  title,
  params,
  onChange,
  storageKey,
  accent = 'purple',
  variant = 'pill',
}: MidiMapperProps<K>): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [mappings, setMappings] = useState<Record<K, MidiMapping>>(
    () => loadMappings(storageKey, params),
  );
  const [learning, setLearning] = useState<K | null>(null);
  const [lastSeenCc, setLastSeenCc] = useState<{ cc: number; value: number; channel: number } | null>(null);
  const [connected, setConnected] = useState(false);
  const keyRef = useRef<HTMLButtonElement>(null);
  const panelId = `midi-mapper-${useId().replace(/:/g, '')}`;

  // Refs so the bus subscriber callback (set up once below) always
  // sees the freshest mapping table + learn target.
  const mappingsRef = useRef(mappings);
  mappingsRef.current = mappings;
  const learningRef = useRef(learning);
  learningRef.current = learning;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    saveMappings(storageKey, mappings);
  }, [mappings, storageKey]);

  // Opening a mapper is an explicit MIDI opt-in — turn on the master
  // gate so the global listener starts and bus messages flow here. This
  // is what triggers the browser's one-time Web MIDI permission prompt,
  // now tied to a deliberate user action rather than app load.
  useEffect(() => {
    if (open) enableMidi();
  }, [open]);

  // Subscribe to the global MIDI bus. The bus publishes raw
  // [status, data1, data2] for every message; we apply our mapping
  // table and call onChange for matched params.
  useEffect(() => {
    const unsub = subscribeToMidi((msg) => {
      setConnected(true);
      const [status, data1, data2] = msg.data;
      if (typeof status !== 'number') return;
      const command = status & 0xf0;
      const channel = status & 0x0f;

      if (command === 0xb0) {
        setLastSeenCc({ cc: data1, value: data2, channel });
        const target = learningRef.current;
        if (target) {
          setMappings((prev) => ({
            ...prev,
            [target]: { kind: 'cc', number: data1, channel },
          }));
          setLearning(null);
          return;
        }
        for (const def of paramsRef.current) {
          const m = mappingsRef.current[def.key];
          if (!m || m.kind !== 'cc') continue;
          if (m.number !== data1) continue;
          if (m.channel !== null && m.channel !== channel) continue;
          const value = scaleCcValue(m.inverted ? 127 - data2 : data2, def);
          onChangeRef.current(def.key, value);
        }
      } else if (command === 0x90 || command === 0x80) {
        const kind: 'on' | 'off' = command === 0x90 && data2 > 0 ? 'on' : 'off';
        const target = learningRef.current;
        if (target && kind === 'on') {
          setMappings((prev) => ({
            ...prev,
            [target]: { kind: 'note', number: data1, channel },
          }));
          setLearning(null);
          return;
        }
        for (const def of paramsRef.current) {
          const m = mappingsRef.current[def.key];
          if (!m || m.kind !== 'note') continue;
          if (m.number !== data1) continue;
          if (m.channel !== null && m.channel !== channel) continue;
          const value = scaleCcValue(m.inverted ? 127 - data2 : data2, def);
          onChangeRef.current(def.key, value);
        }
      }
    });
    return unsub;
  }, []);

  const setMapping = useCallback((key: K, mapping: MidiMapping | null) => {
    setMappings((prev) => {
      const next = { ...prev };
      if (mapping === null) delete next[key];
      else next[key] = mapping;
      return next;
    });
  }, []);

  const resetMappings = useCallback(() => {
    try {
      if (typeof window !== 'undefined') window.localStorage.removeItem(storageKey);
    } catch {
      /* storage blocked: the defaults below still apply for this session */
    }
    setMappings(loadMappings(storageKey, paramsRef.current));
  }, [storageKey]);

  const cls = ACCENTS[accent];
  const controllerTitle = `MIDI mapper for ${title} — ${connected ? 'controller seen' : 'waiting for controller'}`;

  // The dock's MAP card is dense, and when the card is capped above the SHAPE
  // row its binding list shows whole rows only (lib/dockTip `listRowsFit`), with
  // a cue line whose up and down keys keep their places. The room is read from
  // the card's cap and the card's other parts, never from the list, so the
  // list's own height cannot feed back.
  const dense = variant === 'key';
  const lead = dense ? 'leading-4' : '';
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const [listFit, setListFit] = useState<{ rows: number; height: number | null; step: number }>({ rows: 0, height: null, step: 0 });
  const [listCues, setListCues] = useState({ up: false, down: false });

  useLayoutEffect(() => {
    const list = listEl;
    const wrap = list?.parentElement;
    const card = list?.closest<HTMLElement>('[role="dialog"]');
    if (!dense || !list || !wrap || !card) return;
    const measure = () => {
      const z = parseFloat(card.closest('[data-layout-zoom]')?.getAttribute('data-layout-zoom') ?? '') || 1;
      const rows = Array.from(list.children) as HTMLElement[];
      const heights = rows.map((r) => r.getBoundingClientRect().height / z);
      const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
      const cap = parseFloat(card.style.maxHeight);
      let next: { rows: number; height: number | null; step: number } = { rows: rows.length, height: null, step: (heights[0] ?? 0) + gap };
      if (cap > 0) {
        const border = card.offsetHeight - card.clientHeight;
        const others = Array.from(card.children)
          .filter((c) => c !== wrap)
          .reduce((sum, c) => sum + c.getBoundingClientRect().height / z, 0);
        const ws = getComputedStyle(wrap);
        const room = cap - border - others - parseFloat(ws.paddingTop) - parseFloat(ws.paddingBottom);
        const fit = listRowsFit(room, heights, gap, MAP_CUE_LINE_PX);
        next = { ...next, rows: fit.rows, height: fit.height };
      }
      setListFit((p) =>
        p.rows === next.rows && Math.abs(p.step - next.step) < 0.25 && (p.height === next.height || (p.height != null && next.height != null && Math.abs(p.height - next.height) < 0.25))
          ? p
          : next,
      );
    };
    measure();
    // DockFlyout writes the cap into the card's style; a controller line or LEARN changes the other parts.
    const mo = new MutationObserver(measure);
    mo.observe(card, { attributes: true, attributeFilter: ['style'] });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    for (const c of Array.from(card.children)) if (c !== wrap) ro?.observe(c);
    for (const r of Array.from(list.children)) ro?.observe(r);
    return () => {
      mo.disconnect();
      ro?.disconnect();
    };
  }, [dense, listEl, params.length]);

  useEffect(() => {
    const list = listEl;
    if (!list) return;
    // Rows against the list's own box, never scrollTop against scrollHeight: at a
    // layout zoom the list's height is fractional and scrollHeight whole, so the
    // last row can sit whole at the foot with a pixel of scroll range left.
    const update = () => {
      const box = list.getBoundingClientRect();
      const first = list.firstElementChild?.getBoundingClientRect();
      const last = list.lastElementChild?.getBoundingClientRect();
      const up = !!first && first.top < box.top - 1;
      const down = !!last && last.bottom > box.bottom + 1;
      setListCues((p) => (p.up === up && p.down === down ? p : { up, down }));
    };
    update();
    list.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(list);
    return () => {
      list.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [listEl, listFit.height]);

  /** A cue press pages by all but one of the rows in view, landing on a row's own top. */
  const pageList = (dir: 1 | -1) => {
    const list = listEl;
    if (!list || !listFit.step || !listFit.rows) return;
    const total = list.children.length;
    const row = rowPage(list.scrollTop, listFit.step, listFit.rows, total, dir);
    const top = row >= Math.max(0, total - listFit.rows) ? list.scrollHeight - list.clientHeight : ((list.children[row] as HTMLElement | undefined)?.offsetTop ?? 0);
    list.scrollTo({ top, behavior: 'smooth' });
  };

  const panel = (
    <>
      <div className={`flex items-center justify-between gap-2 px-3 ${dense ? 'py-1' : 'py-2'} border-b shrink-0 ${cls.headerBorder}`}>
        <div className="flex items-center gap-1.5">
          <Music2 aria-hidden="true" className={`w-3.5 h-3.5 ${cls.icon}`} />
          <span className={`text-[12px] font-display font-extrabold uppercase ${cls.headerText}`}>{title} · MIDI</span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close MIDI mapper"
          title="Close"
          className={`p-1 ${cls.idleText} hover:text-white`}
        >
          <X aria-hidden="true" className="w-3 h-3" />
        </button>
      </div>

      <div className={`px-3 ${dense ? 'py-1' : 'py-2'} border-b border-white/5 shrink-0 flex flex-col gap-1 ${lead}`}>
        <div className="flex items-center gap-1.5">
          <Plug aria-hidden="true" className={`w-3 h-3 ${connected ? cls.icon : cls.idleText}`} />
          <span className="text-zinc-400">{connected ? 'Receiving controller input' : 'Waiting for controller'}</span>
        </div>
        {lastSeenCc && (
          <div className="text-zinc-600 mt-0.5">
            last seen: CC <span className={cls.icon}>{lastSeenCc.cc}</span> = <span className={cls.icon}>{lastSeenCc.value}</span> (ch <span className={cls.icon}>{lastSeenCc.channel + 1}</span>)
          </div>
        )}
        {learning && (
          <div className={`animate-pulse mt-0.5 flex items-center gap-1 ${cls.learningText}`}>
            <Crosshair aria-hidden="true" className="w-2.5 h-2.5" /> LEARN: move a knob to bind {String(learning)}
          </div>
        )}
      </div>

      <div className={`flex-1 min-h-0 flex flex-col px-2 ${dense ? 'py-1 gap-0.5' : 'py-2'}`}>
      {/* relative: each row's offsetTop, the cue's page target, is measured from this scroller. */}
      <div
        ref={setListEl}
        data-map-list=""
        className={`relative min-h-0 overflow-y-auto flex flex-col gap-1 ${dense ? 'no-scrollbar snap-y snap-mandatory' : 'flex-1'}`}
        style={dense && listFit.height != null ? { height: listFit.height } : undefined}
      >
        {params.map((param) => {
          const m = mappings[param.key];
          const isLearning = learning === param.key;
          return (
            <div
              key={param.key}
              className={`shrink-0 flex items-center gap-2 px-2 py-1 rounded border border-white/5 bg-white/3 hover:bg-white/5 ${dense ? 'snap-start last:snap-end' : ''} ${lead}`}
            >
              <div className="flex flex-col flex-1 min-w-0">
                <span className="text-zinc-200 truncate">{param.label}</span>
                <span className="text-zinc-600 uppercase tabular-nums">
                  {m
                    ? `${m.kind === 'cc' ? 'CC' : 'NOTE'} ${m.number}${m.channel !== null ? ` · ch ${m.channel + 1}` : ''}${m.inverted ? ' · INV' : ''}`
                    : 'unmapped'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setLearning(isLearning ? null : param.key)}
                aria-label={isLearning ? `Cancel learn for ${param.label}` : `Learn a control for ${param.label}`}
                aria-pressed={isLearning}
                className={`p-1 rounded border ${isLearning ? `${cls.learn} animate-pulse` : `border-white/10 ${cls.idleText} ${cls.learnHover}`}`}
                title={isLearning ? 'Cancel learn' : 'MIDI LEARN — move a knob to bind'}
              >
                <Crosshair aria-hidden="true" className="w-3 h-3" />
              </button>
              {m && (
                <>
                  <button
                    type="button"
                    onClick={() => setMapping(param.key, { ...m, inverted: !m.inverted })}
                    aria-label={`Invert range for ${param.label}`}
                    aria-pressed={!!m.inverted}
                    className={`p-1 rounded border ${m.inverted ? cls.inverted : `border-white/10 ${cls.idleText} ${cls.invertHover}`}`}
                    title="Invert range"
                  >
                    <Zap aria-hidden="true" className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setMapping(param.key, null)}
                    aria-label={`Clear mapping for ${param.label}`}
                    className={`p-1 rounded border border-white/10 ${cls.idleText} ${cls.clearHover}`}
                    title="Clear mapping"
                  >
                    <X aria-hidden="true" className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      {dense && listFit.height != null && (
        <div className="h-3 shrink-0 flex items-center justify-center gap-1">
          <CueKey dir={-1} name="Scroll up to more mappings" word="More mappings" onGo={() => pageList(-1)} idle={!listCues.up} />
          <CueKey dir={1} name="Scroll down to more mappings" word="More mappings" onGo={() => pageList(1)} idle={!listCues.down} />
        </div>
      )}
      </div>

      <div className={`flex flex-wrap items-center justify-between gap-x-2 px-3 border-t border-white/5 shrink-0 ${dense ? 'gap-y-0.5 py-1' : 'gap-y-1 py-2'}`}>
        <button
          type="button"
          onClick={resetMappings}
          className="flex items-center gap-1.5 px-2 py-1 rounded border border-white/10 text-[12px] font-display font-bold uppercase text-zinc-400 hover:text-zinc-100 hover:bg-white/5"
          title="Restore auto-map defaults"
        >
          <RotateCcw aria-hidden="true" className="w-3 h-3" /> Defaults
        </button>
        <span className={`text-zinc-700 whitespace-nowrap ${lead}`}>global MIDI bus · audio runs in parallel</span>
      </div>
    </>
  );

  if (variant === 'key') {
    return (
      <>
        <StripKey
          ref={keyRef}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`Map MIDI controls for ${title.toLowerCase()}`}
          description={controllerTitle}
          on={open}
          icon={
            <>
              <span
                className={`self-center w-1 h-1 mr-0.5 rounded-full ${connected ? 'bg-[rgb(var(--et-accent))] animate-pulse' : 'bg-white/20'}`}
              />
              <Cable className={STRIP_GLYPH} />
            </>
          }
          legend="Map"
        />
        <DockFlyout
          open={open}
          anchorRef={keyRef}
          onClose={() => setOpen(false)}
          placement="below"
          align="end"
          closeOnOutside={false}
          // The card stays open while the user works in the dock (LEARN waits on a knob),
          // so it keeps above the SHAPE row and left of the Voice column and the artifact rail.
          floorSelector="[data-dock-floor]"
          asideSelector="[data-dock-aside]"
          id={panelId}
          role="dialog"
          aria-label={`${title} MIDI mapper`}
          className={`w-72 max-h-[70vh] flex flex-col text-[12px] font-semibold text-zinc-200 ${FLYOUT_CARD}`}
        >
          {panel}
        </DockFlyout>
      </>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`absolute top-1.5 right-1.5 z-30 flex items-center gap-1.5 px-2 py-0.5 rounded border text-[9px] font-display font-bold uppercase ${cls.pillBorder} ${cls.pillBg} ${cls.pillText}`}
        title={controllerTitle}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${connected ? `${cls.pillDot} animate-pulse` : 'bg-zinc-700'}`} />
        <Music2 aria-hidden="true" className="w-3 h-3" />
        <span>MIDI</span>
      </button>
    );
  }

  return (
    <div className={`absolute top-1.5 right-1.5 z-40 w-72 max-h-[70vh] flex flex-col bg-black/90 backdrop-blur-md border rounded text-[12px] font-semibold text-zinc-200 shadow-[0_8px_24px_rgba(0,0,0,0.6)] ${cls.panelBorder}`}>
      {panel}
    </div>
  );
}
