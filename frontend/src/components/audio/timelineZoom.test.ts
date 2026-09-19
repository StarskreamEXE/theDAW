import assert from 'node:assert/strict';
import { WHEEL_PROFILES } from '../../lib/timeline/viewport';
import {
  CLIP_EDGE_ZONE_PX,
  MIN_CONTENT_WIDTH_PX,
  ZOOM_FOLLOW_HOLD_MS,
  clipChromeLayout,
  createZoomCoalescer,
  fitProjectZoom,
  fitRangeZoom,
  followHoldActive,
  localViewportWidth,
  planZoom,
  resolveAnchorSec,
  rulerBarLabels,
  shouldRescrollAfterZoom,
  spanOfClips,
  viewportWindowSec,
  wheelDispatch,
} from './timelineZoom';

const BOUNDS = { min: 0.25, max: 400 };
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// --- Viewport width: viewport px -> local px, header column excluded --------
{
  // Unscaled, scroller only.
  assert.equal(localViewportWidth({ rectWidthPx: 1000, layoutZoom: 1 }), 1000);
  // Shell CSS zoom 0.85: a 850 px on-screen box is 1000 local px.
  near(localViewportWidth({ rectWidthPx: 850, layoutZoom: 0.85 }), 1000);
  // A measured box that includes the 200-px (viewport px) track-header column.
  near(localViewportWidth({ rectWidthPx: 1020, layoutZoom: 0.85, headerColumnPx: 170 }), 1000);
  // Never negative.
  assert.equal(localViewportWidth({ rectWidthPx: 100, layoutZoom: 1, headerColumnPx: 300 }), 0);
  assert.throws(() => localViewportWidth({ rectWidthPx: NaN, layoutZoom: 1 }), RangeError);
  assert.throws(() => localViewportWidth({ rectWidthPx: 100, layoutZoom: 0 }), RangeError);
}

// --- Anchor: the edit cursor, clamped into the content ------------------------
{
  assert.equal(resolveAnchorSec('edit-cursor', 60, 300), 60);
  assert.equal(resolveAnchorSec('edit-cursor', 900, 300), 300);
  assert.equal(resolveAnchorSec('edit-cursor', -4, 300), 0);
  assert.equal(resolveAnchorSec({ sec: 42 }, 60, 300), 42);
  assert.throws(() => resolveAnchorSec('edit-cursor', Infinity, 300), RangeError);
}

// --- planZoom: the anchor stays centred through repeated zooms --------------
{
  const vw = 1000;
  let zoom = 10;
  for (let i = 0; i < 12; i++) {
    const next = planZoom({ requestedZoom: zoom * 1.25, anchorSec: 60, totalDurationSec: 300, viewportWidth: vw, bounds: BOUNDS });
    zoom = next.zoom;
    // Anchor time at the centre of the viewport after every step.
    near((next.scrollLeft + vw / 2) / next.zoom, 60, 1e-6);
  }
  // Zooming out to where the whole project fits: clamped to 0, not centred.
  const out = planZoom({ requestedZoom: 1, anchorSec: 60, totalDurationSec: 300, viewportWidth: vw, bounds: BOUNDS });
  assert.equal(out.scrollLeft, 0);
  // Zoom is clamped to the store bounds.
  assert.equal(planZoom({ requestedZoom: 9999, anchorSec: 60, totalDurationSec: 300, viewportWidth: vw, bounds: BOUNDS }).zoom, 400);
  // The content is at least MIN_CONTENT_WIDTH_PX wide (the editor's own rule), so a
  // short project at a small zoom can still scroll to the min-width edge.
  const short = planZoom({ requestedZoom: 1, anchorSec: 900, totalDurationSec: 10, viewportWidth: 400, bounds: BOUNDS });
  assert.equal(short.scrollLeft, MIN_CONTENT_WIDTH_PX - 400);
  // At the end of the content the anchor cannot be centred: scroll clamps.
  const end = planZoom({ requestedZoom: 10, anchorSec: 300, totalDurationSec: 300, viewportWidth: vw, bounds: BOUNDS });
  assert.equal(end.scrollLeft, 300 * 10 - vw);
}

// --- CSS zoom + header column feed the same centring ------------------------
{
  const vw = localViewportWidth({ rectWidthPx: 1020, layoutZoom: 0.85, headerColumnPx: 170 });
  const p = planZoom({ requestedZoom: 20, anchorSec: 60, totalDurationSec: 300, viewportWidth: vw, bounds: BOUNDS });
  near(p.scrollLeft, 60 * 20 - 500, 1e-6);
}

// --- Whether a zoom request should also move scrollLeft (F3 #1) -------------
{
  // At a bound: the clamp cannot move the zoom further, so an incidental
  // wheel/step nudge must not yank the view back to the anchor.
  assert.equal(shouldRescrollAfterZoom(BOUNDS.min, BOUNDS.min, false), false);
  assert.equal(shouldRescrollAfterZoom(BOUNDS.max, BOUNDS.max, false), false);
  // No-op off any bound: the requested zoom already equals the committed one.
  assert.equal(shouldRescrollAfterZoom(10, 10, false), false);
  // An explicit command (zoom to selection, zoom to fit) still moves the
  // viewport even when the zoom itself does not change.
  assert.equal(shouldRescrollAfterZoom(10, 10, true), true);
  assert.equal(shouldRescrollAfterZoom(BOUNDS.max, BOUNDS.max, true), true);
  // A real zoom change always rescrolls, explicit command or not.
  assert.equal(shouldRescrollAfterZoom(10, 20, false), true);
  assert.equal(shouldRescrollAfterZoom(10, 20, true), true);
}

// --- Fit helpers -------------------------------------------------------------
{
  // 10 s range in 1100 px with 5 % margin each side: 1100 / 11 = 100 px/s.
  const r = fitRangeZoom(10, 20, 1100);
  assert.ok(r);
  near(r.zoom, 100);
  assert.equal(r.centerSec, 15);
  assert.equal(fitRangeZoom(5, 5, 1000), null);
  assert.equal(fitRangeZoom(6, 5, 1000), null);
  assert.throws(() => fitRangeZoom(0, NaN, 1000), RangeError);

  // Project fit keeps the old rule: usable = max(200, vw - 24), anchored on the centre.
  const f = fitProjectZoom(100, 1024);
  assert.ok(f);
  near(f.zoom, 10);
  assert.equal(f.centerSec, 50);
  const pf = planZoom({ requestedZoom: f.zoom, anchorSec: f.centerSec, totalDurationSec: 100, viewportWidth: 1024, bounds: BOUNDS });
  assert.equal(pf.scrollLeft, 0);
  assert.equal(fitProjectZoom(0, 1000), null);

  assert.deepEqual(spanOfClips([{ startSec: 4, durationSec: 2 }, { startSec: 1, durationSec: 1 }]), { startSec: 1, endSec: 6 });
  assert.equal(spanOfClips([]), null);
}

// --- rAF coalescing: a wheel burst is one zoom request per frame -----------
{
  let scheduled: Array<() => void> = [];
  let cancelled = 0;
  let storeZoom = 10;
  const applied: number[] = [];
  const co = createZoomCoalescer({
    schedule: (cb) => { scheduled.push(cb); return scheduled.length; },
    cancel: () => { cancelled++; },
    readZoom: () => storeZoom,
    apply: (z) => { applied.push(z); storeZoom = z; },
    bounds: BOUNDS,
  });
  co.push(1.1);
  co.push(1.1);
  co.push(1.1);
  assert.equal(scheduled.length, 1, 'one frame scheduled for the burst');
  near(co.pending() ?? 0, 10 * 1.1 ** 3);
  scheduled[0]();
  assert.equal(applied.length, 1);
  near(applied[0], 13.31);
  assert.equal(co.pending(), null);
  // Next burst starts from the committed zoom.
  scheduled = [];
  co.push(0.5);
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  near(applied[1], 13.31 * 0.5);
  // The pending target is clamped to the bounds while it accumulates.
  scheduled = [];
  for (let i = 0; i < 200; i++) co.push(2);
  assert.equal(co.pending(), 400);
  co.cancel();
  assert.equal(cancelled, 1);
  assert.equal(co.pending(), null);
  assert.throws(() => co.push(NaN), RangeError);
  assert.throws(() => co.push(0), RangeError);
}

// --- Wheel dispatch per profile ---------------------------------------------
{
  const base = { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  const lanes = { trackHeight: 100, min: 56, max: 260 };
  const td = WHEEL_PROFILES.thedaw;
  const rp = WHEEL_PROFILES.reaper;

  // theDAW: plain wheel zooms in (wheel up).
  const plain = wheelDispatch(base, td, 800, {}, lanes);
  assert.equal(plain.kind, 'zoom');
  assert.ok(plain.kind === 'zoom' && plain.factor > 1);
  // Ctrl = fine zoom: smaller step than plain.
  const fine = wheelDispatch({ ...base, ctrlKey: true }, td, 800, {}, lanes);
  assert.ok(fine.kind === 'zoom' && plain.kind === 'zoom' && fine.factor < plain.factor && fine.factor > 1);
  // Cmd counts as Ctrl.
  assert.deepEqual(wheelDispatch({ ...base, metaKey: true }, td, 800, {}, lanes), fine);
  // Speeds from prefs change the step.
  const fast = wheelDispatch(base, td, 800, { coarseSpeed: 0.004 }, lanes);
  assert.ok(fast.kind === 'zoom' && plain.kind === 'zoom' && fast.factor > plain.factor);
  // Shift = horizontal pan by the delta.
  assert.deepEqual(wheelDispatch({ ...base, shiftKey: true, deltaY: 120 }, td, 800, {}, lanes), { kind: 'scroll-x', px: 120 });
  // Alt = vertical pan.
  assert.deepEqual(wheelDispatch({ ...base, altKey: true, deltaY: 120 }, td, 800, {}, lanes), { kind: 'scroll-y', px: 120 });
  // Ctrl+Shift = lane height: wheel up by 100 px grows lanes by 25 px.
  assert.deepEqual(wheelDispatch({ ...base, ctrlKey: true, shiftKey: true }, td, 800, {}, lanes), { kind: 'lane-height', height: 125 });
  // Lane height clamps to the store bounds.
  assert.deepEqual(
    wheelDispatch({ ...base, ctrlKey: true, shiftKey: true, deltaY: 2000 }, td, 800, {}, lanes),
    { kind: 'lane-height', height: 56 },
  );
  // Lines mode (deltaMode 1) is scaled x16 before dispatch.
  assert.deepEqual(wheelDispatch({ ...base, shiftKey: true, deltaY: 3, deltaMode: 1 }, td, 800, {}, lanes), { kind: 'scroll-x', px: 48 });
  // A horizontal trackpad swipe pans time under any profile.
  assert.deepEqual(wheelDispatch({ ...base, deltaX: 40, deltaY: 5 }, rp, 800, {}, lanes), { kind: 'scroll-x', px: 40 });

  // REAPER: plain zooms, Ctrl = lane height, Alt = horizontal pan, Ctrl+Shift = fine zoom.
  assert.equal(wheelDispatch(base, rp, 800, {}, lanes).kind, 'zoom');
  assert.deepEqual(wheelDispatch({ ...base, ctrlKey: true }, rp, 800, {}, lanes), { kind: 'lane-height', height: 125 });
  assert.deepEqual(wheelDispatch({ ...base, altKey: true, deltaY: 60 }, rp, 800, {}, lanes), { kind: 'scroll-x', px: 60 });
  const rpFine = wheelDispatch({ ...base, ctrlKey: true, shiftKey: true }, rp, 800, {}, lanes);
  assert.ok(rpFine.kind === 'zoom' && plain.kind === 'zoom' && rpFine.factor < plain.factor);

  // No movement: nothing handled, so the caller does not preventDefault.
  assert.deepEqual(wheelDispatch({ ...base, deltaY: 0, shiftKey: true }, td, 800, {}, lanes), { kind: 'none' });
  assert.deepEqual(wheelDispatch({ ...base, deltaY: 0 }, td, 800, {}, lanes), { kind: 'none' });
  // Lane height already at the limit: nothing to do.
  assert.deepEqual(
    wheelDispatch({ ...base, ctrlKey: true, shiftKey: true }, td, 800, {}, { trackHeight: 260, min: 56, max: 260 }),
    { kind: 'none' },
  );
}

// --- Follow-playhead hold after a zoom --------------------------------------
{
  assert.equal(followHoldActive(1000, 1000 + ZOOM_FOLLOW_HOLD_MS), true);
  assert.equal(followHoldActive(1000 + ZOOM_FOLLOW_HOLD_MS, 1000 + ZOOM_FOLLOW_HOLD_MS), false);
  assert.equal(followHoldActive(5, 0), false);
}

// --- Grid window: visible range +-1 viewport, clamped to the content --------
{
  // zoom 10 px/s, viewport 1000 px scrolled to 2000: visible 200..300 s.
  assert.deepEqual(viewportWindowSec(2000, 1000, 10, 600), { startSec: 100, endSec: 400 });
  // At the start the window never goes negative.
  assert.deepEqual(viewportWindowSec(0, 1000, 10, 600), { startSec: 0, endSec: 200 });
  // At the end it stops at the content edge (max(total*zoom, 1000) / zoom).
  assert.deepEqual(viewportWindowSec(5000, 1000, 10, 600), { startSec: 400, endSec: 600 });
  // A short project still covers the min content width.
  assert.deepEqual(viewportWindowSec(0, 500, 1, 10), { startSec: 0, endSec: 1000 });
  assert.throws(() => viewportWindowSec(0, 500, 0, 10), RangeError);
}

// --- Ruler bar numbers -------------------------------------------------------
{
  // 120 bpm, 4/4: a bar is 2 s. At 12 px/s bars are 24 px apart: labelled.
  const labels = rulerBarLabels({ startSec: 0, endSec: 7, bpm: 120, zoom: 12 });
  assert.deepEqual(labels, [{ bar: 1, sec: 0 }, { bar: 2, sec: 2 }, { bar: 3, sec: 4 }, { bar: 4, sec: 6 }]);
  // 11 px/s: 22 px apart, too dense: none.
  assert.deepEqual(rulerBarLabels({ startSec: 0, endSec: 7, bpm: 120, zoom: 11 }), []);
  // Windowed: starts at the first bar inside the window.
  assert.deepEqual(rulerBarLabels({ startSec: 3, endSec: 6, bpm: 120, zoom: 50 }), [{ bar: 3, sec: 4 }, { bar: 4, sec: 6 }]);
  assert.throws(() => rulerBarLabels({ startSec: 0, endSec: 1, bpm: NaN, zoom: 10 }), RangeError);
}

// --- Clip chrome: header inside the visible part, off the resize zones -------
{
  // Clip 0..3000 px, scrolled to 2000 with a 1000-px viewport: header covers
  // the visible 2000..3000 minus the 6-px edge zone on each side.
  const l = clipChromeLayout(0, 3000, 2000, 1000);
  assert.deepEqual(l, { leftInClip: 2000 + CLIP_EDGE_ZONE_PX, width: 1000 - 2 * CLIP_EDGE_ZONE_PX, tier: 'full' });
  // Clip starting offscreen left, 100 px visible: compact.
  assert.equal(clipChromeLayout(-500, 600, 0, 1000)?.tier, 'compact');
  // Fully visible narrow clip: handle.
  const h = clipChromeLayout(100, 40, 0, 1000);
  assert.equal(h?.tier, 'handle');
  assert.equal(h?.leftInClip, CLIP_EDGE_ZONE_PX);
  // Offscreen clip: nothing.
  assert.equal(clipChromeLayout(5000, 100, 0, 1000), null);
}

console.log('timelineZoom: ok');
