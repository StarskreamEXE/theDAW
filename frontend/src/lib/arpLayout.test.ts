import assert from 'node:assert/strict';
import {
  ARP_BODY_PAD_Y_COMPACT,
  ARP_BODY_PAD_Y_FULL,
  COLUMN_CUE_PX,
  PROGRESSION_FULL_PX,
  arpColumnHeight,
  arpCompact,
  panelStep,
  rowPage,
  wholeRows,
} from './arpLayout.ts';

// The switch, replayed the way the page runs it: measure, render the chosen
// form, measure again. The body keeps its height across forms, so the second
// and every later measurement agree with the first.
{
  for (let body = PROGRESSION_FULL_PX - 20; body <= PROGRESSION_FULL_PX + 40; body += 1) {
    let compact = false;
    const seen: boolean[] = [];
    for (let frame = 0; frame < 8; frame += 1) {
      compact = arpCompact(body);
      seen.push(compact);
    }
    assert.ok(seen.every((v) => v === seen[0]), `body ${body} flipped: ${seen.join(',')}`);
  }
}

// The column-reading rule this replaces flapped in an 8px band: compact's
// padding lifts the column over the threshold and the full form drops it back.
{
  const oldRule = (column: number) => column < PROGRESSION_FULL_PX;
  const body = PROGRESSION_FULL_PX + ARP_BODY_PAD_Y_FULL - 4;
  let compact = false;
  const flips: boolean[] = [];
  for (let frame = 0; frame < 4; frame += 1) {
    compact = oldRule(arpColumnHeight(body, compact));
    flips.push(compact);
  }
  assert.deepEqual(flips, [true, false, true, false]);
  // The body rule settles on compact at the same height.
  assert.equal(arpCompact(body), true);
}

// A resize sequence: compact, taller, shorter, each followed by a second measurement.
{
  const steps: Array<[number, boolean]> = [
    [320, true],
    [320, true],
    [PROGRESSION_FULL_PX + ARP_BODY_PAD_Y_FULL, false],
    [PROGRESSION_FULL_PX + ARP_BODY_PAD_Y_FULL, false],
    [PROGRESSION_FULL_PX + ARP_BODY_PAD_Y_FULL - 1, true],
    [PROGRESSION_FULL_PX + ARP_BODY_PAD_Y_FULL - 1, true],
    [148, true],
  ];
  for (const [body, want] of steps) assert.equal(arpCompact(body), want, `body ${body}`);
  // Full form always has room for the full progression; compact gains 8px of column.
  const full = PROGRESSION_FULL_PX + ARP_BODY_PAD_Y_FULL;
  assert.ok(arpColumnHeight(full, false) >= PROGRESSION_FULL_PX);
  assert.equal(arpColumnHeight(300, true) - arpColumnHeight(300, false), ARP_BODY_PAD_Y_FULL - ARP_BODY_PAD_Y_COMPACT);
}

// The left column at a default-height dock: TONIC (120px), an 8px gap, MODE (213px) in 132px.
{
  const panels = [
    { top: 0, height: 120, title: 'Tonic / root' },
    { top: 128, height: 213, title: 'Mode' },
  ];
  const view = { clientHeight: 132, scrollHeight: 341 };
  // At the top: nothing above, MODE below.
  assert.equal(panelStep(panels, { ...view, scrollTop: 0 }, -1), null);
  assert.deepEqual(panelStep(panels, { ...view, scrollTop: 0 }, 1), { top: 128, title: 'Mode' });
  // At MODE's top: up returns to TONIC, down pages through MODE.
  assert.deepEqual(panelStep(panels, { ...view, scrollTop: 128 }, -1), { top: 0, title: 'Tonic / root' });
  assert.deepEqual(panelStep(panels, { ...view, scrollTop: 128 }, 1), { top: 209, title: 'Mode' });
  // At the end: nothing below; up goes to MODE's top.
  assert.equal(panelStep(panels, { ...view, scrollTop: 209 }, 1), null);
  assert.deepEqual(panelStep(panels, { ...view, scrollTop: 209 }, -1), { top: 128, title: 'Mode' });
}

// The centre column: the progression (127px), an 8px gap, OUTPUT (58px) in 132px.
// OUTPUT's top is past the end of the range, so down lands at the end, OUTPUT whole at the foot.
{
  const panels = [
    { top: 0, height: 127, title: 'Chord progression' },
    { top: 135, height: 58, title: 'Output' },
  ];
  const view = { clientHeight: 132, scrollHeight: 193 };
  assert.deepEqual(panelStep(panels, { ...view, scrollTop: 0 }, 1), { top: 61, title: 'Output' });
  assert.equal(panelStep(panels, { ...view, scrollTop: 61 }, 1), null);
  assert.deepEqual(panelStep(panels, { ...view, scrollTop: 61 }, -1), { top: 0, title: 'Chord progression' });
}

// With the cue's scroll padding: a panel at the top sits COLUMN_CUE_PX below the column's
// top, clear of the up cue. The 1920x1080 left column, where MODE is taller than the column:
// two downs reach the end of the range, and two ups come back.
{
  const pad = COLUMN_CUE_PX;
  const panels = [
    { top: 0, height: 118.5, title: 'Tonic / root' },
    { top: 126.4, height: 211.1, title: 'Mode' },
  ];
  const view = { clientHeight: 132, scrollHeight: 339 };
  const max = view.scrollHeight - view.clientHeight;
  const first = panelStep(panels, { ...view, scrollTop: 0 }, 1, pad);
  assert.deepEqual(first, { top: 126.4 - pad, title: 'Mode' });
  const second = panelStep(panels, { ...view, scrollTop: first!.top }, 1, pad);
  assert.deepEqual(second, { top: max, title: 'Mode' });
  assert.equal(panelStep(panels, { ...view, scrollTop: max }, 1, pad), null);
  assert.deepEqual(panelStep(panels, { ...view, scrollTop: max }, -1, pad), { top: 126.4 - pad, title: 'Mode' });
  assert.deepEqual(panelStep(panels, { ...view, scrollTop: 126.4 - pad }, -1, pad), { top: 0, title: 'Tonic / root' });
  // A first panel never asks for a negative scroll.
  assert.equal(panelStep(panels, { ...view, scrollTop: 40 }, -1, pad)!.top, 0);
}

// The centre column with the padding: OUTPUT's padded top is still past the range, so down lands at the end.
{
  const panels = [
    { top: 0, height: 123, title: 'Chord progression' },
    { top: 131, height: 58, title: 'Output' },
  ];
  const view = { clientHeight: 132, scrollHeight: 190 };
  assert.deepEqual(panelStep(panels, { ...view, scrollTop: 0 }, 1, COLUMN_CUE_PX), { top: 58, title: 'Output' });
  assert.deepEqual(panelStep(panels, { ...view, scrollTop: 58 }, -1, COLUMN_CUE_PX), { top: 0, title: 'Chord progression' });
}

// The STYLE grid shows whole rows only: 720 thumbnails in 6 columns, rows 22.1px with 4px gaps, in 106px.
{
  assert.deepEqual(wholeRows(106, 22.1, 4, 120), { rows: 4, height: 4 * 22.1 + 3 * 4 });
  // Exactly four rows of room still holds four.
  assert.equal(wholeRows(4 * 22.1 + 3 * 4, 22.1, 4, 120).rows, 4);
  // A pixel short of four rows holds three.
  assert.equal(wholeRows(4 * 22.1 + 3 * 4 - 1, 22.1, 4, 120).rows, 3);
  // Fewer rows than fit: the grid takes their height.
  assert.deepEqual(wholeRows(106, 22, 4, 1), { rows: 1, height: 22 });
  // A panel too short for one row still shows one.
  assert.deepEqual(wholeRows(10, 22, 4, 120), { rows: 1, height: 22 });
  // Not measured yet.
  assert.deepEqual(wholeRows(106, 0, 4, 120), { rows: 0, height: 0 });
  assert.deepEqual(wholeRows(106, 22, 4, 0), { rows: 0, height: 0 });
}

// The STYLE cues page by all but one of the visible rows and stop at both ends.
{
  const step = 26.1;
  assert.equal(rowPage(0, step, 4, 120, 1), 3);
  assert.equal(rowPage(3 * step, step, 4, 120, 1), 6);
  // A scroll position a fraction off a row reads as that row.
  assert.equal(rowPage(3 * step + 0.4, step, 4, 120, 1), 6);
  assert.equal(rowPage(0, step, 4, 120, -1), 0);
  // One visible row still moves one row.
  assert.equal(rowPage(0, step, 1, 120, 1), 1);
  // Replay the presses: down until the end, where the last four rows sit whole, then up to the start.
  let row = 0;
  const downs: number[] = [];
  for (let i = 0; i < 60; i += 1) {
    row = rowPage(row * step, step, 4, 120, 1);
    downs.push(row);
  }
  assert.equal(row, 116);
  assert.ok(downs.every((r) => Number.isInteger(r) && r >= 0 && r <= 116));
  assert.equal(rowPage(116 * step, step, 4, 120, 1), 116);
  for (let i = 0; i < 60; i += 1) row = rowPage(row * step, step, 4, 120, -1);
  assert.equal(row, 0);
  // A grid that holds every row has nowhere to go.
  assert.equal(rowPage(0, step, 4, 3, 1), 0);
  assert.equal(rowPage(0, 0, 4, 120, 1), 0);
}

// A column with room for everything shows no cue either way.
{
  const panels = [{ top: 0, height: 100, title: 'Chord progression' }];
  assert.equal(panelStep(panels, { scrollTop: 0, clientHeight: 300, scrollHeight: 300 }, 1), null);
  assert.equal(panelStep(panels, { scrollTop: 0, clientHeight: 300, scrollHeight: 300 }, -1), null);
  assert.equal(panelStep([], { scrollTop: 0, clientHeight: 100, scrollHeight: 300 }, 1), null);
}

console.log('arpLayout: all assertions passed');
