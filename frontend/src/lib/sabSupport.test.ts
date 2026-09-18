/**
 * Cross-origin isolation probe — the gate a live VST3 host will sit behind.
 *
 * Every assertion here drives `globalThis` directly, because that is the only
 * input these helpers have: a page is isolated or it is not, and the answer has
 * to be read at CALL time, not at module load. A cached answer is the bug this
 * file exists to prevent — the module is imported during boot, and in Electron
 * the renderer's first document can be swapped for one served with different
 * headers, so a value frozen at import would be stale and a worklet would be
 * handed a SharedArrayBuffer that cannot exist.
 *
 * Run: `npx tsx src/lib/sabSupport.test.ts`
 */
import assert from 'node:assert/strict';

const g = globalThis as unknown as {
  crossOriginIsolated?: unknown;
  SharedArrayBuffer?: unknown;
};

const realSab = g.SharedArrayBuffer;

/** Put `globalThis` in a known state: isolation flag + SharedArrayBuffer. */
function stub(isolated: unknown, sab: unknown): void {
  if (isolated === undefined) delete g.crossOriginIsolated;
  else Object.defineProperty(g, 'crossOriginIsolated', { value: isolated, configurable: true, writable: true });
  if (sab === undefined) delete g.SharedArrayBuffer;
  else Object.defineProperty(g, 'SharedArrayBuffer', { value: sab, configurable: true, writable: true });
}

const { isCrossOriginIsolated, sabAvailable, liveVstStatus } = await import('./sabSupport.ts');

// --- isCrossOriginIsolated ------------------------------------------------
// The flag is absent in Node and in any browser context that never got the
// headers; absent must read as "not isolated", never as a crash.
stub(undefined, realSab);
assert.equal(isCrossOriginIsolated(), false, 'an absent crossOriginIsolated flag is not isolation');

stub(false, realSab);
assert.equal(isCrossOriginIsolated(), false, 'a false flag is not isolation');

stub(true, realSab);
assert.equal(isCrossOriginIsolated(), true, 'a true flag is isolation');

// Only the boolean true counts. A truthy string ("yes", or a stray polyfill)
// must not open the gate, because SharedArrayBuffer would still be missing.
stub('yes', realSab);
assert.equal(isCrossOriginIsolated(), false, 'only boolean true counts as isolation');

// The answer is re-read every call, so flipping the flag flips the answer
// without re-importing the module.
stub(true, realSab);
assert.equal(isCrossOriginIsolated(), true);
stub(false, realSab);
assert.equal(isCrossOriginIsolated(), false, 'the flag is read per call, not cached at import');

// --- sabAvailable ---------------------------------------------------------
// Both halves are required: the constructor exists in plenty of non-isolated
// pages (it is only the *shared* memory that is gated), and isolation without
// the constructor happens in stripped-down runtimes.
stub(true, realSab);
assert.equal(sabAvailable(), true, 'isolated + constructor present');

stub(false, realSab);
assert.equal(sabAvailable(), false, 'the constructor alone is not enough');

stub(true, undefined);
assert.equal(sabAvailable(), false, 'isolation alone is not enough');

stub(undefined, undefined);
assert.equal(sabAvailable(), false, 'neither half present');

// --- liveVstStatus --------------------------------------------------------
stub(false, realSab);
const off = liveVstStatus();
assert.equal(off.isolated, false);
assert.equal(
  off.reason,
  'live VST needs cross-origin isolation (start with theDAW_ISOLATE=1; sidecar tabs are not yet proxied)',
  'the un-isolated reason names the switch that turns isolation on',
);

stub(true, realSab);
const on = liveVstStatus();
assert.equal(on.isolated, true);
assert.equal(on.reason, 'isolated — live host not built yet');

// Isolation is claimed but SharedArrayBuffer is gone: the page cannot host a
// live plugin either, so the status must not read as ready.
stub(true, undefined);
const half = liveVstStatus();
assert.equal(half.isolated, false, 'no SharedArrayBuffer means not usable, whatever the flag says');
assert.equal(
  half.reason,
  'live VST needs cross-origin isolation (start with theDAW_ISOLATE=1; sidecar tabs are not yet proxied)',
);

// The reason is always a non-empty string — it is rendered into a title
// attribute, and an empty title is an invisible tooltip.
for (const [iso, sab] of [[true, realSab], [false, realSab], [undefined, undefined]] as const) {
  stub(iso, sab);
  assert.ok(liveVstStatus().reason.length > 0, 'every branch yields a reason to show');
}


// The two states must not read the same — the badge's title is the only
// place a user learns which one they are in.
stub(false, realSab);
const reasonOff = liveVstStatus().reason;
stub(true, realSab);
const reasonOn = liveVstStatus().reason;
assert.notEqual(reasonOff, reasonOn, 'isolated and un-isolated say different things');
assert.ok(reasonOff.includes('theDAW_ISOLATE=1'), 'the un-isolated reason tells you what to do');
assert.ok(!reasonOn.includes('theDAW_ISOLATE'), 'the isolated reason does not send you to a flag already set');

stub(undefined, realSab);
console.log('sabSupport: all assertions passed');
