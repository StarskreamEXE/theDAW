/**
 * vstEditorStore - the ONE embedded native VST3 editor session, app-wide.
 *
 * The backend sidecar hosts a single editor window, so this store owns which
 * chain entry it is open for and which center tab opened it. open() replicates
 * MIX's original handleEditVst flow: dismiss any other embed, launch the real
 * native editor, then poll for the captured raw_state and hand it to the
 * caller's sink so the dialed-in sound lands on the right chain (MIX chain,
 * EDIT track chain, or EDIT master VST chain). Leaving the tab that opened the
 * embed closes it, so the native window never keeps floating over an unrelated
 * workspace.
 *
 * EMBEDDED vs FLOATING is the user's choice (vstEditorPrefsStore), not a
 * consequence of the runtime: a floating session simply sends no parent window
 * handle, which is what makes the plugin show its own full native window
 * (preset browsers and modal dialogs included) instead of the clipped embed.
 * A plain browser has no handle to send, so it is floating whatever the
 * preference says — `mode` therefore records what the session ACTUALLY got.
 */
import { create } from 'zustand';
import { useAppUiStore, type CenterTab } from './appUiStore';
import { useStatusBarStore } from './statusBarStore';
import { useVstEditorPrefs, type VstEditorMode } from './vstEditorPrefsStore';
import { vstApi, getNativeWindowHandle, setLiveEditorRectRouter } from '../lib/vstClient';
import { setVstLiveStateSink, vstSessions, type VstLiveSession } from '../lib/vstLive/sessionRegistry';
import { useVstLiveStore } from './vstLiveStore';
import { useEditorStore } from './editorStore';
import { useEffectChainStore } from './effectChainStore';
import type { ChainEntry } from './effectChainStore';

/** A VST entry's human name. `plugin_name` is what the chain stored when the
 *  entry was added; a chain saved before the scanner learned real names (or by
 *  an importer) can carry an empty one, and the plugin's own filename is a far
 *  better answer than the bare format id 'vst3'. */
export function vstEntryName(pluginName: string | null | undefined, pluginPath: string): string {
  if (pluginName) return pluginName;
  const file = pluginPath.split(/[\\/]/).pop() ?? '';
  return file.replace(/\.vst3$/i, '') || 'VST3 plugin';
}

interface VstEditorState {
  /** Chain-entry id the editor session is open for; null = no session. */
  entryId: string | null;
  pluginPath: string | null;
  pluginName: string | null;
  /** Load failure for the current session, shown by VstEmbedHost instead of a
   *  forever "loading...". */
  error: string | null;
  /** The center tab that opened the embed; leaving it closes the session. */
  ownerTab: CenterTab | null;
  /** How the CURRENT session ACTUALLY opened (not merely what was preferred:
   *  without a parent window handle an 'embedded' request still floats).
   *  null = no session. */
  mode: VstEditorMode | null;
  /** Open (or re-open) a VST entry's native GUI. sinkRawState receives the
   *  captured base64 plugin state once the editor commits it. */
  open: (entry: ChainEntry, sinkRawState: (entryId: string, rawState: string) => void) => void;
  /** Remember `mode` for the session's plugin and relaunch the editor in it.
   *  The relaunch goes through close() + open(), so open()'s drain captures
   *  whatever the outgoing editor commits and seeds the new one with it — a
   *  mode switch never costs the user their dialed-in state. Records the
   *  preference and stops there when nothing is open, or when the session is
   *  already in that mode. */
  setMode: (mode: VstEditorMode) => void;
  close: () => void;
}

/** A launched editor session whose final raw_state has not been captured yet. */
interface SessionRecord {
  gen: number;
  entryId: string;
  pluginPath: string;
  sink: (entryId: string, rawState: string) => void;
}

// Monotonically increasing session generation. Every open() bumps it and each
// poll loop captures the value it started under; a poll whose generation is no
// longer current exits WITHOUT sinking, because the backend keys its result
// file by plugin_path only and the next open() resets that file to 'launching',
// so a stale poll could otherwise attribute one session's raw_state to another
// session's entry. close() deliberately does NOT bump the generation: the
// current session's poll loop must keep running after close so the state the
// sidecar writes when the native window closes still lands on the owning entry.
let sessionGen = 0;

// The most recently launched editor session whose result is still outstanding.
// Kept module-level (not in zustand state) because close() clears the visible
// session record while its poll loop keeps running; the NEXT open() drains this
// record before its own open-editor POST resets the path-keyed result file.
let uncaptured: SessionRecord | null = null;

// The open request behind the visible session: setMode() relaunches the SAME
// entry into the other mode, and the view that owns the toggle (VstEmbedHost)
// has neither the ChainEntry nor the sink to hand back. Module-level for the
// same reason as `uncaptured`: it outlives the state a close() clears.
let currentRequest: { entry: ChainEntry; sink: (entryId: string, rawState: string) => void } | null = null;

/** True for statuses after which the sidecar will not write the result file
 *  again ('none' means no session or file exists for the path at all). */
const isTerminalStatus = (s: string) => s === 'ok' || s === 'error' || s === 'none';

/* ── the LIVE editor ────────────────────────────────────────────────────────
   When a `vst3` entry is being hosted live, "Edit GUI" must open the editor of
   the instance that is MAKING THE SOUND, not a second copy of the plugin in the
   offline sidecar. Two plugins, two states, and the one the user dials in is
   the one they cannot hear — so the live path takes priority whenever it
   exists, and the sidecar path below is what an entry falls back to when this
   machine has no host binary.

   The session outlives the editor (and the editor outlives a chain rebuild), so
   the store owns only the bookkeeping: which entry, the state-capture timer,
   and the rect router that makes `VstEmbedHost`'s existing rect pushes land on
   the live socket. */

/** How often the plugin's state is captured while its editor is open. */
const LIVE_STATE_CAPTURE_MS = 5000;
/** Window a burst of `param` events is coalesced over before one store write. */
const PARAM_COALESCE_MS = 120;

interface LiveEditorRecord {
  entryId: string;
  pluginPath: string;
  session: VstLiveSession;
  stateTimer: number;
  paramTimer: number;
  /** Parameter index -> normalized value, pending a single store write. */
  pendingParams: Map<number, number>;
}

let liveEditor: LiveEditorRecord | null = null;

/**
 * Write parameters the user moved in the plugin's own editor back onto the
 * chain entry, so automation lanes and the project file see what the editor
 * did. Values are the protocol's normalized 0..1 and ride as `p<index>` keys,
 * the same convention `vstLiveNode.setParams` reads.
 *
 * Undo-exempt by construction: these go through the same param setters a knob
 * drag uses, which coalesce into the current step rather than opening one per
 * event — a plugin can emit these at 30 Hz per parameter, and a history entry
 * per tick would make undo useless.
 */
function sinkLiveParams(entryId: string, values: Map<number, number>): void {
  if (values.size === 0) return;
  const merge = (params: Record<string, number>): Record<string, number> => {
    const next = { ...params };
    for (const [index, value] of values) next[`p${index}`] = value;
    return next;
  };

  const mix = useEffectChainStore.getState().chain.find((e) => e.id === entryId);
  if (mix) {
    useEffectChainStore.getState().updateParams(entryId, merge(mix.params));
    return;
  }
  const ed = useEditorStore.getState();
  for (const t of ed.tracks) {
    const e = (t.fxChain ?? []).find((x) => x.id === entryId);
    if (e) {
      ed.updateTrackEffectParams(t.id, entryId, merge(e.params));
      return;
    }
  }
  const master = ed.masterFxChain.find((e) => e.id === entryId);
  if (master) {
    ed.updateMasterEffectParams(entryId, merge(master.params));
    return;
  }
  // The master VST rack used to end the search here, so a knob moved in the
  // plugin's own window while it sat on the master reached nothing at all.
  const masterVst = ed.masterVstChain.find((e) => e.id === entryId);
  if (masterVst) ed.setMasterVstParams(entryId, merge(masterVst.params));
}

/**
 * Write a plugin state captured from the LIVE host onto whichever chain entry
 * `entryId` names, stamped `state_host: 'thedaw'`.
 *
 * The origin stamp is the point. A VST3 state blob is not portable between our
 * host and the offline pedalboard renderer (measured), so a blob with no idea
 * where it came from is a blob that cannot be safely replayed anywhere. Every
 * live capture lands here — the editor's 5 s timer, the editor close, the
 * save-time pass, and the state the host writes on its way out — which is also
 * what lets the row stop saying the plugin is running at its defaults.
 *
 * It finds the entry itself, exactly as `sinkLiveParams` does, rather than
 * taking the caller's sink: the caller's sink is the OLD sidecar's, and it has
 * no way to name the host.
 *
 * `masterFxChain` is deliberately not searched: it holds rack effects, and has
 * no VST raw-state setter to write through. A plugin on the master lives in
 * `masterVstChain`.
 */
function sinkLiveRawState(entryId: string, rawState: string): void {
  if (!rawState) return;
  const flip = () => useVstLiveStore.getState().setStateOrigin(entryId, 'live');

  const mix = useEffectChainStore.getState().chain.find((e) => e.id === entryId);
  if (mix?.vst) {
    useEffectChainStore.getState().setVstRawState(entryId, rawState, 'thedaw');
    flip();
    return;
  }
  const ed = useEditorStore.getState();
  for (const t of ed.tracks) {
    const e = (t.fxChain ?? []).find((x) => x.id === entryId);
    if (e?.vst) {
      ed.setTrackVstRawState(t.id, entryId, rawState, 'thedaw');
      flip();
      return;
    }
  }
  const master = ed.masterVstChain.find((e) => e.id === entryId);
  if (master?.vst) {
    ed.setMasterVstRawState(entryId, rawState, 'thedaw');
    flip();
  }
}

// The registry rescues the state a host writes as it shuts down (the DELETE
// response) and has nowhere to put it — it is keyed by chain entry id and knows
// nothing about chains. This is the module that does, so it installs itself.
setVstLiveStateSink(sinkLiveRawState);

/** How long ONE plugin is given to answer a save-time `get_state`. */
export const LIVE_STATE_CAPTURE_TIMEOUT_MS = 750;

/** Seams for `captureLiveVstStates`; the app passes none. */
export interface CaptureLiveVstStatesDeps {
  sessions?: () => VstLiveSession[];
  /** Is this entry's session live, and does it have an editor open? */
  liveRow?: (entryId: string) => { status: string; editorOpen: boolean } | undefined;
  sink?: (entryId: string, rawState: string) => void;
  timeoutMs?: number;
}

/**
 * Ask every live plugin that is AHEAD of its stored state for a fresh one, and
 * write what comes back onto its entry.
 *
 * Called before a project save and before an autosave snapshot. Without it the
 * file records whatever was captured the last time an editor happened to be
 * open: a plugin driven from the FX row's own controls, or left running for an
 * hour with its window closed, would save at a state it left long ago and load
 * back sounding different.
 *
 * Three rules make it safe to sit in front of a save:
 *
 *  - ONLY WHAT IS STALE. A `get_state` parks the host's audio thread, so idle
 *    plugins are not asked at all: a session qualifies when its editor is open
 *    (the user is dialing it now) or a parameter has been pushed since its last
 *    capture (`stateDirty`).
 *  - BOUNDED, AND IN PARALLEL. Each plugin gets `timeoutMs` and they all run at
 *    once, so the save waits about one timeout in total however many plugins
 *    are loaded — not one per plugin. Sequential waits on a 24-plugin project
 *    would stall a save for eighteen seconds.
 *  - A TIMEOUT KEEPS THE PREVIOUS STATE. A plugin that does not answer in time
 *    leaves the entry exactly as it was and logs; it never clears a state or
 *    writes an empty one. The save then records the last known-good settings,
 *    which is strictly better than recording nothing.
 *
 * Never rejects: a save must not fail because a plugin was slow.
 */
export async function captureLiveVstStates(deps: CaptureLiveVstStatesDeps = {}): Promise<void> {
  const sessions = deps.sessions ?? (() => vstSessions.sessions());
  const liveRow = deps.liveRow ?? ((id: string) => useVstLiveStore.getState().entries[id]);
  const sink = deps.sink ?? sinkLiveRawState;
  const timeoutMs = deps.timeoutMs ?? LIVE_STATE_CAPTURE_TIMEOUT_MS;

  const stale = sessions().filter((s) => {
    const row = liveRow(s.entryId);
    if (row?.status !== 'live') return false;
    return row.editorOpen || s.stateDirty;
  });
  if (stale.length === 0) return;

  await Promise.all(
    stale.map(
      (session) =>
        new Promise<void>((resolve) => {
          // The editor's own sink is put back afterwards. Inside the window the
          // only `state` expected is the one asked for here, and routing it
          // through `sink` writes exactly what that sink would have written —
          // so swallowing it costs nothing and avoids a double store write.
          const previous = session.stateSink ?? null;
          let settled = false;
          const finish = (captured: string | null, why = `did not answer within ${timeoutMs} ms`): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            session.stateSink = previous;
            if (captured) {
              sink(session.entryId, captured);
              session.stateDirty = false;
            } else {
              console.warn(
                `[vstLive] ${session.entryId}: plugin ${why} — the previously captured state is ` +
                  'what this save records.',
              );
            }
            resolve();
          };
          const timer = setTimeout(() => finish(null), timeoutMs);
          session.stateSink = (stateB64) => finish(stateB64);
          try {
            session.client.getState();
          } catch {
            // A dead socket is a timeout that has already happened: settle now
            // rather than making the save wait out the full budget for it.
            finish(null, 'could not be reached');
          }
        }),
    ),
  );
}

/** Stop the live editor session's timers and ask the host to close its window. */
function closeLiveEditor(): void {
  const rec = liveEditor;
  if (!rec) return;
  liveEditor = null;
  setLiveEditorRectRouter(null);
  window.clearInterval(rec.stateTimer);
  if (rec.paramTimer) {
    window.clearTimeout(rec.paramTimer);
    sinkLiveParams(rec.entryId, rec.pendingParams);
  }
  // Ask for the state BEFORE closing: the host answers `state` asynchronously,
  // and `stateSink` is deliberately left attached so that answer still lands on
  // the entry after the window is gone. It is replaced, not leaked — the next
  // live editor installs its own.
  rec.session.client.getState();
  rec.session.client.closeEditor();
  useVstLiveStore.getState().setEditorOpen(rec.entryId, false);
}

/**
 * Close a previous session's native editor and wait briefly for its sidecar to
 * write the final state, sinking a captured 'ok' raw_state into the OLD entry.
 * The backend keys the editor result file by plugin_path only, so this must
 * complete BEFORE the next open-editor POST resets that file; otherwise the old
 * sidecar's late write would be attributed to the new session (and the new
 * session's own capture lost). Returns the captured raw_state so a reopen of
 * the same entry can seed the editor with it, or null when the old sidecar is
 * already gone or never commits, in which case it times out silently.
 */
async function drainSession(record: SessionRecord): Promise<string | null> {
  try {
    await vstApi.editorRect(record.pluginPath, { x: 0, y: 0, w: 0, h: 0, dpr: 1, close: true });
  } catch {
    return null; // backend unreachable; nothing left to drain
  }
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    try {
      const res = await vstApi.editorResult(record.pluginPath);
      if (isTerminalStatus(res.status)) {
        if (res.status === 'ok' && res.raw_state) {
          record.sink(record.entryId, res.raw_state);
          return res.raw_state;
        }
        return null;
      }
    } catch {
      // Transient fetch failure; keep waiting until the deadline.
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
  }
  return null;
}

type SetState = (partial: Partial<VstEditorState>) => void;
type GetState = () => VstEditorState;

/**
 * Open the editor of the plugin instance that is currently processing audio.
 *
 * EMBEDDED vs FLOATING is the user's choice (vstEditorPrefsStore, T27) exactly
 * as it is for the sidecar path, with the same override: embedded needs a
 * native window handle to reparent into, and a plain browser has none — so
 * `mode` records what the session ACTUALLY got, not what was preferred.
 *
 * `open_editor` takes PHYSICAL pixels; the rect here is only the opening size,
 * and `VstEmbedHost` immediately corrects it through `editor_rect` (routed to
 * this session by `setLiveEditorRectRouter`).
 */
async function openLiveEditor(
  entry: ChainEntry,
  session: VstLiveSession,
  set: SetState,
  get: GetState,
): Promise<void> {
  if (!entry.vst) return;
  closeLiveEditor(); // at most one editor session at a time, as before
  const path = entry.vst.plugin_path;
  const name = vstEntryName(entry.vst.plugin_name, path);
  const status = useStatusBarStore.getState();
  // Captured before the await: the user can switch tabs during it, and a
  // session must belong to the tab that started it.
  const ownerTab = useAppUiStore.getState().centerTab;
  const wantFloating = useVstEditorPrefs.getState().modeFor(path) === 'floating';
  const hwnd = wantFloating ? null : await getNativeWindowHandle();
  if (useAppUiStore.getState().centerTab !== ownerTab) return; // nothing would host it

  const dpr = window.devicePixelRatio || 1;
  const embedded = hwnd !== null;
  session.client.openEditor(
    embedded
      ? {
          parentHwnd: hwnd,
          x: 0,
          y: 0,
          w: Math.round(480 * dpr),
          h: Math.round(320 * dpr),
          title: name,
        }
      : { title: name },
  );

  const rec: LiveEditorRecord = {
    entryId: entry.id,
    pluginPath: path,
    session,
    stateTimer: 0,
    paramTimer: 0,
    pendingParams: new Map(),
  };

  // The state the plugin is in IS the entry's `vst.raw_state` — but it is OUR
  // host's blob, and the offline renderer cannot load the other host's, so it
  // must be stamped with where it came from. `sinkLiveRawState` finds the entry
  // itself and does that; the caller's `sinkRawState` is the SIDECAR's sink and
  // has no way to name a host, which is exactly why it is not used here.
  session.stateSink = (stateB64) => sinkLiveRawState(entry.id, stateB64);
  session.paramSink = (index, value) => {
    rec.pendingParams.set(index, value);
    if (rec.paramTimer) return;
    rec.paramTimer = window.setTimeout(() => {
      rec.paramTimer = 0;
      const values = new Map(rec.pendingParams);
      rec.pendingParams.clear();
      sinkLiveParams(rec.entryId, values);
    }, PARAM_COALESCE_MS);
  };
  // Capture while the editor is OPEN, not only when it closes: a floating
  // window can be left open for an hour, and a crash in between would
  // otherwise lose everything the user dialed in.
  rec.stateTimer = window.setInterval(() => session.client.getState(), LIVE_STATE_CAPTURE_MS);
  // `VstEmbedHost` keeps pushing rects the only way it knows; this is what
  // makes them reach the live host instead of the offline sidecar.
  setLiveEditorRectRouter((p, r) => {
    if (p !== path) return false;
    if (r.close) {
      get().close();
      return true;
    }
    session.client.editorRect({
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.w),
      h: Math.round(r.h),
    });
    return true;
  });

  liveEditor = rec;
  useVstLiveStore.getState().setEditorOpen(entry.id, true);
  set({
    entryId: entry.id,
    pluginPath: path,
    pluginName: name,
    error: null,
    ownerTab,
    mode: embedded ? 'embedded' : 'floating',
  });
  status.setText(
    embedded
      ? `VST GUI: ${name} embedding... (live)`
      : `VST GUI: ${name} opened in its own window (live) - it is processing the signal now`,
  );
}

export const useVstEditorStore = create<VstEditorState>()((set, get) => ({
  entryId: null,
  pluginPath: null,
  pluginName: null,
  error: null,
  ownerTab: null,
  mode: null,

  open: (entry, sinkRawState) => {
    if (!entry.vst) return;
    if (get().entryId === entry.id) return; // already open for this entry
    // A live session owns this plugin: its editor is the one that changes what
    // is being heard, so the sidecar path below is not even considered.
    const session = vstSessions.get(entry.id);
    if (session && useVstLiveStore.getState().entries[entry.id]?.status === 'live') {
      void openLiveEditor(entry, session, set, get);
      return;
    }
    const path = entry.vst.plugin_path;
    const name = vstEntryName(entry.vst.plugin_name, path);
    const rawState = entry.vst.raw_state;
    // Remembered so setMode() can relaunch this exact request; set before any
    // await so a mode toggle during the open round-trip still has it.
    currentRequest = { entry, sink: sinkRawState };
    // The user's choice for THIS plugin (per-path override, else the app-wide
    // default). 'floating' sends no parent handle, even in Electron.
    const wantFloating = useVstEditorPrefs.getState().modeFor(path) === 'floating';
    const status = useStatusBarStore.getState();
    // Capture the owning tab BEFORE any await: the user can switch tabs while
    // the open round-trip is in flight, and the session must belong to the tab
    // that started it or be closed when that tab is gone by launch time.
    const ownerTab = useAppUiStore.getState().centerTab;
    // Bump the generation so any previous poll loop retires without sinking;
    // the drain below captures the old session's final state instead.
    const gen = ++sessionGen;
    // Take ownership of the outstanding session (still recorded, or already
    // closed but not yet captured) so its final state drains into ITS entry.
    const prevRecord = uncaptured;
    uncaptured = null;
    // Clear any old session record up front so its embed host unmounts and
    // stops pushing rect updates that would overwrite the drain's close request.
    if (get().entryId) {
      set({ entryId: null, pluginPath: null, pluginName: null, error: null, ownerTab: null, mode: null });
    }
    const clearEmbed = () => {
      if (get().entryId === entry.id) {
        set({ entryId: null, pluginPath: null, pluginName: null, error: null, ownerTab: null, mode: null });
      }
    };
    void (async () => {
      // Drain the previous session before open-editor resets the shared result
      // file. When the drained editor belonged to THIS entry (close followed by
      // an immediate reopen), seed the new editor with the just-captured state
      // rather than the snapshot taken before the close.
      let openState = rawState;
      if (prevRecord) {
        const drained = await drainSession(prevRecord);
        if (drained && prevRecord.entryId === entry.id) openState = drained;
      }
      // Embedded: hand the sidecar the host window so it reparents the editor
      // into the owning view. Floating (the user's choice, or a plain browser
      // with no handle to give): no parent, so the plugin owns its window and
      // everything it draws outside the editor stays reachable.
      const hwnd = wantFloating ? null : await getNativeWindowHandle();
      const embed = hwnd
        ? { parentHwnd: hwnd, rect: { x: 0, y: 0, w: 480, h: 320, dpr: window.devicePixelRatio || 1 } }
        : undefined;
      const actualMode: VstEditorMode = embed ? 'embedded' : 'floating';
      try {
        await vstApi.openEditor(path, openState, embed);
        // The user may have switched tabs, or another open() may have
        // superseded this one, while the POST was in flight. A session that no
        // view hosts must be closed (the same editor-rect close the tab
        // subscription uses), not recorded.
        if (gen !== sessionGen || useAppUiStore.getState().centerTab !== ownerTab) {
          void vstApi.editorRect(path, { x: 0, y: 0, w: 0, h: 0, dpr: 1, close: true });
          return;
        }
        // Record the session in BOTH modes (embedded and floating) so the
        // same-entry guard above debounces repeat clicks: without a record, a
        // plain browser would spawn a new sidecar process and poll loop on
        // every click of the same entry.
        set({ entryId: entry.id, pluginPath: path, pluginName: name, error: null, ownerTab, mode: actualMode });
        uncaptured = { gen, entryId: entry.id, pluginPath: path, sink: sinkRawState };
        status.setText(embed
          ? `VST GUI: ${name} embedding...`
          : `VST GUI: ${name} opened in its own window - close it to save its settings`);
        const startedAt = performance.now();
        const poll = () => {
          // A newer open() owns the result file now; it drained this session,
          // so exiting without sinking loses nothing.
          if (gen !== sessionGen) return;
          vstApi.editorResult(path)
            .then((res) => {
              if (gen !== sessionGen) return;
              if (res.status === 'ok' && res.raw_state) {
                if (uncaptured?.gen === gen) uncaptured = null;
                sinkRawState(entry.id, res.raw_state);
                status.setText(`VST GUI: ${name} settings captured`);
                clearEmbed();
                return;
              }
              if (res.status === 'error') {
                if (uncaptured?.gen === gen) uncaptured = null;
                const msg = res.error || 'editor unavailable';
                status.setText(`VST GUI FAILED: ${msg}`);
                // Keep the host visible (Electron) so the failure is on-screen,
                // not just in the status bar; otherwise there is nothing to clear.
                if (get().entryId === entry.id) set({ error: msg });
                return;
              }
              if (performance.now() - startedAt < 30 * 60 * 1000) window.setTimeout(poll, 1500);
            })
            .catch(() => {
              if (gen === sessionGen && performance.now() - startedAt < 30 * 60 * 1000) window.setTimeout(poll, 1500);
            });
        };
        window.setTimeout(poll, 1500);
      } catch (e) {
        clearEmbed();
        status.setText(`VST GUI FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  },

  setMode: (mode) => {
    if (mode !== 'embedded' && mode !== 'floating') return;
    const { pluginPath, entryId, mode: current } = get();
    if (!pluginPath) return;
    // The preference is recorded first and unconditionally: it must stick even
    // when the relaunch below is skipped (no session, or already in `mode`), so
    // the NEXT open of this plugin honours the choice either way.
    useVstEditorPrefs.getState().setModeForPlugin(pluginPath, mode);
    const request = currentRequest;
    if (!entryId || !request || request.entry.id !== entryId || current === mode) return;
    // Close through the EXISTING path, then reopen. close() leaves this
    // session's poll loop running and its record in `uncaptured`, and open()
    // drains that record before its own launch resets the shared result file —
    // so a state the outgoing editor commits lands on this entry AND seeds the
    // relaunched editor. A floating window the user has not closed yet cannot
    // be dismissed from here (only the embed watcher reads the close request),
    // so that drain times out and the relaunch proceeds with the last state
    // this entry stored; nothing captured is discarded either way.
    get().close();
    get().open(request.entry, request.sink);
  },

  close: () => {
    if (liveEditor) {
      closeLiveEditor();
      set({ entryId: null, pluginPath: null, pluginName: null, error: null, ownerTab: null, mode: null });
      return;
    }
    const { pluginPath } = get();
    if (pluginPath) void vstApi.editorRect(pluginPath, { x: 0, y: 0, w: 0, h: 0, dpr: 1, close: true });
    // The session's poll loop keeps running on purpose: the sidecar writes the
    // final raw_state when the native window actually closes, and that
    // commit-on-close capture must still reach the owning entry.
    set({ entryId: null, pluginPath: null, pluginName: null, error: null, ownerTab: null, mode: null });
  },
}));

// Leaving the tab that owns the embed closes it: the editor is a NATIVE OS
// window pinned over the web UI, so without this it would keep floating over
// whatever tab the user switched to.
useAppUiStore.subscribe((state, prevState) => {
  if (state.centerTab === prevState.centerTab) return;
  const s = useVstEditorStore.getState();
  if (s.entryId && s.ownerTab && state.centerTab !== s.ownerTab) s.close();
});
