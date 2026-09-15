/**
 * The arpeggiator face's short-dock layout, as pure numbers.
 *
 * The face's body is a grid of three columns between the toolbar and the
 * keyboard strip. When the centre column would be shorter than the full chord
 * progression needs, the face goes compact: the body's vertical padding drops
 * to 4px, every section goes dense, and the degree keys drop to 13px.
 *
 * The switch reads the BODY's height. The body is `flex-1` between two rows of
 * fixed height, so the compact form cannot change it, and the column height the
 * full form would have follows from it. Reading the column itself flaps:
 * compact's thinner padding makes the column 8px taller, which can lift it back
 * over the threshold, and the full form then drops it under again, every frame.
 */

/** The body's vertical padding in the full form (`p-2`: 8px top and bottom). */
export const ARP_BODY_PAD_Y_FULL = 16;
/** The body's vertical padding in the compact form (`py-1`: 4px top and bottom). */
export const ARP_BODY_PAD_Y_COMPACT = 8;
/**
 * The full form's centre column content, measured at 12px: the progression
 * section (42px of chrome, seven 24px keys with six 4px gaps), an 8px gap and
 * the output section.
 */
export const PROGRESSION_FULL_PX = 311;

/** The centre column's height for a body of `bodyHeight`, in the given form. */
export function arpColumnHeight(bodyHeight: number, compact: boolean): number {
  return bodyHeight - (compact ? ARP_BODY_PAD_Y_COMPACT : ARP_BODY_PAD_Y_FULL);
}

/** Compact iff the full form's centre column would be too short for the full progression. */
export function arpCompact(bodyHeight: number): boolean {
  return arpColumnHeight(bodyHeight, false) < PROGRESSION_FULL_PX;
}

/** One panel of a scrolling column: its top and height inside the scroll content, and its title. */
export interface PanelBox {
  top: number;
  height: number;
  title: string;
}

/**
 * The whole rows of a grid that fit `room` px, and the grid height that shows
 * exactly those rows with no part of the next one (the STYLE thumbnails). A grid
 * with fewer rows than fit takes their height; at least one row always shows.
 */
export function wholeRows(room: number, rowHeight: number, gap: number, totalRows: number): { rows: number; height: number } {
  if (!(rowHeight > 0) || totalRows <= 0) return { rows: 0, height: 0 };
  const fit = Math.max(1, Math.floor((room + gap + 0.01) / (rowHeight + gap)));
  const rows = Math.min(fit, totalRows);
  return { rows, height: rows * rowHeight + (rows - 1) * gap };
}

/**
 * The row a grid's scroll cue pages to: `visibleRows - 1` rows on (one row stays
 * in view for context, never less than one row), from the row nearest the
 * current scroll position, clamped to the first row and to the last row that can
 * sit at the top. `step` is one row plus its gap.
 */
export function rowPage(scrollTop: number, step: number, visibleRows: number, totalRows: number, dir: 1 | -1): number {
  if (!(step > 0)) return 0;
  const last = Math.max(0, totalRows - visibleRows);
  const at = Math.min(last, Math.max(0, Math.round(scrollTop / step)));
  return Math.min(last, Math.max(0, at + dir * Math.max(1, visibleRows - 1)));
}

/** The height of a column's scroll cue band, and of the column's scroll padding (ArpeggiatorPanel `h-3`, `scroll-pt-3`). */
export const COLUMN_CUE_PX = 12;

/**
 * Where a column's scroll cue takes it, or null when there is nothing more that way.
 *
 * A panel "at the top" sits `pad` px below the column's top edge, clear of the
 * up cue's band; pass the column's scroll padding. Down goes to the next panel
 * below the current scroll position, clamped to the end of the scroll range (a
 * last panel shorter than the column then sits whole at its foot); inside a last
 * panel taller than the column it pages down. Up goes to the panel the column is
 * inside, or the one above it.
 */
export function panelStep(
  panels: PanelBox[],
  view: { scrollTop: number; clientHeight: number; scrollHeight: number },
  dir: 1 | -1,
  pad = 0,
): { top: number; title: string } | null {
  const max = Math.max(0, view.scrollHeight - view.clientHeight);
  if (max <= 1 || panels.length === 0) return null;
  const at = view.scrollTop;
  const snap = (p: PanelBox) => Math.max(0, p.top - pad);
  if (dir === 1) {
    if (at >= max - 1) return null;
    const next = panels.find((p) => snap(p) > at + 1);
    if (next) return { top: Math.min(snap(next), max), title: next.title };
    const current = [...panels].reverse().find((p) => snap(p) <= at + 1) ?? panels[panels.length - 1];
    return { top: Math.min(at + Math.max(24, view.clientHeight - 28), max), title: current.title };
  }
  if (at <= 1) return null;
  const prev = [...panels].reverse().find((p) => snap(p) < at - 1);
  return prev ? { top: snap(prev), title: prev.title } : { top: 0, title: panels[0].title };
}
