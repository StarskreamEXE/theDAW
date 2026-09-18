/**
 * Is this page allowed to hold shared memory?
 *
 * `SharedArrayBuffer` — the ring buffer a live plugin host would hand to an
 * AudioWorklet — is only constructible in a cross-origin-isolated document:
 * one served with `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp`. theDAW sends both from the two
 * places that serve the app (`frontend/vite.config.ts` `server.headers` in dev,
 * the `app://` protocol handler in `electron-ui/main/index.ts` when packaged),
 * but a page can still end up un-isolated — an embed served without the
 * headers, a browser that does not implement the flag, a stripped runtime.
 *
 * So nothing may assume it. This module is the single place that asks, and it
 * asks `globalThis` on every call rather than caching at import: the module is
 * pulled in during boot, and a cached "no" would outlive the condition that
 * produced it.
 *
 * Nothing here allocates shared memory or touches audio — it only reports.
 */

/** True only in a document the browser has marked cross-origin isolated. */
export function isCrossOriginIsolated(): boolean {
  // Read through globalThis: `crossOriginIsolated` is a bare global in the DOM
  // lib but does not exist in Node (tests) or in a worker-less runtime, and a
  // bare reference would throw instead of answering "no".
  return (globalThis as { crossOriginIsolated?: unknown }).crossOriginIsolated === true;
}

/** True when a `SharedArrayBuffer` can actually be constructed here. */
export function sabAvailable(): boolean {
  // Both halves matter. The constructor is present in plenty of non-isolated
  // pages (only shared *memory* is gated, not the name), and isolation without
  // the constructor shows up in trimmed-down runtimes; either alone is a trap.
  const ctor = (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer;
  return typeof ctor === 'function' && isCrossOriginIsolated();
}

/**
 * What the UI says about a `vst3` chain entry that has no live node.
 *
 * `isolated` answers "could a live host exist here at all", which is why it is
 * `sabAvailable()` and not the raw flag: a page claiming isolation with no
 * SharedArrayBuffer is no more able to run a plugin than an un-isolated one,
 * and telling the user otherwise would send them hunting the wrong fault.
 * `reason` is the sentence shown in the row's `title`.
 */
export function liveVstStatus(): { isolated: boolean; reason: string } {
  const isolated = sabAvailable();
  return {
    isolated,
    reason: isolated
      ? 'isolated — live host not built yet'
      : // Names the switch, because "not isolated" is not actionable on its
        // own: the headers are opt-in (theDAW_ISOLATE=1 in vite.config.ts and
        // electron-ui/main/index.ts) and the caveat is the reason they are.
        'live VST needs cross-origin isolation (start with theDAW_ISOLATE=1; sidecar tabs are not yet proxied)',
  };
}
