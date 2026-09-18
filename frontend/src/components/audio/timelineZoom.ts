/**
 * Pure glue between the EDIT timeline (WaveformEditor) and lib/timeline/viewport:
 * the one zoom request every entry point goes through, the fit helpers, the
 * rAF coalescer for wheel bursts, the wheel -> action dispatch, the grid window,
 * ruler bar labels and the clip-chrome layout.
 *
 * DOM-free, React-free, store-free. Units:
 *  - `*Sec` values are seconds on the arrangement timeline;
 *  - widths, scroll offsets and clip rects are LOCAL CSS px (the space
 *    scrollLeft, clientWidth and style widths live in);
 *  - `rectWidthPx` / `headerColumnPx` are VIEWPORT px (getBoundingClientRect),
 *    divided by the cumulative CSS `layoutZoom` to reach local px;
 *  - `zoom` is px per second (local px).
 */
import {
  clipChromeTier,
  visibleClipHeader,
  wheelIntent,
  zoomAtMarker,
  type WheelProfile,
} from '../../lib/timeline/viewport';

/** The editor never lays the lanes out narrower than this (local px). */
export const MIN_CONTENT_WIDTH_PX = 1000;
/** Toolbar buttons and +/- keys multiply or divide px/s by this. */
export const ZOOM_STEP_FACTOR = 1.25;
/** Zoom to selection leaves this fraction of the range as margin on each side. */
export const FIT_MARGIN_FRAC = 0.05;
/** Width (local px) of each clip's resize-handle zone the header must leave free. */
export const CLIP_EDGE_ZONE_PX = 6;
/** Bar numbers show on the ruler once bars are at least this far apart (local px). */
export const RULER_BAR_LABEL_MIN_PX = 24;
/** Follow-playhead paging holds off this long (ms) after the last zoom. */
export const ZOOM_FOLLOW_HOLD_MS = 400;

function finite(v: number, name: string): number {
  if (!Number.isFinite(v)) throw new RangeError(`${name} must be finite, got ${v}`);
  return v;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * The scroller's visible width in LOCAL px: its on-screen width (viewport px)
 * minus any track-header column the measured box includes (viewport px), divided
 * by the cumulative CSS zoom. Never negative.
 */
export function localViewportWidth(a: { rectWidthPx: number; layoutZoom: number; headerColumnPx?: number }): number {
  finite(a.rectWidthPx, 'rectWidthPx');
  finite(a.layoutZoom, 'layoutZoom');
  const header = finite(a.headerColumnPx ?? 0, 'headerColumnPx');
  if (a.layoutZoom <= 0) throw new RangeError('layoutZoom must be > 0');
  return Math.max(0, (a.rectWidthPx - header) / a.layoutZoom);
}

/** Lanes content width in local px: max(total * zoom, MIN_CONTENT_WIDTH_PX). */
export function contentWidthPx(totalDurationSec: number, zoom: number): number {
  return Math.max(finite(totalDurationSec, 'totalDurationSec') * finite(zoom, 'zoom'), MIN_CONTENT_WIDTH_PX);
}

/** What a zoom keeps fixed: the edit cursor (default) or an explicit time. */
export type ZoomAnchor = 'edit-cursor' | { sec: number };

/** The anchor time in seconds, clamped into [0, totalDurationSec]. */
export function resolveAnchorSec(anchor: ZoomAnchor, editCursorSec: number, totalDurationSec: number): number {
  const sec = anchor === 'edit-cursor' ? finite(editCursorSec, 'editCursorSec') : finite(anchor.sec, 'anchor.sec');
  return clamp(sec, 0, Math.max(0, finite(totalDurationSec, 'totalDurationSec')));
}

/**
 * Zoom to `requestedZoom` (clamped to `bounds`) with `anchorSec` centred in the
 * viewport, scroll clamped to the real content ({@link contentWidthPx}), so
 * near either end the anchor cannot be centred. Returns local px.
 */
export function planZoom(a: {
  requestedZoom: number;
  anchorSec: number;
  totalDurationSec: number;
  viewportWidth: number;
  bounds: { min: number; max: number };
}): { zoom: number; scrollLeft: number } {
  const zoom = clamp(finite(a.requestedZoom, 'requestedZoom'), a.bounds.min, a.bounds.max);
  // zoomAtMarker sizes the content as duration * zoom; widen the duration so
  // that equals the editor's min-width rule at the zoom it will use.
  const contentDurationSec = contentWidthPx(Math.max(0, a.totalDurationSec), zoom) / zoom;
  return zoomAtMarker(
    { zoom, scrollLeft: 0, viewportWidth: a.viewportWidth, contentDurationSec },
    zoom,
    a.anchorSec,
    a.bounds,
  );
}

/**
 * The zoom that fits [startSec, endSec] in `viewportWidth` local px with
 * `marginFrac` of the range as margin on each side, and the range's centre
 * (the anchor). Null for an empty or inverted range.
 */
export function fitRangeZoom(
  startSec: number,
  endSec: number,
  viewportWidth: number,
  marginFrac: number = FIT_MARGIN_FRAC,
): { zoom: number; centerSec: number } | null {
  finite(startSec, 'startSec');
  finite(endSec, 'endSec');
  finite(viewportWidth, 'viewportWidth');
  finite(marginFrac, 'marginFrac');
  if (endSec <= startSec || viewportWidth <= 0 || marginFrac < 0) return null;
  const dur = endSec - startSec;
  return { zoom: viewportWidth / (dur * (1 + 2 * marginFrac)), centerSec: startSec + dur / 2 };
}

/**
 * Zoom to fit the whole arrangement: px/s = max(200, viewport - 24) / duration
 * (the editor's long-standing rule), anchored on the project's centre so the
 * clamp lands at scrollLeft 0. Null for an empty project.
 */
export function fitProjectZoom(totalDurationSec: number, viewportWidth: number): { zoom: number; centerSec: number } | null {
  finite(totalDurationSec, 'totalDurationSec');
  finite(viewportWidth, 'viewportWidth');
  if (totalDurationSec <= 0) return null;
  return { zoom: Math.max(200, viewportWidth - 24) / totalDurationSec, centerSec: totalDurationSec / 2 };
}

/** The time span covering every clip (seconds), or null for none. */
export function spanOfClips(clips: readonly { startSec: number; durationSec: number }[]): { startSec: number; endSec: number } | null {
  if (clips.length === 0) return null;
  let startSec = Infinity;
  let endSec = -Infinity;
  for (const c of clips) {
    startSec = Math.min(startSec, finite(c.startSec, 'startSec'));
    endSec = Math.max(endSec, c.startSec + finite(c.durationSec, 'durationSec'));
  }
  return { startSec, endSec };
}

export interface ZoomCoalescer {
  /** Multiply the pending target zoom by `factor`; schedules one flush per frame. */
  push(factor: number): void;
  /** Drop the pending target and its scheduled flush. */
  cancel(): void;
  /** The target zoom (px/s) the next flush applies, or null. */
  pending(): number | null;
}

/**
 * Coalesce a burst of wheel-zoom factors into ONE zoom request per frame. The
 * first push reads the committed zoom; later pushes in the same frame multiply
 * the pending target (clamped to `bounds`); the scheduled flush hands the
 * target to `apply` once. `schedule`/`cancel` are requestAnimationFrame and
 * cancelAnimationFrame in the editor.
 */
export function createZoomCoalescer(deps: {
  schedule: (cb: () => void) => number;
  cancel: (id: number) => void;
  readZoom: () => number;
  apply: (zoom: number) => void;
  bounds: { min: number; max: number };
}): ZoomCoalescer {
  let target: number | null = null;
  let frame: number | null = null;
  const flush = () => {
    frame = null;
    const z = target;
    target = null;
    if (z !== null) deps.apply(z);
  };
  return {
    push(factor) {
      finite(factor, 'factor');
      if (factor <= 0) throw new RangeError('factor must be > 0');
      const base = target ?? deps.readZoom();
      target = clamp(base * factor, deps.bounds.min, deps.bounds.max);
      if (frame === null) frame = deps.schedule(flush);
    },
    cancel() {
      if (frame !== null) deps.cancel(frame);
      frame = null;
      target = null;
    },
    pending: () => target,
  };
}

/** What the editor does with one wheel event. `none` = not handled (no preventDefault). */
export type WheelDispatch =
  | { kind: 'none' }
  | { kind: 'zoom'; factor: number }
  | { kind: 'scroll-x'; px: number }
  | { kind: 'scroll-y'; px: number }
  | { kind: 'lane-height'; height: number };

/**
 * Resolve a wheel event under `profile` (lib/timeline/viewport wheelIntent) into
 * an editor action. Lane resize moves the height by a quarter of the wheel
 * delta (wheel up grows), clamped to [lanes.min, lanes.max]; a no-op movement
 * (zero delta, height already at the limit) is `none`.
 */
export function wheelDispatch(
  e: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean },
  profile: WheelProfile,
  pageHeightPx: number,
  speeds: { coarseSpeed?: number; fineSpeed?: number },
  lanes: { trackHeight: number; min: number; max: number },
): WheelDispatch {
  const intent = wheelIntent(e, profile, pageHeightPx, speeds);
  switch (intent.action) {
    case 'zoom-time':
    case 'zoom-time-fine':
      return intent.zoomFactor === 1 ? { kind: 'none' } : { kind: 'zoom', factor: intent.zoomFactor };
    case 'pan-time':
      return intent.panPx === 0 ? { kind: 'none' } : { kind: 'scroll-x', px: intent.panPx };
    case 'pan-lanes':
      return intent.panPx === 0 ? { kind: 'none' } : { kind: 'scroll-y', px: intent.panPx };
    case 'resize-lanes': {
      finite(lanes.trackHeight, 'trackHeight');
      const height = clamp(lanes.trackHeight + intent.lanePx / 4, lanes.min, lanes.max);
      return height === lanes.trackHeight ? { kind: 'none' } : { kind: 'lane-height', height };
    }
    case 'none':
      return { kind: 'none' };
  }
}

/** True while follow-playhead paging should hold off (`nowMs` < `holdUntilMs`). */
export function followHoldActive(nowMs: number, holdUntilMs: number): boolean {
  return finite(nowMs, 'nowMs') < finite(holdUntilMs, 'holdUntilMs');
}

/**
 * The seconds window the grid and ruler labels draw: the visible range
 * extended by one viewport on each side, clamped to [0, content end] where the
 * content end is {@link contentWidthPx} / zoom.
 */
export function viewportWindowSec(
  scrollLeft: number,
  viewportWidth: number,
  zoom: number,
  totalDurationSec: number,
): { startSec: number; endSec: number } {
  finite(scrollLeft, 'scrollLeft');
  finite(viewportWidth, 'viewportWidth');
  if (!(finite(zoom, 'zoom') > 0)) throw new RangeError('zoom must be > 0');
  const contentEndSec = contentWidthPx(Math.max(0, totalDurationSec), zoom) / zoom;
  const startSec = clamp((scrollLeft - viewportWidth) / zoom, 0, contentEndSec);
  const endSec = clamp((scrollLeft + 2 * viewportWidth) / zoom, startSec, contentEndSec);
  return { startSec, endSec };
}

/**
 * Bar numbers (1-based) for the ruler inside [startSec, endSec], at constant
 * tempo from 0 s. Empty when bars sit closer than `minPx` local px.
 */
export function rulerBarLabels(a: {
  startSec: number;
  endSec: number;
  bpm: number;
  zoom: number;
  beatsPerBar?: number;
  minPx?: number;
}): { bar: number; sec: number }[] {
  finite(a.startSec, 'startSec');
  finite(a.endSec, 'endSec');
  finite(a.bpm, 'bpm');
  finite(a.zoom, 'zoom');
  const beatsPerBar = finite(a.beatsPerBar ?? 4, 'beatsPerBar');
  const minPx = finite(a.minPx ?? RULER_BAR_LABEL_MIN_PX, 'minPx');
  if (a.bpm <= 0 || a.zoom <= 0 || beatsPerBar <= 0) throw new RangeError('bpm, zoom and beatsPerBar must be > 0');
  const barSec = (60 / a.bpm) * beatsPerBar;
  if (barSec * a.zoom < minPx || a.endSec < a.startSec) return [];
  const out: { bar: number; sec: number }[] = [];
  const first = Math.max(0, Math.ceil(a.startSec / barSec - 1e-9));
  for (let i = first; i * barSec <= a.endSec + 1e-9; i++) out.push({ bar: i + 1, sec: i * barSec });
  return out;
}

/**
 * Where a clip's header strip goes (relative to the clip's left edge, local
 * px) so it stays inside the visible part of the clip and clear of the
 * {@link CLIP_EDGE_ZONE_PX} resize zones, plus the chrome tier its visible
 * width affords. Null when the clip is entirely offscreen.
 */
export function clipChromeLayout(
  clipLeftPx: number,
  clipWidthPx: number,
  scrollLeft: number,
  viewportWidth: number,
): { leftInClip: number; width: number; tier: 'full' | 'compact' | 'handle' } | null {
  const header = visibleClipHeader(clipLeftPx, clipWidthPx, scrollLeft, viewportWidth, CLIP_EDGE_ZONE_PX);
  if (!header) return null;
  const visibleWidth = Math.min(clipLeftPx + clipWidthPx, scrollLeft + viewportWidth) - Math.max(clipLeftPx, scrollLeft);
  return { ...header, tier: clipChromeTier(visibleWidth) };
}
