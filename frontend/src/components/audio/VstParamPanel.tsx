// The in-app parameter panel of a hosted plugin: every parameter the plugin declares (its own
// names, its own words for each value), editable without the plugin's native window. It is what a
// remote page or a phone gets instead of that window, and what a plugin with no editor gets at all.
//
// Writes go through the SAME path every other effect's controls use (`onWrite` with `p<index>`
// keys, bracketed by the gesture callbacks), so a move here is undoable, automatable and reaches
// the live plugin exactly as a move on a built-in effect does.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { vstSessions } from '../../lib/vstLive/sessionRegistry';
import type { ChainEntry } from '../../state/effectChainStore';
import { useVstLiveStore } from '../../state/vstLiveStore';
import { useVstParamStore, visibleVstParams, vstParamKey, type VstParamView } from '../../state/vstParamStore';

/** Rows drawn before the user asks for the rest: a mastering suite declares hundreds. */
const INITIAL_ROWS = 60;
/** At most one display-text request per parameter per this many ms while a slider moves. */
const TEXT_REQUEST_MS = 60;

const EMPTY: VstParamView[] = [];

interface VstParamPanelProps {
  entry: ChainEntry;
  /** Prefix for the fields' id/name, unique per window. */
  idPrefix: string;
  /** Automation-aware values to SHOW (same contract as EffectControls' `display`). */
  display?: Record<string, number>;
  onWrite: (params: Record<string, number>) => void;
  onGestureStart: () => void;
  onGestureEnd: () => void;
}

/** The socket client, as far as this panel needs it. `paramText` is newer than some clients. */
interface ParamClient {
  getParams: () => void;
  paramText?: (index: number, value: number) => void;
}

export const VstParamPanel: React.FC<VstParamPanelProps> = ({ entry, idPrefix, display, onWrite, onGestureStart, onGestureEnd }) => {
  const status = useVstLiveStore((s) => s.entries[entry.id]?.status ?? 'off');
  const list = useVstParamStore((s) => s.lists[entry.id]) ?? EMPTY;
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const lastTextAt = useRef(new Map<number, number>());
  /** The newest value per parameter, and the timer that will ask for ITS text once the rate limit
   *  allows: the last move of a drag must always get its words, or the readout stays one step behind. */
  const latestValue = useRef(new Map<number, number>());
  const pendingText = useRef(new Map<number, number>());
  useEffect(() => {
    const timers = pendingText.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Ask once per live session. A respawned host answers again through the same store.
  useEffect(() => {
    if (status !== 'live') return;
    (vstSessions.get(entry.id)?.client as ParamClient | undefined)?.getParams();
  }, [entry.id, status]);

  const visible = useMemo(() => visibleVstParams(list), [list]);
  const needle = filter.trim().toLowerCase();
  const matching = useMemo(
    () => (needle ? visible.filter((p) => p.name.toLowerCase().includes(needle)) : visible),
    [needle, visible],
  );
  const rows = showAll || needle ? matching : matching.slice(0, INITIAL_ROWS);

  if (status !== 'live') {
    return (
      <p className="px-1 font-sans text-[11px] text-zinc-500">
        {status === 'starting' ? 'Starting the plugin…' : 'Parameters appear here while the plugin is running live.'}
      </p>
    );
  }
  if (visible.length === 0) {
    return <p className="px-1 font-sans text-[11px] text-zinc-500">{list.length === 0 ? 'Reading the plugin’s parameters…' : 'This plugin exposes no parameters.'}</p>;
  }

  const valueOf = (p: VstParamView): number => {
    const key = vstParamKey(p.index);
    const v = display?.[key] ?? entry.params[key] ?? p.value;
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : p.value;
  };

  const write = (p: VstParamView, value: number): void => {
    onWrite({ [vstParamKey(p.index)]: value });
    useVstParamStore.getState().setValue(entry.id, p.index, value);
    // The plugin's own words for the value under the thumb: rate-limited per parameter, with a
    // trailing request so the value the drag ENDS on is always the one that gets described.
    latestValue.current.set(p.index, value);
    const ask = (): void => {
      lastTextAt.current.set(p.index, performance.now());
      const v = latestValue.current.get(p.index);
      if (v !== undefined) (vstSessions.get(entry.id)?.client as ParamClient | undefined)?.paramText?.(p.index, v);
    };
    const sinceLast = performance.now() - (lastTextAt.current.get(p.index) ?? 0);
    if (sinceLast >= TEXT_REQUEST_MS) {
      ask();
    } else if (!pendingText.current.has(p.index)) {
      pendingText.current.set(
        p.index,
        window.setTimeout(() => {
          pendingText.current.delete(p.index);
          ask();
        }, TEXT_REQUEST_MS - sinceLast),
      );
    }
  };

  return (
    <div className="flex flex-col gap-1.5 min-h-0">
      {visible.length > 10 && (
        <div className="flex items-center gap-2">
          <label htmlFor={`${idPrefix}-filter`} className="sr-only">Filter this plugin’s parameters by name</label>
          <input
            id={`${idPrefix}-filter`}
            name={`${idPrefix}-filter`}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${visible.length} parameters`}
            className="w-full rounded border border-white/10 bg-black/30 px-2 py-1 font-sans text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-teal-500/50 focus:outline-hidden"
          />
        </div>
      )}
      <ul className="flex flex-col gap-1 overflow-y-auto min-h-0 pr-1">
        {rows.map((p) => {
          const id = `${idPrefix}-p${p.index}`;
          const value = valueOf(p);
          const shown = p.text || `${Math.round(value * 100)}%`;
          if (p.boolean) {
            return (
              <li key={p.index} className="flex items-center gap-2">
                <input
                  id={id}
                  name={id}
                  type="checkbox"
                  checked={value >= 0.5}
                  disabled={p.readOnly}
                  onChange={(e) => {
                    onGestureStart();
                    write(p, e.target.checked ? 1 : 0);
                    onGestureEnd();
                  }}
                  className="accent-teal-400"
                />
                <label htmlFor={id} className="min-w-0 flex-1 truncate font-sans text-[11px] text-zinc-300" title={p.name}>{p.name}</label>
                <output htmlFor={id} className="shrink-0 font-mono text-[10px] text-zinc-400 tabular-nums">{p.text}</output>
              </li>
            );
          }
          return (
            <li key={p.index} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_minmax(0,5rem)] items-center gap-2">
              <label htmlFor={id} className="truncate font-sans text-[11px] text-zinc-300" title={p.name}>{p.name}</label>
              <input
                id={id}
                name={id}
                type="range"
                min={0}
                max={1}
                step={p.steps > 0 ? 1 / p.steps : 0.001}
                value={value}
                disabled={p.readOnly}
                aria-valuetext={shown}
                onPointerDown={onGestureStart}
                onPointerUp={onGestureEnd}
                onPointerCancel={onGestureEnd}
                onFocus={onGestureStart}
                onBlur={onGestureEnd}
                onChange={(e) => write(p, Number(e.target.value))}
                onDoubleClick={() => {
                  if (p.readOnly) return;
                  onGestureStart();
                  write(p, p.defaultValue);
                  onGestureEnd();
                }}
                title={p.readOnly ? `${p.name} (read only)` : `${p.name} — double-click for the default`}
                className="w-full accent-teal-400 disabled:opacity-50"
              />
              <output htmlFor={id} className="truncate text-right font-mono text-[10px] text-zinc-400 tabular-nums" title={shown}>
                {shown}{p.label && !p.text ? ` ${p.label}` : ''}
              </output>
            </li>
          );
        })}
      </ul>
      {!showAll && !needle && matching.length > rows.length && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="self-start rounded border border-white/10 px-2 py-1 font-display text-[10px] font-bold uppercase tracking-wider text-zinc-400 hover:bg-white/5 hover:text-white"
        >
          Show all {matching.length}
        </button>
      )}
    </div>
  );
};
