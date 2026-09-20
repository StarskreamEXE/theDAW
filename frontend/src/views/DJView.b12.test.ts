/**
 * Batch-12 T14 fixes for DJView + djSamplerStore — pure helpers behind:
 *
 *   1. automixTransitionDue — the automix interval's mix-out decision
 *      (DJView.tsx), pulled out so the "when do we start blending" logic is
 *      testable without the deck/audio engine.
 *   2. useLatestRef — the fix for the automix interval effect calling
 *      `syncDeck` through a closure captured once at mount (the effect only
 *      depends on `[automixOn, automixRestart]`, by design — it must not
 *      restart the sequence on every tick — so a plain closure over
 *      `syncDeck` froze the beatmatch at whatever deck state existed the
 *      moment automix turned on). `syncDeckRef = useLatestRef(syncDeck)`
 *      re-points a ref at the latest `syncDeck` every render; a mounted-once
 *      interval reads `syncDeckRef.current` each tick instead. Rendered with
 *      jsdom + react-dom so the actual hook (not a re-implementation of it)
 *      is what gets exercised across a re-render. A source-text assertion
 *      below also pins that the transition calls `syncDeckRef.current(nxt)`
 *      and never a bare `syncDeck(nxt)` — the ref indirection is easy to
 *      accidentally undo in a future edit without either test noticing.
 *   3. automixTransitionSteps — the ordered engine calls (seek, play, sync)
 *      an automix transition makes. `sync` used to run BEFORE `play`:
 *      syncDeck's phase-align branch only nudges playback into phase when
 *      BOTH decks already read as playing, so with the incoming deck not
 *      yet playing, only the tempo (pitch) half of the beatmatch ever
 *      applied — automix matched BPM but never phase.
 *   4. samplerTriggerOpts — the per-pad gain/loop/choke defaulting
 *      (DJView.tsx sampler section). `djSamplerStore.setPadOpts` existed but
 *      nothing called it and `SamplerRail` never read `pad.gain/.loop/.choke`
 *      before firing a pad, so the persisted options were unreachable.
 *   5. samplerLoopToggle — turning a pad's Loop option OFF used to leave a
 *      currently-looping voice stuck: djEngine only stops a loop when the
 *      NEXT trigger itself carries `loop: true` (djEngine.ts:894), so once
 *      the stored option flipped to `false` there was no press left that
 *      would ever hit that stop branch. The toggle must call
 *      `djEngine.stopSample` itself when it turns Loop off.
 *
 * djSamplerStore.setPad / setPadOpts / clearPad are also exercised directly:
 * they are what the new pad-options panel calls, and had no test coverage.
 * jsdom's `localStorage` is installed as a global BEFORE djSamplerStore is
 * imported, so zustand's persist middleware finds real storage instead of
 * warning "the given storage is currently unavailable" on every write.
 *
 * Run: `npx tsx src/views/DJView.b12.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// jsdom's `window`/`localStorage` installed as globals BEFORE djSamplerStore
// is imported: zustand's `persist` middleware reads `window.localStorage`
// exactly once, at module-evaluation time (zustand/esm/middleware.mjs:
// `createJSONStorage(() => window.localStorage)` runs immediately, not
// lazily) — so `window` has to be a real global at THAT import, not merely
// before some later re-import (ESM caches the module; a second import
// returns the same already-warned store). The resolved storage object is
// captured by closure inside `createJSONStorage`, so it keeps working even
// after `window` is uninstalled again below.
//
// `window` is uninstalled again immediately after, before importing
// DJView.tsx: DJView.tsx transitively imports `state/playerStore.ts`, whose
// module body does `if (typeof window !== 'undefined' && import.meta.env.DEV)`
// — under plain tsx (no Vite), `import.meta.env` doesn't exist at all, so
// with `window` defined that line throws `Cannot read properties of
// undefined (reading 'DEV')`. playerStore.ts is outside this ticket's write
// set, so the environment is arranged around it instead of touching it:
// `window` is real only while djSamplerStore's storage is being resolved.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const win = dom.window;
const jsdomGlobals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Node: win.Node,
  localStorage: win.localStorage,
  sessionStorage: win.sessionStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const installJsdomGlobals = () => {
  for (const [key, value] of Object.entries(jsdomGlobals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
};
const uninstallJsdomGlobals = () => {
  for (const key of Object.keys(jsdomGlobals)) {
    Object.defineProperty(globalThis, key, { value: undefined, configurable: true, writable: true });
  }
};

installJsdomGlobals();
const { useDjSampler } = await import('../state/djSamplerStore.ts');
uninstallJsdomGlobals();

const {
  automixTransitionDue,
  automixTransitionSteps,
  samplerLoopToggle,
  samplerTriggerOpts,
  useLatestRef,
} = await import('./DJView.tsx');

/* ------------------------------ automixTransitionDue ------------------------------ */
{
  const base = { playing: true, currentTime: 100, duration: 120, mixOut: undefined as number | null | undefined, tailSec: 18, pendingTransition: false, incomingHasBuffer: true };

  // Classic sets: due once inside `tailSec` of the outgoing track's end.
  assert.equal(automixTransitionDue({ ...base, currentTime: 101, duration: 120 }), false, '19s left: not due yet');
  assert.equal(automixTransitionDue({ ...base, currentTime: 103, duration: 120 }), true, '17s left: due');
  assert.equal(automixTransitionDue({ ...base, currentTime: 102, duration: 120 }), true, 'exactly tailSec left: due (>=)');

  // Prepared sets: an exact mixOut point on the outgoing track wins outright,
  // even when it sits well outside the fixed tail window.
  assert.equal(automixTransitionDue({ ...base, currentTime: 50, duration: 120, mixOut: 50 }), true, 'mixOut reached, far from the end');
  assert.equal(automixTransitionDue({ ...base, currentTime: 49, duration: 120, mixOut: 50 }), false, 'mixOut not reached yet');
  assert.equal(automixTransitionDue({ ...base, currentTime: 119, duration: 120, mixOut: 200 }), false, 'a mixOut past the track length never fires from the tail rule');

  // The assistant's "transition NOW" override.
  assert.equal(automixTransitionDue({ ...base, currentTime: 10, duration: 120, pendingTransition: true }), true, 'pendingTransition forces it regardless of position');
  assert.equal(automixTransitionDue({ ...base, currentTime: 10, duration: 120, mixOut: 500, pendingTransition: true }), true, 'pendingTransition overrides an unreached mixOut too');

  // Nothing to blend into: never due, no matter how ready the outgoing track is.
  assert.equal(automixTransitionDue({ ...base, currentTime: 118, duration: 120, incomingHasBuffer: false }), false, 'incoming deck has no buffer yet');
  assert.equal(automixTransitionDue({ ...base, currentTime: 118, duration: 120, pendingTransition: true, incomingHasBuffer: false }), false, 'even a forced transition needs a decoded incoming buffer');

  // The outgoing deck must actually be playing.
  assert.equal(automixTransitionDue({ ...base, playing: false, currentTime: 118, duration: 120 }), false, 'paused outgoing deck: never due');

  // Zero-length / unknown duration with no mixOut: the tail rule needs a
  // positive duration, so it never fires on its own (matches the source
  // `cs.duration > 0 && ...` guard) — pendingTransition can still force it.
  assert.equal(automixTransitionDue({ ...base, currentTime: 0, duration: 0 }), false, 'unknown duration: tail rule inert');
  assert.equal(automixTransitionDue({ ...base, currentTime: 0, duration: 0, pendingTransition: true }), true, 'unknown duration, but forced');
}

/* ------------------------------ automixTransitionSteps ------------------------------ */
{
  const steps = automixTransitionSteps('B', 12.5);
  assert.deepEqual(
    steps,
    [
      { type: 'seek', deck: 'B', to: 12.5 },
      { type: 'play', deck: 'B' },
      { type: 'sync', deck: 'B' },
    ],
    'seek, then play, then sync — sync must be LAST so both decks read as playing when it runs',
  );
  assert.equal(steps[steps.length - 1].type, 'sync', 'sync is never anything but the final step');
  const playIndex = steps.findIndex((s) => s.type === 'play');
  const syncIndex = steps.findIndex((s) => s.type === 'sync');
  assert.ok(playIndex < syncIndex, 'play must come before sync (THE BUG: sync before play skips phase-align entirely)');

  // The other deck is addressed throughout, and the cue-in point is carried
  // through untouched (0 is a legitimate cue-in, not "unset").
  assert.deepEqual(automixTransitionSteps('A', 0), [
    { type: 'seek', deck: 'A', to: 0 },
    { type: 'play', deck: 'A' },
    { type: 'sync', deck: 'A' },
  ]);
}

/* ------------------------------ source: syncDeckRef, never a bare syncDeck(nxt) ------------------------------
 * Pins the useLatestRef wiring itself: it is easy for a future edit to
 * "simplify" the ref indirection back down to a direct `syncDeck(nxt)` call
 * inside the automix interval without either the rendered useLatestRef test
 * below or the automixTransitionSteps order test noticing, since neither one
 * touches the real `syncDeck` closure. The automix transition dispatches
 * `automixTransitionSteps`' output by `step.type` (see DJView.tsx), so the
 * ref call reads `syncDeckRef.current(step.deck)` rather than the literal
 * `(nxt)` — same deck argument, just named through the step. */
{
  const djViewSrc = readFileSync(fileURLToPath(new URL('./DJView.tsx', import.meta.url)), 'utf8');
  assert.ok(djViewSrc.includes('syncDeckRef.current(step.deck)'), 'the automix transition calls syncDeck through syncDeckRef, dispatched from automixTransitionSteps');
  assert.ok(!djViewSrc.includes('syncDeck(nxt)'), 'never a bare syncDeck(nxt) call — that closes over the automix effect\'s stale syncDeck');
  assert.ok(!/[^.]\bsyncDeck\(step\.deck\)/.test(djViewSrc), 'never a bare syncDeck(step.deck) call either — must always go through syncDeckRef.current(...)');
}

/* ------------------------------ samplerTriggerOpts ------------------------------ */
{
  assert.deepEqual(samplerTriggerOpts(undefined), { gain: 1, loop: false, choke: false }, 'no pad assigned: plain one-shot defaults');
  assert.deepEqual(
    samplerTriggerOpts({ entryId: 'a', name: 'Kick' } as never),
    { gain: 1, loop: false, choke: false },
    'a pad with no options set: same plain defaults as before per-pad options existed',
  );
  assert.deepEqual(samplerTriggerOpts({ gain: 0.5, loop: true, choke: true }), { gain: 0.5, loop: true, choke: true }, 'every option carried through as set');
  assert.deepEqual(samplerTriggerOpts({ gain: 0, loop: false, choke: false }), { gain: 0, loop: false, choke: false }, 'an explicit zero gain is not treated as unset');
}

/* ------------------------------ djSamplerStore ------------------------------ */
{
  const { setPad, setPadOpts, clearPad } = useDjSampler.getState();

  setPad(3, { entryId: 'e1', name: 'Snare' });
  assert.deepEqual(useDjSampler.getState().pads[3], { entryId: 'e1', name: 'Snare' }, 'setPad stores a fresh pad with no options');

  // setPadOpts merges into the existing pad rather than replacing it.
  setPadOpts(3, { gain: 0.7 });
  assert.deepEqual(useDjSampler.getState().pads[3], { entryId: 'e1', name: 'Snare', gain: 0.7 }, 'gain merged in, entryId/name preserved');
  setPadOpts(3, { loop: true });
  assert.deepEqual(useDjSampler.getState().pads[3], { entryId: 'e1', name: 'Snare', gain: 0.7, loop: true }, 'loop merged in on top of the earlier gain change');
  setPadOpts(3, { choke: true, gain: 0.2 });
  assert.deepEqual(useDjSampler.getState().pads[3], { entryId: 'e1', name: 'Snare', gain: 0.2, loop: true, choke: true }, 'a multi-field patch merges all of it');

  // setPadOpts on an empty slot is a no-op — nothing to attach options to.
  setPadOpts(7, { gain: 0.3 });
  assert.equal(useDjSampler.getState().pads[7], undefined, 'setPadOpts on an unassigned pad does nothing');

  clearPad(3);
  assert.equal(useDjSampler.getState().pads[3], undefined, 'clearPad removes the pad (and its options) entirely');
}

/* ------------------------------ samplerLoopToggle ------------------------------ */
{
  assert.deepEqual(samplerLoopToggle(false), { loop: true, stopSample: false }, 'turning Loop ON: no stop, the next press should loop');
  assert.deepEqual(samplerLoopToggle(true), { loop: false, stopSample: true }, 'turning Loop OFF: must stop whatever voice is currently looping');
}

/* ------------------------------ useLatestRef (rendered) ------------------------------
 * A tick must call the fn from the render that just committed, not the one
 * an effect closed over when it last (re)subscribed — the exact shape of the
 * automix interval, which intentionally never re-subscribes on a syncDeck
 * change. jsdom + react-dom mount the real hook rather than re-implementing
 * the pattern here. */
{
  installJsdomGlobals();
  mock.timers.enable({ apis: ['setInterval'] });

  const React = await import('react');
  const { act, useEffect } = React;
  const { createRoot } = await import('react-dom/client');
  const document = win.document;

  const calls: Array<{ who: string; arg: string }> = [];
  const fnA = (arg: string) => calls.push({ who: 'A', arg });
  const fnB = (arg: string) => calls.push({ who: 'B', arg });

  // Mirrors DJView.tsx's automix interval effect exactly: a ref that tracks
  // the latest `fn`, and an interval mounted once (empty deps) that reads
  // `fnRef.current` on every tick instead of closing over `fn` directly.
  function Harness({ fn }: { fn: (x: string) => void }) {
    const fnRef = useLatestRef(fn);
    useEffect(() => {
      const id = setInterval(() => { fnRef.current('tick'); }, 100);
      return () => clearInterval(id);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => { root.render(React.createElement(Harness, { fn: fnA })); });
  await act(async () => { mock.timers.tick(100); });
  assert.deepEqual(calls, [{ who: 'A', arg: 'tick' }], 'first tick after mount calls the fn passed in at mount');

  // Re-render with a NEW fn — same mount, the interval effect does not
  // restart (deps are []). The bug this replaces: without useLatestRef, the
  // next tick would still call fnA.
  await act(async () => { root.render(React.createElement(Harness, { fn: fnB })); });
  await act(async () => { mock.timers.tick(100); });
  assert.deepEqual(
    calls,
    [{ who: 'A', arg: 'tick' }, { who: 'B', arg: 'tick' }],
    'after a re-render with a new fn, the next tick calls the NEW fn (THE BUG: a stale closure would have called fnA again)',
  );

  await act(async () => { root.unmount(); });
  mock.timers.reset();
}

console.log('DJView.b12: ok');
