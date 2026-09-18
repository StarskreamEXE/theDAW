/**
 * vstLive/sessionRegistry — one native host process per `ChainEntry.id`, kept
 * alive ACROSS chain rebuilds.
 *
 * The mixer rebuilds every insert chain on play, stop and seek, which disposes
 * and re-makes every effect instance. A live VST cannot follow that: spawning
 * a process, loading a 1.7 GB mastering suite and restoring its state takes
 * seconds, and doing it on every transport press would be unusable. So the
 * session outlives the instance:
 *
 *   dispose()  ->  release(id)  ->  10 s grace timer
 *   rebuild    ->  acquire(id)  ->  cancels the timer, hands back the SAME
 *                                   process, plugin state and all
 *
 * Only removing the entry (`close`) or closing the project / page (`closeAll`)
 * actually shuts a host down.
 *
 * Failure is always visible on the row: no host binary is `unavailable` with
 * the backend's own reason, a refused spawn is `error` with the message, and a
 * socket that dies later re-creates the session in the background (the POST is
 * idempotent per entry id, so a process that is merely unreachable is reused
 * and one that actually died is respawned with its state file).
 *
 * `createVstSessionRegistry` exists so tests can inject timers and a fake
 * client; the app uses the module-level `vstSessions`.
 */
import {
  closeLiveSessionOnUnload,
  vstLiveApi,
  type VstLiveSessionInfo,
} from '../vstClient';
import { useVstLiveStore } from '../../state/vstLiveStore';
import { VstBridgeClient, type VstBridgeClientOptions } from './bridgeClient';
import type { VstFrame } from './frames';
import type { ChainEntry } from '../../state/effectChainStore';

/**
 * Where a plugin state this module rescues is written back to.
 *
 * The registry deliberately knows nothing about chains — it is keyed by
 * `ChainEntry.id` and reads only `vstLiveStore` — so the module that DOES know
 * where an entry lives (`state/vstEditorStore`, which already walks the MIX
 * chain, every track chain and both master chains for `param` events) installs
 * itself here instead. Importing it from this file would close a cycle.
 */
export type VstLiveStateSink = (entryId: string, rawState: string) => void;

let moduleStateSink: VstLiveStateSink | null = null;

/** Point the shutdown-state rescue at a sink; `null` unhooks it. */
export function setVstLiveStateSink(sink: VstLiveStateSink | null): void {
  moduleStateSink = sink;
}

/** Frames per block on the wire. ONE definition — the worklet, the node, the
 *  latency figure and the spawn request all read it from here. */
export const VST_LIVE_BLOCK_SIZE = 512;
/** Blocks the play-out buffer holds back (protocol default). */
export const VST_LIVE_BUFFER_BLOCKS = 2;
/** Channels the v1 frontend always sends. */
export const VST_LIVE_CHANNELS = 2;
/** How long a disposed instance's process is kept before it is reaped. */
export const VST_LIVE_GRACE_MS = 10_000;

/** A running host process and the client talking to it. */
export interface VstLiveSession {
  entryId: string;
  sessionId: string;
  wsUrl: string;
  pid: number;
  client: VstBridgeClient;
  /** Where processed blocks go. Set by the live node when its worklet exists,
   *  and cleared when the node is disposed — a session outlives its node, so
   *  the sink cannot be fixed at construction. */
  audioSink?: ((frame: VstFrame) => void) | null;
  /** Where a captured plugin state goes. Set by `vstEditorStore` while an
   *  editor is open on this session, for the same reason as `audioSink`. */
  stateSink?: ((stateB64: string) => void) | null;
  /** Where a parameter the user moved IN THE PLUGIN'S OWN EDITOR goes. */
  paramSink?: ((index: number, value: number) => void) | null;
  /** A parameter has been pushed to this plugin since its state was last
   *  captured, so the entry's stored `raw_state` is behind what is sounding.
   *  The save-time capture pass asks exactly these sessions (plus the ones with
   *  an editor open) for a fresh state, rather than all of them — a `get_state`
   *  parks the audio thread, and doing it for every idle plugin on every
   *  autosave would tick the transport. */
  stateDirty: boolean;
}

export interface VstSessionRegistryDeps {
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
  graceMs?: number;
  /** Test seam: build the bridge client for a session. */
  makeClient?: (opts: VstBridgeClientOptions) => VstBridgeClient;
  /** Where a state rescued from a shutdown goes. Defaults to the module-level
   *  sink installed by `setVstLiveStateSink`. */
  stateSink?: VstLiveStateSink;
}

export interface VstSessionRegistry {
  /** Open (or reuse) the session for `entry`. Resolves to null — never throws —
   *  when there is nothing to host, no host binary, or the spawn failed; the
   *  reason is on the entry's row in `vstLiveStore`. */
  acquire(entry: ChainEntry, sampleRate: number): Promise<VstLiveSession | null>;
  /** An instance was disposed: start the grace timer. */
  release(entryId: string): void;
  /** The entry is gone: shut the host down now. */
  close(entryId: string): void;
  /** Project close / page unload. */
  closeAll(): void;
  /** Reconnect an errored session NOW rather than waiting out its backoff —
   *  what the FX row's retry control does. No-op for a healthy session, or for
   *  an entry that has none. */
  retry(entryId: string): void;
  get(entryId: string): VstLiveSession | undefined;
  /** Every session that currently has a live host process, so the save-time
   *  capture pass can pick the ones worth asking for a state. */
  sessions(): VstLiveSession[];
  /** A parameter was pushed to this entry's plugin: its stored state is now
   *  behind what is sounding. No-op for an entry with no session. */
  markParamsChanged(entryId: string): void;
  /** Cached answer to "is there a host binary"; null until the probe lands. */
  hostAvailable(): boolean | null;
  /** Ids with a live or pending session, for the unload handler. */
  sessionIds(): string[];
}

interface Slot {
  session: VstLiveSession | null;
  /** In-flight acquire, so two rebuilds in the same tick spawn once. */
  opening: Promise<VstLiveSession | null> | null;
  graceHandle: number | null;
  /** A re-create is in flight after a socket loss: offer no url until it lands. */
  recreating: boolean;
  entry: ChainEntry;
  sampleRate: number;
}

export function createVstSessionRegistry(deps: VstSessionRegistryDeps = {}): VstSessionRegistry {
  const schedule = deps.schedule ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
  const cancel = deps.cancel ?? ((h) => globalThis.clearTimeout(h as unknown as number));
  const graceMs = deps.graceMs ?? VST_LIVE_GRACE_MS;
  const makeClient = deps.makeClient ?? ((opts) => new VstBridgeClient(opts));
  /** Resolved per call, not captured: the app installs its sink after this
   *  module is imported, and a registry built first must still find it. */
  const stateSink = (entryId: string, rawState: string): void => {
    (deps.stateSink ?? moduleStateSink)?.(entryId, rawState);
  };

  const slots = new Map<string, Slot>();
  /** null = not probed; a promise while the probe is in flight. */
  let hostProbe: Promise<HostProbe> | null = null;

  const store = () => useVstLiveStore.getState();

  /** `transient` separates "this machine has no host binary" (a fact, shown as
   *  render-only) from "the backend did not answer" (an outage, shown as an
   *  error the user can retry). */
  interface HostProbe {
    available: boolean;
    reason?: string;
    transient: boolean;
  }

  const probeHost = (): Promise<HostProbe> => {
    if (hostProbe) return hostProbe;
    hostProbe = vstLiveApi
      .host()
      .then((info): HostProbe => {
        store().setHost({
          available: info.available,
          reason: info.reason,
          path: info.path,
          version: info.version,
        });
        return { available: info.available, reason: info.reason, transient: false };
      })
      .catch((e: unknown): HostProbe => {
        const reason = e instanceof Error ? e.message : String(e);
        store().setHost({ available: false, reason });
        // Not cached as a permanent "no": the backend may simply not be up yet,
        // and the next acquire should ask again rather than declaring the
        // machine plugin-less for the rest of the session.
        hostProbe = null;
        return { available: false, reason, transient: true };
      });
    return hostProbe;
  };

  /**
   * Does this host message say the plugin could not take the saved state?
   *
   * The host does not have a dedicated "state rejected" event: a restore that
   * fails surfaces as a `ready` warning, or as a non-fatal `warning`/`error`
   * once `set_state` has been answered. Matching on the word is deliberate and
   * deliberately narrow — an unrelated warning (an editor that would not open,
   * an unused output pair) must not accuse the state and put a "defaults" badge
   * on a plugin that is holding exactly what the user saved.
   */
  const mentionsState = (text: string): boolean => /\bstate\b/i.test(text);

  /** The host says the state did not take — record it, in the host's words. */
  const stateRejected = (entryId: string, reason: string): void =>
    store().setStateOrigin(entryId, 'state-rejected', reason);

  const spawn = async (entry: ChainEntry, sampleRate: number): Promise<VstLiveSessionInfo> =>
    vstLiveApi.createSession({
      chain_entry_id: entry.id,
      plugin_path: entry.vst?.plugin_path ?? '',
      plugin_name: entry.vst?.plugin_name,
      sample_rate: sampleRate,
      block_size: VST_LIVE_BLOCK_SIZE,
      channels: VST_LIVE_CHANNELS,
      raw_state: entry.vst?.raw_state,
    });

  /** Re-create a session whose socket died, in the background. */
  const recreate = (slot: Slot): void => {
    if (slot.recreating) return;
    slot.recreating = true;
    void spawn(slot.entry, slot.sampleRate)
      .then((info) => {
        if (!slot.session) return;
        slot.session.sessionId = info.session_id;
        slot.session.wsUrl = info.ws_url;
        slot.session.pid = info.pid;
      })
      .catch((e: unknown) => {
        // Leave the old url in place: the client keeps backing off and will ask
        // again, and the reason is already on the row.
        store().setStatus(slot.entry.id, 'error', e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        slot.recreating = false;
      });
  };

  const shutdown = (entryId: string, slot: Slot): void => {
    if (slot.graceHandle !== null) {
      cancel(slot.graceHandle);
      slot.graceHandle = null;
    }
    const session = slot.session;
    slot.session = null;
    slot.opening = null;
    slots.delete(entryId);
    store().clearEntry(entryId);
    if (!session) return;
    session.client.close();
    // The DELETE is what makes the host write its state file, AND its response
    // carries that file's contents back. Dropping it used to lose everything
    // the user dialed in since the last capture the moment they removed the
    // entry or closed the project — the one path where nothing else can catch
    // it, because the socket is already gone. A rejection is not actionable
    // (the process is reaped by `--parent-pid` regardless), so it is swallowed
    // rather than thrown at a caller who is tearing down.
    void vstLiveApi
      .deleteSession(session.sessionId)
      .then((res) => {
        if (res?.raw_state) stateSink(entryId, res.raw_state);
      })
      .catch(() => {});
  };

  const open = async (entry: ChainEntry, sampleRate: number, slot: Slot): Promise<VstLiveSession | null> => {
    store().setStatus(entry.id, 'starting');
    // Every open starts from "the plugin holds what the entry holds": the saved
    // state IS sent (see `spawn`), so only the host can contradict that, and a
    // rejection recorded for a previous session must not outlive it.
    store().setStateOrigin(entry.id, 'live');
    const probe = await probeHost();
    if (!probe.available) {
      store().setStatus(
        entry.id,
        probe.transient ? 'error' : 'unavailable',
        probe.reason ?? 'live VST host is not available',
      );
      return null;
    }
    let info: VstLiveSessionInfo;
    try {
      info = await spawn(entry, sampleRate);
    } catch (e: unknown) {
      store().setStatus(entry.id, 'error', e instanceof Error ? e.message : String(e));
      return null;
    }
    const session: VstLiveSession = {
      entryId: entry.id,
      sessionId: info.session_id,
      wsUrl: info.ws_url,
      pid: info.pid,
      client: null as unknown as VstBridgeClient,
      audioSink: null,
      stateDirty: false,
    };
    session.client = makeClient({
      url: info.ws_url,
      // While a re-create is in flight there is no url worth trying; the client
      // keeps its backoff running instead of hammering a dead port.
      resolveUrl: () => (slot.recreating ? null : session.wsUrl),
      handlers: {
        onStatus: (status, reason) => {
          if (status === 'error') {
            store().setStatus(entry.id, 'error', reason);
            recreate(slot);
          }
        },
        onReady: (ready) => {
          store().setReady(entry.id, {
            plugin: ready.plugin,
            pluginLatencySamples: ready.latency_samples,
            bridgeLatencySamples: ready.block_size * (VST_LIVE_BUFFER_BLOCKS + 1),
            sampleRate: ready.sample_rate,
            hasEditor: ready.has_editor,
          });
          // Only an entry that HAD something saved can have had it refused;
          // a fresh plugin at its defaults is not a failed restore.
          if (!slot.entry.vst?.raw_state) return;
          const stateWarning = ready.warnings.find(mentionsState);
          if (ready.state_compat === false || stateWarning) {
            stateRejected(entry.id, stateWarning ?? 'the plugin refused the saved state');
          }
        },
        onWarning: (text) => {
          if (slot.entry.vst?.raw_state && mentionsState(text)) stateRejected(entry.id, text);
        },
        onError: (text, fatal) => {
          // A fatal error is a dead session, which the row already says through
          // `onStatus`; only a survivable one is a state story.
          if (!fatal && slot.entry.vst?.raw_state && mentionsState(text)) stateRejected(entry.id, text);
        },
        onAudio: (frame) => session.audioSink?.(frame),
        onState: (stateB64) => session.stateSink?.(stateB64),
        onParam: (index, value) => session.paramSink?.(index, value),
        onLatency: (samples) => store().setLatency(entry.id, samples),
        onXrun: (late) => store().addXruns(entry.id, late),
        onEditor: (e) => store().setEditorOpen(entry.id, e.open),
      },
    });
    slot.session = session;
    session.client.connect();
    return session;
  };

  return {
    acquire(entry, sampleRate) {
      // Nothing to host: an entry with no plugin path is a broken import, not a
      // reason to wake the backend up.
      if (!entry.vst?.plugin_path) return Promise.resolve(null);
      let slot = slots.get(entry.id);
      if (slot) {
        slot.entry = entry;
        slot.sampleRate = sampleRate;
        // A rebuild landing inside the grace window: the process is still
        // running, so cancel the reaper and hand it straight back.
        if (slot.graceHandle !== null) {
          cancel(slot.graceHandle);
          slot.graceHandle = null;
        }
        if (slot.session) return Promise.resolve(slot.session);
        if (slot.opening) return slot.opening;
      } else {
        slot = { session: null, opening: null, graceHandle: null, recreating: false, entry, sampleRate };
        slots.set(entry.id, slot);
      }
      const here = slot;
      const opening = open(entry, sampleRate, here).then((s) => {
        here.opening = null;
        // A close() that raced the spawn wins: shut the new process down again
        // rather than leaving an orphan nobody is holding.
        if (!slots.has(entry.id) && s) {
          s.client.close();
          void vstLiveApi.deleteSession(s.sessionId).catch(() => {});
          return null;
        }
        return s;
      });
      here.opening = opening;
      return opening;
    },

    release(entryId) {
      const slot = slots.get(entryId);
      if (!slot || slot.graceHandle !== null) return;
      slot.graceHandle = schedule(() => {
        slot.graceHandle = null;
        shutdown(entryId, slot);
      }, graceMs);
    },

    close(entryId) {
      const slot = slots.get(entryId);
      if (!slot) return;
      shutdown(entryId, slot);
    },

    closeAll() {
      for (const [id, slot] of [...slots]) shutdown(id, slot);
    },

    retry(entryId) {
      const slot = slots.get(entryId);
      if (!slot?.session) return;
      store().setStatus(entryId, 'starting');
      slot.session.client.retryNow();
    },

    get(entryId) {
      return slots.get(entryId)?.session ?? undefined;
    },

    sessions() {
      const out: VstLiveSession[] = [];
      for (const slot of slots.values()) if (slot.session) out.push(slot.session);
      return out;
    },

    markParamsChanged(entryId) {
      const session = slots.get(entryId)?.session;
      if (session) session.stateDirty = true;
    },

    hostAvailable() {
      return useVstLiveStore.getState().host.available;
    },

    sessionIds() {
      const ids: string[] = [];
      for (const slot of slots.values()) if (slot.session) ids.push(slot.session.sessionId);
      return ids;
    },
  };
}

/** The app's registry. One per document — a session is keyed by chain entry id,
 *  which is unique across every rack in the project. */
export const vstSessions: VstSessionRegistry = createVstSessionRegistry();

/**
 * Close every host process when the page goes away.
 *
 * `pagehide` rather than `unload`: `unload` does not fire on a bfcache
 * navigation or on mobile, and a normal `fetch` issued from either is cancelled
 * with the document — hence the keepalive DELETE in `closeLiveSessionOnUnload`.
 * Registered once at import; a second call is a no-op.
 */
let unloadHooked = false;
export function hookVstSessionUnload(): void {
  if (unloadHooked || typeof window === 'undefined') return;
  unloadHooked = true;
  window.addEventListener('pagehide', () => {
    for (const id of vstSessions.sessionIds()) closeLiveSessionOnUnload(id);
  });
}
