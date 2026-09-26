/**
 * DJ-3 — "its not intuitive to start" / "i dont see cue points".
 *
 * Two separate holes, both covered here:
 *
 *  A. STARTING.  The only one-click way into a DJ set was a 12-pixel ▶ hidden
 *     inside the Source Tree's "Sets" group; the `Automix` chip silently
 *     refused (and un-toggled itself) whenever the active set had fewer than
 *     two registered ids. `startAutoDjState` is the decision behind the new
 *     header button — what it says, whether it starts, and the exact reason
 *     it cannot — and `StartAutoDjButton` / `DjStartHint` / `DjSetRow` are the
 *     markup, rendered here with `renderToStaticMarkup` so the a11y contract
 *     (real `<button>`, `aria-label`, `aria-disabled` + the reason in
 *     `title`) is pinned rather than eyeballed.
 *
 *  B. CUES.  `djCuesStore` had no writer that was not a user keypress, so
 *     nothing ever appeared on the pads or the waveform. `seedCues` is the
 *     new one — and the entire risk of an automatic writer is that it
 *     overwrites the user, so most of the store tests below are about what it
 *     refuses to do.
 *
 * Also pinned as source assertions (behavior that lives inside a 3,500-line
 * component and cannot be reached without the whole DJ engine):
 *   - both deck-load effects depend on `libLookupVersion`, the fix for a
 *     Send-to-DJ / bundled-set track silently leaving its deck empty;
 *   - `setlistStore.registerBundled` queues analysis for the ids it filled.
 *
 * Run: `npx tsx src/views/DJView.dj3.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// zustand's `persist` resolves `window.localStorage` once, at
// module-evaluation time, so jsdom has to be a real global BEFORE
// djCuesStore is imported. It is uninstalled again immediately after:
// DJView.tsx transitively imports `state/playerStore.ts`, whose module body
// runs `if (typeof window !== 'undefined' && import.meta.env.DEV)` — under
// plain tsx there is no `import.meta.env`, so a defined `window` makes that
// line throw. playerStore.ts is outside this ticket's write set, so the
// environment is arranged around it. `renderToStaticMarkup` needs no DOM.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.localStorage = dom.window.localStorage;

const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { useDjCuesStore, HOTCUE_SLOTS } = await import('../state/djCuesStore');

delete g.window;

const { startAutoDjState, StartAutoDjButton, DjStartHint, DjSetRow, beatMarkPositions } =
  await import('./DJView');

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok ${name}`);
};

const render = (el: React.ReactElement): string => renderToStaticMarkup(el);
const resetCues = () => useDjCuesStore.setState({ byEntry: {}, seeded: {}, userTouched: {} }, false);

/* ══════════════════════ A. starting a set ══════════════════════ */

console.log('DJ-3 · start flow');

test('with a playable active set the button starts', () => {
  const s = startAutoDjState({ setCount: 3, hasActiveSet: true, playableCount: 5, automixOn: false });
  assert.equal(s.label, 'START AUTO DJ');
  assert.equal(s.enabled, true);
  assert.equal(s.intent, 'start');
  assert.equal(s.reason, null);
});

test('while running it offers to stop, and stays enabled', () => {
  const s = startAutoDjState({ setCount: 3, hasActiveSet: true, playableCount: 5, automixOn: true });
  assert.equal(s.label, 'STOP AUTO DJ');
  assert.equal(s.enabled, true);
  assert.equal(s.intent, 'stop');
  assert.equal(s.reason, null);
});

test('no sets at all → "Create a set first", and the click creates one', () => {
  const s = startAutoDjState({ setCount: 0, hasActiveSet: false, playableCount: 0, automixOn: false });
  assert.equal(s.enabled, false);
  assert.equal(s.reason, 'Create a set first');
  assert.equal(s.intent, 'create-set');
});

test('sets exist but none active → "Pick a set below"', () => {
  const s = startAutoDjState({ setCount: 2, hasActiveSet: false, playableCount: 0, automixOn: false });
  assert.equal(s.enabled, false);
  assert.equal(s.reason, 'Pick a set below');
  assert.equal(s.intent, 'pick-set');
});

test('active set with fewer than 2 tracks names that, not something vague', () => {
  for (const playableCount of [0, 1]) {
    const s = startAutoDjState({ setCount: 2, hasActiveSet: true, playableCount, automixOn: false });
    assert.equal(s.enabled, false);
    assert.equal(s.intent, 'add-tracks');
    assert.match(s.reason ?? '', /2 tracks/);
  }
  // Exactly two is the threshold the automix sequencer itself uses.
  assert.equal(
    startAutoDjState({ setCount: 2, hasActiveSet: true, playableCount: 2, automixOn: false }).enabled,
    true,
  );
});

test('a running automix can still be stopped from an emptied set', () => {
  // The set was edited down to one track mid-show: the button must not turn
  // into "Add at least 2 tracks" while the mix is audibly still running.
  const s = startAutoDjState({ setCount: 1, hasActiveSet: true, playableCount: 1, automixOn: true });
  assert.equal(s.intent, 'stop');
  assert.equal(s.enabled, true);
});

console.log('DJ-3 · start button markup');

test('it is a real button with a label, not a styled div', () => {
  const html = render(
    React.createElement(StartAutoDjButton, {
      state: startAutoDjState({ setCount: 1, hasActiveSet: true, playableCount: 4, automixOn: false }),
      onActivate: () => {},
    }),
  );
  assert.match(html, /^<button/);
  assert.match(html, /type="button"/);
  assert.match(html, /aria-label="Start Auto DJ"/);
  assert.match(html, /START AUTO DJ/);
  assert.doesNotMatch(html, /aria-disabled="true"/);
});

test('running state renames the button and its label', () => {
  const html = render(
    React.createElement(StartAutoDjButton, {
      state: startAutoDjState({ setCount: 1, hasActiveSet: true, playableCount: 4, automixOn: true }),
      onActivate: () => {},
    }),
  );
  assert.match(html, /aria-label="Stop Auto DJ"/);
  assert.match(html, /STOP AUTO DJ/);
});

test('every blocked state carries aria-disabled AND the reason in title', () => {
  const blocked = [
    { setCount: 0, hasActiveSet: false, playableCount: 0, automixOn: false, reason: 'Create a set first' },
    { setCount: 2, hasActiveSet: false, playableCount: 0, automixOn: false, reason: 'Pick a set below' },
    { setCount: 2, hasActiveSet: true, playableCount: 1, automixOn: false, reason: null },
  ];
  for (const b of blocked) {
    const state = startAutoDjState(b);
    const html = render(React.createElement(StartAutoDjButton, { state, onActivate: () => {} }));
    assert.match(html, /aria-disabled="true"/, JSON.stringify(b));
    assert.match(html, new RegExp(`title="[^"]*${state.reason}`), JSON.stringify(b));
    // Never the `disabled` attribute: browsers drop a disabled control from
    // tab order and suppress its tooltip, so the reason would never be read.
    assert.doesNotMatch(html, /\sdisabled(=|\s|>)/, JSON.stringify(b));
  }
});

console.log('DJ-3 · onboarding hint');

test('the hint names all three ways in, in order', () => {
  const html = render(React.createElement(DjStartHint, {}));
  const text = html.replace(/<[^>]+>/g, ' ');
  assert.match(text, /Pick a set/i);
  assert.match(text, /START AUTO DJ/);
  assert.match(text, /drag a track/i);
  // Three lines, not a wall of prose.
  assert.equal((html.match(/data-dj-hint-line/g) ?? []).length, 3);
});

test('the hint is inert decoration — no controls to tab through', () => {
  const html = render(React.createElement(DjStartHint, {}));
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /<input/);
});

console.log('DJ-3 · set rows');

const rowProps = {
  name: 'Warehouse 2am',
  count: 9,
  isActive: false,
  playable: true,
  busy: false,
  onOpen: () => {},
  onPlay: () => {},
};

test('the active row is marked with a persistent ACTIVE badge', () => {
  const off = render(React.createElement(DjSetRow, rowProps));
  const on = render(React.createElement(DjSetRow, { ...rowProps, isActive: true }));
  assert.doesNotMatch(off, /ACTIVE/);
  assert.match(on, /ACTIVE/);
  // A badge, not a colour the user has to infer.
  assert.match(on, /aria-current="true"/);
});

test('a registering row shows a busy indicator and blocks a second click', () => {
  const idle = render(React.createElement(DjSetRow, rowProps));
  const busy = render(React.createElement(DjSetRow, { ...rowProps, busy: true }));
  assert.doesNotMatch(idle, /aria-busy="true"/);
  assert.match(busy, /aria-busy="true"/);
  // Both the name and the ▶ refuse while a register is in flight — two fast
  // clicks used to POST /register twice.
  assert.equal((busy.match(/aria-disabled="true"/g) ?? []).length, 2);
});

test('an unplayable row explains itself instead of doing nothing', () => {
  const html = render(React.createElement(DjSetRow, { ...rowProps, playable: false }));
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /title="[^"]*2 tracks/);
  assert.match(html, /aria-label="Play set Warehouse 2am with Auto-DJ"/);
});

test('both row controls are real buttons', () => {
  const html = render(React.createElement(DjSetRow, rowProps));
  assert.equal((html.match(/<button/g) ?? []).length, 2);
});

/* ══════════════════════ B. cue points ══════════════════════ */

console.log('DJ-3 · seeded cues');

test('seedCues fills an untouched track', () => {
  resetCues();
  useDjCuesStore.getState().seedCues('t1', [1, 33, 65, 97]);
  assert.deepEqual(useDjCuesStore.getState().cuesFor('t1'), [1, 33, 65, 97]);
  assert.equal(useDjCuesStore.getState().seeded.t1, true);
});

test('seedCues never overwrites a cue the user placed', () => {
  resetCues();
  useDjCuesStore.getState().setCue('t2', 1, 12.5);
  useDjCuesStore.getState().seedCues('t2', [1, 33, 65, 97]);
  // The user's slot 1 survives, and because they have touched this track
  // nothing else is written either.
  assert.deepEqual(useDjCuesStore.getState().cuesFor('t2'), [null, 12.5, null, null]);
  assert.notEqual(useDjCuesStore.getState().seeded.t2, true);
});

test('clearing a cue is a user decision — the seed does not undo it', () => {
  resetCues();
  useDjCuesStore.getState().seedCues('t3', [1, 33, 65, 97]);
  useDjCuesStore.getState().clearCue('t3', 2);
  useDjCuesStore.getState().seedCues('t3', [1, 33, 65, 97]);
  assert.deepEqual(useDjCuesStore.getState().cuesFor('t3'), [1, 33, null, 97]);
});

test('clearAll is a user decision too', () => {
  resetCues();
  useDjCuesStore.getState().seedCues('t4', [1, 33, 65, 97]);
  useDjCuesStore.getState().clearAll('t4');
  useDjCuesStore.getState().seedCues('t4', [1, 33, 65, 97]);
  assert.deepEqual(useDjCuesStore.getState().cuesFor('t4'), [null, null, null, null]);
});

test('a later, better seed replaces one this store placed itself', () => {
  // The rhythm cache lands after the beats-only seed: the phrase cues move
  // onto real bar lines, because nobody has touched them.
  resetCues();
  useDjCuesStore.getState().seedCues('t5', [1, 33, 65, 97]);
  useDjCuesStore.getState().seedCues('t5', [1.5, 33.5, 65.5, 97.5]);
  assert.deepEqual(useDjCuesStore.getState().cuesFor('t5'), [1.5, 33.5, 65.5, 97.5]);
});

test('cues persisted before this feature existed are treated as the user\'s', () => {
  // Restored straight from localStorage: no `seeded` flag, so the store must
  // assume a human put them there and only fill the gaps — and must not mark
  // the track as its own, or a later re-seed would wipe them.
  resetCues();
  useDjCuesStore.setState({ byEntry: { t6: [4, null, null, null] } }, false);
  useDjCuesStore.getState().seedCues('t6', [1, 33, 65, 97]);
  assert.deepEqual(useDjCuesStore.getState().cuesFor('t6'), [4, 33, 65, 97]);
  assert.notEqual(useDjCuesStore.getState().seeded.t6, true);
  useDjCuesStore.getState().seedCues('t6', [9, 9, 9, 9]);
  assert.equal(useDjCuesStore.getState().cuesFor('t6')[0], 4, 'the human cue is still there');
});

test('a short or dirty seed array cannot corrupt the slots', () => {
  resetCues();
  useDjCuesStore.getState().seedCues('t7', [1, Number.NaN, 65]);
  const cues = useDjCuesStore.getState().cuesFor('t7');
  assert.equal(cues.length, HOTCUE_SLOTS);
  assert.equal(cues[0], 1);
  assert.equal(cues[1], null);
  assert.equal(cues[2], 65);
  assert.equal(cues[3], null);
});

test('an empty id is a no-op', () => {
  resetCues();
  useDjCuesStore.getState().seedCues('', [1, 2, 3, 4]);
  assert.deepEqual(useDjCuesStore.getState().byEntry, {});
});

/* ══════════════════════ beatgrid ══════════════════════ */

console.log('DJ-3 · beatgrid');

const beatsAt = (n: number, step = 0.5, start = 0) =>
  Array.from({ length: n }, (_, i) => start + i * step);

const fullView = { viewStart: 0, viewEnd: 1, visibleFrac: 1 };

test('real downbeats decide the bar lines, not i % 4', () => {
  // A track with a 3-beat pickup: `i % 4 === 0` puts every bar line one beat
  // early for the whole song.
  const beats = beatsAt(64);
  const downbeats = [1.5, 3.5, 5.5, 7.5];
  const marks = beatMarkPositions({ beats, downbeats, dur: 32, widthPx: 2000, ...fullView });
  assert.ok(marks);
  const downTimes = marks.filter((m) => m.down).map((m) => (m.left / 100) * 32);
  for (const t of downbeats) assert.ok(downTimes.some((d) => Math.abs(d - t) < 1e-6), `${t}`);
  // beats[0] = 0 is NOT a bar line here, though `i % 4 === 0` says it is.
  assert.equal(marks[0].down, false);
});

test('without downbeats it still falls back to the every-4th-beat guess', () => {
  const marks = beatMarkPositions({
    beats: beatsAt(64), downbeats: null, dur: 32, widthPx: 2000, ...fullView,
  });
  assert.ok(marks);
  assert.equal(marks[0].down, true);
  assert.equal(marks[1].down, false);
  assert.equal(marks[4].down, true);
});

test('tick density follows the lane width, not a fixed 400', () => {
  const beats = beatsAt(500); // over the old hard cutoff
  const wide = beatMarkPositions({ beats, downbeats: null, dur: 250, widthPx: 4000, ...fullView });
  const narrow = beatMarkPositions({ beats, downbeats: null, dur: 250, widthPx: 120, ...fullView });
  assert.ok(wide && narrow);
  // A 4000px lane has room for all 500; a 120px lane does not and keeps only
  // the bar lines.
  assert.equal(wide.length, 500);
  assert.ok(narrow.length < 500);
  assert.ok(narrow.every((m) => m.down));
});

test('zooming in re-densifies a long track', () => {
  const beats = beatsAt(500);
  // Same 600px lane, but only 1/16 of the track is on screen.
  const zoomed = beatMarkPositions({
    beats, downbeats: null, dur: 250, widthPx: 600,
    viewStart: 0, viewEnd: 1 / 16, visibleFrac: 1 / 16,
  });
  assert.ok(zoomed);
  assert.ok(zoomed.some((m) => !m.down), 'off-beat ticks come back when zoomed in');
});

test('marks outside the view are dropped and positions are lane-relative', () => {
  const marks = beatMarkPositions({
    beats: beatsAt(64), downbeats: null, dur: 32,
    widthPx: 2000, viewStart: 0.5, viewEnd: 1, visibleFrac: 0.5,
  });
  assert.ok(marks);
  for (const m of marks) {
    assert.ok(m.left >= -1e-9 && m.left <= 100 + 1e-9, `${m.left}`);
  }
  assert.equal(marks.length, 32);
});

test('no beats or no duration means no grid', () => {
  assert.equal(beatMarkPositions({ beats: null, downbeats: null, dur: 32, widthPx: 600, ...fullView }), null);
  assert.equal(beatMarkPositions({ beats: [], downbeats: null, dur: 32, widthPx: 600, ...fullView }), null);
  assert.equal(beatMarkPositions({ beats: beatsAt(8), downbeats: null, dur: 0, widthPx: 600, ...fullView }), null);
});

/* ══════════════════════ source-level pins ══════════════════════ */

console.log('DJ-3 · source pins');

const djViewSrc = readFileSync(fileURLToPath(new URL('./DJView.tsx', import.meta.url)), 'utf8');
const setlistSrc = readFileSync(
  fileURLToPath(new URL('../state/setlistStore.ts', import.meta.url)),
  'utf8',
);

test('both deck-load effects re-run when a single-entry lookup lands', () => {
  // `trackById` goes through `libraryStore.getById`, which returns undefined
  // for a track on no loaded page and kicks an async fetch. With
  // `[deckATrack]` alone nothing re-ran when that fetch landed, so every
  // Send-to-DJ and bundled-set id loaded a silently empty deck and automix
  // stalled on `incomingHasBuffer`.
  for (const deck of ['A', 'B'] as const) {
    const re = new RegExp(
      `djEngine\\.loadDeck\\('${deck}'[\\s\\S]{0,400}?\\}, \\[([^\\]]*)\\]\\);`,
    );
    const m = djViewSrc.match(re);
    assert.ok(m, `deck ${deck} load effect not found`);
    assert.match(m[1], /libLookupVersion/, `deck ${deck} deps: ${m[1]}`);
    assert.match(m[1], new RegExp(`deck${deck}Track`), `deck ${deck} deps: ${m[1]}`);
  }
});

test('registerBundled queues analysis for the ids it filled in', () => {
  const body = setlistSrc.slice(setlistSrc.indexOf('registerBundled: async'));
  assert.match(body, /analyzeEntries\(filled\)/);
});

test('the DJ path never POSTs the heavy rhythm /run', () => {
  assert.doesNotMatch(djViewSrc, /rhythm\/[^'"`]*\/run/);
});

console.log(`\nDJ-3: ${passed} passed`);
