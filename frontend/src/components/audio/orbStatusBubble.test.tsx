/**
 * The orb's status bubbles in a DOM, replayed in the order a pointer produces.
 *
 * - The bubble by the orb (OrbStatusFloat): the pointer enters it, clicks it,
 *   and the button leaves the page under the pointer, so no mouseleave comes.
 *   The pointer moves away, a new notice posts, and its time passes: the bubble
 *   must leave on time. Then hover still holds a notice until the pointer
 *   leaves. Its placement: in the footer row beside the corner orb, above an orb
 *   elsewhere, below an orb near the top.
 * - The footer bubble (OrbTipBubble): the same click while hovered, then a later
 *   notice that must expire on time; and a notice that lands during a tip's fade
 *   must return the bubble to the tip it showed.
 *
 * jsdom supplies the DOM; setTimeout and Date are node:test mocks, and the
 * page's window timers are routed through them.
 *
 * Run: `node node_modules/tsx/dist/cli.mjs src/components/audio/orbStatusBubble.test.tsx` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;

mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000 });
// jsdom keeps its own timers; the components call window.setTimeout.
win.setTimeout = ((fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms)) as unknown as typeof win.setTimeout;
win.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id)) as unknown as typeof win.clearTimeout;

const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  HTMLButtonElement: win.HTMLButtonElement,
  Node: win.Node,
  MouseEvent: win.MouseEvent,
  localStorage: win.localStorage,
  sessionStorage: win.sessionStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { postStatus, useStatusNoticeStore, STATUS_INFO_MS, STATUS_FAILURE_MS } = await import('../../state/statusNoticeStore');
const { OrbStatusFloat, floatPlacement } = await import('./OrbStatusFloat');
const { OrbTipBubble } = await import('./OrbTipBubble');

const document = win.document;
const current = () => useStatusNoticeStore.getState().current;
// A DOM node never goes into assert.equal: React hangs its fibers on the node, and
// a failing assert inspects that whole graph for its diff, which blocks for minutes.
const absent = (el: Element | null, message: string) => assert.ok(el === null, message);
const step = (fn: () => void) => act(async () => { fn(); });
const tick = (ms: number) => step(() => mock.timers.tick(ms));
const enter = (el: Element) => step(() => {
  el.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
});
const leave = (el: Element) => step(() => {
  el.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
});
const click = (el: Element) => step(() => {
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
});
const mount = () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return { host, root: createRoot(host) };
};

// ── Placement ────────────────────────────────────────────────────────────────
assert.deepEqual(floatPlacement({ x: 0, y: 688 }, 112, { width: 1200, height: 800 }), { kind: 'footer', left: 120, width: 240 });
assert.deepEqual(floatPlacement({ x: 0, y: 656 }, 112, { width: 1024, height: 768 }), { kind: 'footer', left: 120, width: 222 });
assert.equal(floatPlacement({ x: 12, y: 628 }, 112, { width: 1200, height: 800 }).kind, 'footer', 'an unpinned orb resting on the footer');
assert.deepEqual(floatPlacement({ x: 500, y: 400 }, 112, { width: 1200, height: 800 }), { kind: 'above', left: 500, bottom: 436, tailLeft: 52 });
assert.equal(floatPlacement({ x: 500, y: 20 }, 112, { width: 1200, height: 800 }).kind, 'below');
assert.equal(floatPlacement({ x: 600, y: 688 }, 112, { width: 1200, height: 800 }).kind, 'above', 'an orb on the footer away from the corner');

// ── The bubble by the orb: click while hovered, then a later notice ──────────
const float = mount();
let floatLogOpened = 0;
const corner = { x: 0, y: win.innerHeight - 112 };
await step(() => float.root.render(
  <OrbStatusFloat position={corner} orbBox={112} onOpenLog={() => { floatLogOpened += 1; }} />,
));
const floatButton = () => float.host.querySelector('button');
absent(floatButton(), 'nothing while no notice is up');

await step(() => postStatus('SAVE FAILED: float probe one'));
let button = floatButton();
assert.ok(button, 'a notice shows by the orb');
const frame = button.parentElement as HTMLElement;
assert.equal(frame.dataset.placement, 'footer');
assert.equal(frame.style.left, '120px');
assert.equal(frame.style.bottom, '0px');
assert.ok(button.className.includes('et-ink') === false && button.innerHTML.includes('text-red-200'));

await enter(button);
await click(button);
absent(floatButton(), 'the click lets it go');
assert.equal(floatLogOpened, 1, 'and opens the LOG');
assert.equal(current(), null);

// The button left the page under the pointer; the pointer moves away. No
// mouseleave reaches a button that is gone.
await tick(1000);
await step(() => postStatus('SAVED: float probe two'));
button = floatButton();
assert.ok(button, 'the next notice shows');
assert.ok(button.innerHTML.includes('et-ink'), 'a success draws in the theme ink');
await tick(STATUS_INFO_MS);
assert.equal(current(), null);
absent(floatButton(), 'and leaves on time');

// Hover still holds a notice past its time, until the pointer leaves.
await tick(1000);
await step(() => postStatus('SAVED: float probe three'));
button = floatButton();
assert.ok(button);
await enter(button);
await tick(STATUS_INFO_MS + 1000);
assert.equal(current(), null);
assert.ok(floatButton(), 'held while the pointer is on it');
await leave(floatButton() as Element);
absent(floatButton(), 'gone when the pointer leaves');

// An orb dragged away from the corner: the bubble goes above it.
await step(() => float.root.render(<OrbStatusFloat position={{ x: 400, y: 300 }} orbBox={112} />));
await step(() => postStatus('SAVE FAILED: float probe four'));
assert.equal((floatButton()?.parentElement as HTMLElement).dataset.placement, 'above');
await tick(STATUS_FAILURE_MS);
absent(floatButton(), 'the bubble above the orb leaves on time');
await step(() => float.root.unmount());

// ── The footer bubble: click while hovered, then a later notice ──────────────
const realRandom = Math.random;
Math.random = () => 0.5;
const footer = mount();
let footerLogOpened = 0;
await step(() => footer.root.render(<OrbTipBubble onOpenLog={() => { footerLogOpened += 1; }} />));
Math.random = realRandom;
const footerButton = () => footer.host.querySelector('button') as HTMLButtonElement;
const label = () => footerButton().getAttribute('aria-label') ?? '';
const liveText = () => footer.host.querySelector('[role="status"]')?.textContent ?? '';
const GREETING_LABEL = 'Assistant tip: click me for assistance. Activate for the next tip.';
assert.equal(label(), GREETING_LABEL);

await tick(1000);
await step(() => postStatus('SAVE FAILED: footer probe one'));
assert.ok(label().startsWith('Status: SAVE FAILED: footer probe one'));
assert.equal(liveText(), 'SAVE FAILED: footer probe one');
assert.ok(footerButton().parentElement?.className.includes('inset-x-0'), 'the notice panel keeps the slot width, left of the scrub strip');
await enter(footerButton());
await click(footerButton());
assert.equal(label(), GREETING_LABEL, 'the click returns the bubble to its tip');
assert.equal(footerLogOpened, 1);

// The panel collapsed to the tip under a pointer that did not move: no
// mouseleave. A later notice must still expire on time.
await tick(1000);
await step(() => postStatus('SAVED: footer probe two'));
assert.ok(label().startsWith('Status: SAVED: footer probe two'));
await tick(STATUS_INFO_MS);
assert.equal(current(), null);
assert.equal(label(), GREETING_LABEL, 'the notice leaves on time');
assert.equal(liveText(), '');

// ── A notice that lands during a tip's fade returns to the tip it showed ─────
// The greeting's dwell ends and the fade to the next tip starts; a notice
// arrives 100ms into the 420ms fade.
await tick(20_000);
await tick(100);
await step(() => postStatus('SAVED: footer probe mid-fade'));
await tick(420);
assert.ok(label().startsWith('Status: SAVED: footer probe mid-fade'));
await tick(STATUS_INFO_MS);
assert.equal(label(), GREETING_LABEL, 'back on the greeting, not the tip the fade was heading to');
const tipText = footerButton().querySelector('span.transition-opacity') as HTMLElement;
assert.ok(tipText.className.includes('opacity-100'), 'and visible');

await step(() => footer.root.unmount());
mock.timers.reset();
console.log('orbStatusBubble tests passed');
