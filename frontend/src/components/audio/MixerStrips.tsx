/**
 * MixerStrips — the mixer drawer: one strip per track, one per bus, plus the
 * master.
 *
 * Batch 6 gave the document a real routing graph (`editorStore.routing`,
 * `editorStore.buses`) and wired the LIVE mixer to it, but nothing in the UI
 * called any of it: there was no way to make a bus, point a track at one, or
 * ride a send. This drawer is that surface. It deliberately does NOT touch the
 * EDIT timeline's track-header column — the header stays the lane's controls
 * (name, arm, mute, solo, FX, fader, pan) and the drawer is where SIGNAL FLOW
 * lives, which is also the only place a bus can have a strip at all.
 *
 * Ownership rules this file obeys:
 *  - No document state is mirrored into React state. Every strip reads the
 *    store and writes through the store's actions; the only local state is the
 *    drawer's own open/height and a two-click delete arm, neither of which is
 *    part of the document.
 *  - Master volume has ONE owner, `playbackStore` (the footer's fader and the
 *    engine's master gain both already read it). The master strip binds that
 *    same pair — it does not introduce a second master level.
 *  - Feedback is refused at the MODEL boundary (`routingGraph.wouldCycle`), so
 *    an option that would close a loop is disabled here rather than offered and
 *    then rejected. A refusal that still gets through — the store is the only
 *    authority — is surfaced as a notice rather than swallowed.
 *
 * Ardour's mixer strip (`gtk2_ardour/mixer_strip.cc`, GPL-2.0-or-later) is
 * cited only for the CONVENTIONAL control order — name, output, sends, fader,
 * mute/solo — that every DAW user already has muscle memory for. It was not
 * read and not copied while writing this file; no code, snippet or comment from
 * it or from any other reference DAW is present here.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Volume2, VolumeX, X } from 'lucide-react';
import {
  beginUndoStep,
  useEditorStore,
  type EditorBus,
} from '../../state/editorStore';
import {
  CONN_OUTPUT,
  MASTER_ID,
  outputOf,
  sendsFrom,
  wouldCycle,
  type RoutingGraph,
  type RoutingRefusal,
} from '../../state/routingGraph';
import { usePlaybackStore } from '../../state/playbackStore';
import { requireFeature } from '../../notices/featureGateStore';
import { SlideTrack } from './SlideTrack';

/* ────────────────────────────────────────────────────────────────────────────
   Model helpers — pure, exported for MixerStrips.test.ts. Nothing below this
   block may derive a list in JSX; the two things that silently rot (an offered
   option that would feed back, a send row that disagrees with the graph) are
   computed here and tested without React.
   ──────────────────────────────────────────────────────────────────────────── */

/** One entry of an output / send-target `<select>`. */
export interface RoutePickOption {
  id: string;
  label: string;
  /** True when choosing it would be refused; `title` says why. */
  disabled: boolean;
  title?: string;
}

/** One send leaving a node, as the drawer renders it. */
export interface SendRow {
  /** Destination node id — the row's identity, since one send exists per pair. */
  to: string;
  label: string;
  gain: number;
}

/** A node's display name: its bus strip's if it has one, else the graph node's. */
function nodeLabel(graph: RoutingGraph, buses: readonly EditorBus[], id: string): string {
  if (id === MASTER_ID) return 'Master';
  const strip = buses.find((b) => b.id === id);
  if (strip) return strip.name;
  return graph.nodes.find((n) => n.id === id)?.name ?? id;
}

/**
 * The output picker's entries for `fromId`: the master, then every bus except
 * `fromId` itself.
 *
 * The cycle probe runs on the graph with `fromId`'s EXISTING output edge
 * removed, because that is exactly what `routingGraph.setOutput` does before it
 * checks — without it a node's own current output would report as a loop and
 * the user would find the option they are already using greyed out.
 *
 * A current output pointing at a node with NO bus strip (a drifted or
 * hand-edited project file — `validateGraph` reports it, but the mixer still
 * has to draw) is appended as a disabled "(missing bus)" entry, so the
 * `<select>` always owns the value it is parked on instead of rendering blank.
 */
export function outputOptions(
  graph: RoutingGraph,
  buses: readonly EditorBus[],
  fromId: string,
): RoutePickOption[] {
  const probe: RoutingGraph = {
    nodes: graph.nodes,
    edges: graph.edges.filter((e) => !(e.from === fromId && e.connType === CONN_OUTPUT)),
  };
  const fromName = nodeLabel(graph, buses, fromId);
  const entry = (id: string): RoutePickOption => {
    const label = nodeLabel(graph, buses, id);
    if (!wouldCycle(probe, fromId, id)) return { id, label, disabled: false };
    return {
      id,
      label,
      disabled: true,
      title: `${label} already feeds ${fromName}, so this would loop back on itself`,
    };
  };
  const options = [entry(MASTER_ID), ...buses.filter((b) => b.id !== fromId).map((b) => entry(b.id))];
  const current = outputOf(graph, fromId);
  if (current !== null && !options.some((o) => o.id === current)) {
    options.push({
      id: current,
      label: `${nodeLabel(graph, buses, current)} (missing bus)`,
      disabled: true,
      title: 'This output points at a bus that has no strip — pick another destination',
    });
  }
  return options;
}

/** Every send leaving `fromId`, in graph order, labelled and carrying its gain. */
export function sendRowsFor(
  graph: RoutingGraph,
  buses: readonly EditorBus[],
  fromId: string,
): SendRow[] {
  return sendsFrom(graph, fromId).map((e) => ({
    to: e.to,
    label: nodeLabel(graph, buses, e.to),
    gain: e.gain,
  }));
}

/**
 * Candidate destinations for a NEW send from `fromId`.
 *
 * There is deliberately no retarget: an existing send's destination is fixed,
 * because moving it would be `removeSend` + `addSend` — two undo steps passing
 * through a state the user never asked for, and the store has no transaction to
 * fuse them. Removing the send and adding another is one honest step each.
 */
export function sendTargetOptions(
  graph: RoutingGraph,
  buses: readonly EditorBus[],
  fromId: string,
): RoutePickOption[] {
  const taken = new Set(sendsFrom(graph, fromId).map((e) => e.to));
  const fromName = nodeLabel(graph, buses, fromId);
  return buses
    .filter((b) => b.id !== fromId)
    .map((b) => {
      if (taken.has(b.id)) {
        return { id: b.id, label: b.name, disabled: true, title: `${fromName} already sends to ${b.name}` };
      }
      if (wouldCycle(graph, fromId, b.id)) {
        return {
          id: b.id,
          label: b.name,
          disabled: true,
          title: `${b.name} already feeds ${fromName}, so this would loop back on itself`,
        };
      }
      return { id: b.id, label: b.name, disabled: false };
    });
}

/** The name the store itself would pick for the next bus. */
export function nextBusName(buses: readonly EditorBus[]): string {
  return `Bus ${buses.length + 1}`;
}

/** A sentence for every refusal the routing actions can return. */
export function refusalMessage(reason: RoutingRefusal): string {
  switch (reason) {
    case 'cycle':
      return 'That connection would feed the signal back into itself, which silences the whole path.';
    case 'missing-node':
      return 'One end of that connection no longer exists — reopen the mixer and try again.';
    case 'master-output':
      return 'The master is the end of the chain; it cannot be routed anywhere else.';
    case 'duplicate':
      return 'That connection is already there.';
    case 'missing-entry':
      return 'That connection needs an effect to key, and none was named.';
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   The drawer
   ──────────────────────────────────────────────────────────────────────────── */

const STRIP =
  'shrink-0 w-44 rounded-lg border border-white/10 bg-black/30 p-2 flex flex-col gap-2';
const SELECT =
  'w-full rounded-md bg-white/5 border border-white/10 px-1 py-0.5 text-xs text-zinc-300 hover:text-white focus:outline-hidden focus:ring-1 focus:ring-[rgb(var(--et-accent))]';
const MINI_BTN =
  'w-4 h-4 rounded font-display text-xs font-bold leading-none flex items-center justify-center border';
const OFF_BTN = 'bg-black/40 text-zinc-500 border-white/5 hover:text-white';

/** Surface a refusal on the app's notice stack. */
function toastRefusal(what: string, reason: RoutingRefusal): void {
  requireFeature({
    id: 'routing:refused',
    kind: 'error',
    title: `${what} was refused`,
    message: refusalMessage(reason),
    autoDismissMs: 6000,
  });
}

/** Volume fader + mute, shared by the track, bus and master strips. */
const LevelRow: React.FC<{
  name: string;
  volume: number;
  max: number;
  step: number;
  defaultValue: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onMute: () => void;
}> = ({ name, volume, max, step, defaultValue, muted, onVolume, onMute }) => (
  <div className="flex items-center gap-1.5">
    <button
      type="button"
      onClick={onMute}
      aria-label={`Mute ${name}`}
      aria-pressed={muted}
      title={muted ? 'Unmute' : 'Mute'}
      className={`${MINI_BTN} ${muted ? 'bg-red-500/20 text-red-400 border-red-500/50' : OFF_BTN}`}
    >
      {muted ? <VolumeX className="w-2.5 h-2.5" /> : <Volume2 className="w-2.5 h-2.5" />}
    </button>
    <SlideTrack
      min={0}
      max={max}
      step={step}
      defaultValue={defaultValue}
      value={volume}
      onChange={onVolume}
      className="flex-1"
      ariaLabel={`${name} volume`}
    />
  </div>
);

/** The output `<select>` — a native control, so a real id/name + `<label htmlFor>`. */
const OutputPicker: React.FC<{
  nodeId: string;
  name: string;
  options: RoutePickOption[];
  value: string;
  onPick: (toId: string) => void;
}> = ({ nodeId, name, options, value, onPick }) => (
  <div>
    <label htmlFor={`mixer-out-${nodeId}`} className="sr-only">{`${name} output`}</label>
    <select
      id={`mixer-out-${nodeId}`}
      name={`mixerOut-${nodeId}`}
      value={value}
      onChange={(e) => onPick(e.target.value)}
      title={`Where ${name} sends its main output`}
      className={SELECT}
    >
      {options.map((o) => (
        <option key={o.id} value={o.id} disabled={o.disabled} title={o.title}>
          {o.disabled ? `${o.label} (loops)` : o.label}
        </option>
      ))}
    </select>
  </div>
);

/** The send list for one node: a destination picker + a gain fader per send. */
const SendList: React.FC<{
  graph: RoutingGraph;
  buses: readonly EditorBus[];
  nodeId: string;
  name: string;
}> = ({ graph, buses, nodeId, name }) => {
  const addSend = useEditorStore((s) => s.addSend);
  const setSendGain = useEditorStore((s) => s.setSendGain);
  const removeSend = useEditorStore((s) => s.removeSend);
  // True between a fader's gesture start and end, so every change inside the
  // ride folds into the one undo step the gesture start cut.
  const ridingRef = useRef(false);

  const rows = useMemo(() => sendRowsFor(graph, buses, nodeId), [graph, buses, nodeId]);
  const fresh = useMemo(() => sendTargetOptions(graph, buses, nodeId), [graph, buses, nodeId]);
  const firstFree = fresh.find((o) => !o.disabled);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-600">sends</span>
        <button
          type="button"
          onClick={() => {
            if (!firstFree) return;
            const refusal = addSend(nodeId, firstFree.id, 0.5);
            if (refusal) toastRefusal('That send', refusal);
          }}
          disabled={!firstFree}
          aria-label={`Add a send from ${name}`}
          title={firstFree ? `Send ${name} to ${firstFree.label}` : 'No bus left to send to'}
          className={`${MINI_BTN} ${OFF_BTN} disabled:opacity-40`}
        >
          <Plus className="w-2.5 h-2.5" />
        </button>
      </div>
      {rows.map((row, i) => (
          <div key={row.to} className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <label htmlFor={`mixer-send-${nodeId}-${i}`} className="sr-only">
                {`${name} send ${i + 1} destination`}
              </label>
              {/* A send's destination is FIXED once made: moving it would be a
                  remove + an add, two undo steps through a state the user never
                  asked for. The control stays a labelled native select so the
                  row reads as "destination: <bus>", it is simply not editable —
                  remove the send and add another to change where it goes. */}
              <select
                id={`mixer-send-${nodeId}-${i}`}
                name={`mixerSend-${nodeId}-${i}`}
                value={row.to}
                disabled
                title="A send's destination is fixed — remove it and add another to change it"
                className={`${SELECT} flex-1 disabled:opacity-100`}
              >
                <option value={row.to}>{row.label}</option>
              </select>
              <button
                type="button"
                onClick={() => removeSend(nodeId, row.to)}
                aria-label={`Remove the send from ${name} to ${row.label}`}
                title="Remove this send"
                className={`${MINI_BTN} ${OFF_BTN} hover:text-red-400`}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
            <SlideTrack
              min={0}
              max={1}
              step={0.01}
              defaultValue={0.5}
              value={row.gain}
              onGestureStart={() => {
                beginUndoStep();
                ridingRef.current = true;
              }}
              onGestureEnd={() => {
                ridingRef.current = false;
              }}
              onChange={(v) => setSendGain(nodeId, row.to, v, { coalesce: ridingRef.current })}
              className="w-full"
              ariaLabel={`Send to ${row.label} level`}
            />
          </div>
      ))}
    </div>
  );
};

export const MixerStrips: React.FC = () => {
  const tracks = useEditorStore((s) => s.tracks);
  const buses = useEditorStore((s) => s.buses);
  const routing = useEditorStore((s) => s.routing);
  const updateTrack = useEditorStore((s) => s.updateTrack);
  const toggleSolo = useEditorStore((s) => s.toggleSolo);
  const updateBus = useEditorStore((s) => s.updateBus);
  const addBus = useEditorStore((s) => s.addBus);
  const removeBus = useEditorStore((s) => s.removeBus);
  const setTrackOutput = useEditorStore((s) => s.setTrackOutput);

  // Master level: playbackStore is the one owner (the footer fader and the
  // engine's master gain already read it). This strip binds that same pair.
  const masterVolume = usePlaybackStore((s) => s.volume);
  const setMasterVolume = usePlaybackStore((s) => s.setVolume);
  const masterMuted = usePlaybackStore((s) => s.muted);
  const toggleMasterMute = usePlaybackStore((s) => s.toggleMute);

  // Local UI only — never the document. `armedDelete` is the two-click confirm
  // (this app has no confirm dialog component); `focusBusId` moves focus onto
  // the strip a fresh "Add bus" just created.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [focusBusId, setFocusBusId] = useState<string | null>(null);
  const stripsRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const route = (fromId: string, toId: string) => {
    const refusal = setTrackOutput(fromId, toId);
    if (refusal) toastRefusal('That output', refusal);
  };

  // Focus the new bus's output picker once it is in the DOM. One effect on the
  // scroll container rather than an inline `ref` callback per strip: an inline
  // arrow is a new function identity every render, so React would detach and
  // re-attach every bus strip's ref on each keystroke of a fader ride.
  useEffect(() => {
    if (!focusBusId) return;
    stripsRef.current
      ?.querySelector<HTMLSelectElement>(`#mixer-out-${CSS.escape(focusBusId)}`)
      ?.focus();
    setFocusBusId(null);
  }, [focusBusId]);

  // The armed delete must not sit there forever, and the button that arms it
  // unmounts — so focus is moved onto `Confirm` (which is rendered to the RIGHT
  // of the cancel control, never under the pointer that just clicked) and the
  // arming expires on its own after 5s. `onBlur` on the strip de-arms as soon
  // as focus leaves it entirely.
  useEffect(() => {
    if (!armedDelete) return;
    confirmRef.current?.focus();
    const t = setTimeout(() => setArmedDelete(null), 5000);
    return () => clearTimeout(t);
  }, [armedDelete]);

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      {/* The §3.6 step-3 divergence note stood here while the live mixer
          followed the routing graph and the offline bounce did not. T14 gave
          `lib/renderCore` the same `wireRoutingGraph` pass, so buses and sends
          now print exactly as they play and there is nothing to warn about. */}
      <div ref={stripsRef} className="flex-1 min-h-0 flex gap-2 overflow-x-auto overflow-y-hidden pb-1">
        {tracks.map((t) => (
          <div key={t.id} className={STRIP}>
            <div className="flex items-center justify-between gap-1">
              <span className="truncate text-xs font-bold" style={{ color: t.color }} title={t.name}>
                {t.name}
              </span>
              {/* Solo only. Mute lives on `LevelRow` below, next to the fader
                  it belongs with — two mute buttons on one strip would make a
                  screen reader enumerate the same control twice. */}
              <div className="flex gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => toggleSolo(t.id)}
                  aria-label={`Solo track ${t.name}`}
                  aria-pressed={t.solo}
                  className={`${MINI_BTN} ${t.solo ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50' : OFF_BTN}`}
                >
                  S
                </button>
              </div>
            </div>
            <OutputPicker
              nodeId={t.id}
              name={t.name}
              options={outputOptions(routing, buses, t.id)}
              value={outputOf(routing, t.id) ?? MASTER_ID}
              onPick={(toId) => route(t.id, toId)}
            />
            <SendList graph={routing} buses={buses} nodeId={t.id} name={t.name} />
            <LevelRow
              name={t.name}
              volume={t.volume}
              max={1}
              step={0.01}
              defaultValue={0.8}
              muted={t.mute}
              onVolume={(v) => updateTrack(t.id, { volume: v })}
              onMute={() => updateTrack(t.id, { mute: !t.mute })}
            />
          </div>
        ))}

        {buses.map((b) => (
          <div
            key={b.id}
            // Focus leaving the strip entirely cancels an armed delete, so an
            // armed strip the user walked away from cannot be confirmed later
            // by a stray Enter.
            onBlur={(e) => {
              if (armedDelete !== b.id) return;
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setArmedDelete(null);
            }}
            className={`${STRIP} border-purple-500/25`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="truncate text-xs font-bold text-purple-200" title={b.name}>
                {b.name}
              </span>
              {armedDelete === b.id ? (
                // Cancel sits where the × was — under the pointer that just
                // clicked — and Confirm is to its RIGHT, so a fast double-click
                // cancels rather than deletes.
                <div className="flex gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => setArmedDelete(null)}
                    aria-label={`Keep bus ${b.name}`}
                    title="Keep this bus"
                    className={`${MINI_BTN} ${OFF_BTN}`}
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                  <button
                    ref={confirmRef}
                    type="button"
                    onClick={() => {
                      setArmedDelete(null);
                      removeBus(b.id);
                    }}
                    aria-label={`Confirm removing bus ${b.name}`}
                    title="Everything feeding it goes back to the master"
                    className="rounded border border-red-500/50 bg-red-500/20 px-1 text-[10px] font-bold text-red-300"
                  >
                    Confirm
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setArmedDelete(b.id)}
                  aria-label={`Remove bus ${b.name}`}
                  title="Remove this bus"
                  className={`${MINI_BTN} ${OFF_BTN} shrink-0 hover:text-red-400`}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
            {/* Announced when the strip arms — the button that was clicked has
                unmounted by then, so nothing else would say what happened. */}
            <span aria-live="polite" className="sr-only">
              {armedDelete === b.id ? `Remove ${b.name}? Confirm or cancel` : ''}
            </span>
            <OutputPicker
              nodeId={b.id}
              name={b.name}
              options={outputOptions(routing, buses, b.id)}
              value={outputOf(routing, b.id) ?? MASTER_ID}
              onPick={(toId) => route(b.id, toId)}
            />
            <LevelRow
              name={b.name}
              volume={b.volume}
              max={1}
              step={0.01}
              defaultValue={0.8}
              muted={b.mute}
              onVolume={(v) => updateBus(b.id, { volume: v })}
              onMute={() => updateBus(b.id, { mute: !b.mute })}
            />
          </div>
        ))}

        <div className={`${STRIP} border-[rgb(var(--et-accent))]/40`}>
          <span className="truncate text-xs font-bold text-zinc-200">Master</span>
          <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-600">end of chain</p>
          <LevelRow
            name="Master"
            volume={masterVolume}
            max={100}
            step={1}
            defaultValue={75}
            muted={masterMuted}
            onVolume={setMasterVolume}
            onMute={toggleMasterMute}
          />
        </div>

        <button
          type="button"
          onClick={() => setFocusBusId(addBus(nextBusName(buses)))}
          aria-label="Add bus"
          title="Add a mix bus"
          className="shrink-0 w-10 rounded-lg border border-dashed border-white/15 text-zinc-500 hover:text-white hover:border-white/30 flex items-center justify-center"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export default MixerStrips;
