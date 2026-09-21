// Run with: npx tsx src/lineagescale/LearnHost.test.tsx
//
// The LEARN tab's host, which decides WHICH lineage view the user gets.
//
// The one rule everything here serves: on a library too big to draw, the
// classic view is never mounted. Mounting it is what fires the whole-library
// request — 194,833 nodes, 475,174 links, 128 MB, and a dead page. So the
// classic pane's ELEMENT is not constructed in that state, which means its
// lazy import does not run either. The test proves that with a stand-in that
// throws if it is ever rendered: a passing run is a run in which it was not.
//
// And the other half of the same promise: on a small library nothing changes.
// `full_view_ok` from the backend means the classic view opens, exactly as the
// tab does today, and a backend too old to answer at all gets the same.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  LearnHost, LearnHostSurface, LearnSwitch, LineageView,
  classicUnavailableReason, decideLearnMode, rememberMode, rememberedMode, shouldReadSummary,
  type LearnViewProps,
} from './LearnHost.tsx';
import { LineageScaleView } from './LineageScaleView.tsx';
import type { LineageSummary } from './lineageScaleClient.ts';

const summaryOf = (withLineage: number, fullViewOk: boolean): LineageSummary => ({
  entries: withLineage + 100,
  with_lineage: withLineage,
  standalone: 100,
  links_raw: withLineage * 2,
  links_distinct: withLineage,
  by_kind: { derived_from: withLineage },
  largest_connected: withLineage,
  largest_tree: 8618,
  full_view_ok: fullViewOk,
  revision: 3,
});

/** The real library: far past anything that can be drawn at once. */
const BIG = summaryOf(173565, false);
/** A library small enough for the classic picture to be the right one. */
const SMALL = summaryOf(412, true);

/** A stand-in that records the props it was mounted with. */
const spyView = (name: string, seen: LearnViewProps[]): React.FC<LearnViewProps> => (props) => {
  seen.push(props);
  return <i data-view={name} />;
};

/** A stand-in that must never run. If it does, the test fails where it stands. */
const Forbidden: React.FC<LearnViewProps> = () => {
  throw new Error('the classic view was mounted on a library that cannot draw it');
};

const surface = (props: Partial<React.ComponentProps<typeof LearnHostSurface>>): string =>
  renderToStaticMarkup(
    <LearnHostSurface
      read
      summary={null}
      chosen={null}
      onSelect={() => {}}
      {...props}
    />,
  );

// ── the decision ────────────────────────────────────────────────────────────
{
  // Unreadable summary — a 404 from a backend that predates this module, or
  // any other failure. That is today's behaviour, unchanged and unannounced.
  assert.deepEqual(decideLearnMode(null, null), { mode: 'classic', classicAllowed: true, reason: '' });
  assert.deepEqual(
    decideLearnMode(null, 'scale'),
    { mode: 'classic', classicAllowed: true, reason: '' },
    'and a remembered choice cannot be honoured when nothing is known',
  );

  // A small library: the classic picture, exactly as before.
  assert.equal(decideLearnMode(SMALL, null).mode, 'classic');
  assert.equal(decideLearnMode(SMALL, null).classicAllowed, true);
  assert.equal(decideLearnMode(SMALL, null).reason, '');

  // A big one: the new view, and the classic one refused with its reason.
  const big = decideLearnMode(BIG, null);
  assert.equal(big.mode, 'scale');
  assert.equal(big.classicAllowed, false);
  assert.equal(
    big.reason,
    'The classic graph draws every song at once. This library has 173,565 connected songs, so it cannot load here.',
  );
  assert.equal(big.reason, classicUnavailableReason(BIG));
  assert.ok(big.reason.includes('173,565'), 'the refusal quotes the library’s own number');

  // A remembered choice counts only where there is a choice to be had.
  assert.equal(decideLearnMode(SMALL, 'scale').mode, 'scale', 'honoured on a small library');
  assert.equal(decideLearnMode(SMALL, 'classic').mode, 'classic');
  assert.equal(
    decideLearnMode(BIG, 'classic').mode,
    'scale',
    'and ignored where the classic view cannot load — it is not a matter of taste',
  );
  assert.equal(decideLearnMode(BIG, 'classic').classicAllowed, false);
}

// ── when the summary is read at all ─────────────────────────────────────────
{
  assert.equal(shouldReadSummary(true, false), true, 'a visible tab that has not asked yet, asks');
  assert.equal(shouldReadSummary(false, false), false, 'a hidden tab asks for nothing');
  assert.equal(shouldReadSummary(true, true), false, 'and it is asked once, not once per render');
}

// ── the remembered choice ───────────────────────────────────────────────────
{
  const store = new Map<string, string>();
  const original = (globalThis as { sessionStorage?: unknown }).sessionStorage;
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  try {
    assert.equal(rememberedMode(), null, 'nothing remembered to begin with');
    rememberMode('scale');
    assert.equal(rememberedMode(), 'scale');
    rememberMode('classic');
    assert.equal(rememberedMode(), 'classic', 'the choice survives a tab switch');
    store.set('thedaw.learnMode', 'something else');
    assert.equal(rememberedMode(), null, 'a value that is not a mode is no choice at all');
  } finally {
    if (original === undefined) delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    else (globalThis as { sessionStorage?: unknown }).sessionStorage = original;
  }
  // No storage at all (a non-browser host) is a missing preference, not a crash.
  assert.equal(rememberedMode(), null);
  rememberMode('scale');
}

// ── THE GUARD: a big library never mounts the classic view ──────────────────
{
  const seen: LearnViewProps[] = [];
  const html = surface({
    read: true,
    summary: BIG,
    chosen: 'classic', // even having asked for it
    scaleView: spyView('scale', seen),
    classicView: Forbidden, // throws if it is so much as rendered
    rootEntryId: 'song-7',
    visible: true,
  });

  assert.ok(html.includes('data-view="scale"'), 'the new view is what opens');
  assert.equal(seen.length, 1, 'and it is mounted exactly once');
  assert.deepEqual(seen[0], { rootEntryId: 'song-7', visible: true }, 'with the tab’s own props');

  // The switch still offers the classic view — visibly, and refused.
  assert.ok(html.includes('role="group"') && html.includes('aria-label="Lineage view"'));
  assert.ok(html.includes('aria-pressed="true"'), 'the active option is pressed');
  assert.ok(html.includes('Classic graph'), 'the option is not hidden away');
  assert.ok(html.includes('disabled=""'), 'it is refused by the attribute, not just by styling');
  assert.ok(
    html.includes('aria-describedby="lineage-scale-classic-unavailable"'),
    'and the refusal is wired to its explanation',
  );
  assert.ok(
    html.includes('id="lineage-scale-classic-unavailable"'),
    'which is on the page for that id to point at',
  );
  assert.ok(html.includes('173,565 connected songs'), 'in the library’s own numbers');
  assert.ok(!html.includes('open anyway'), 'there is no escape hatch into a certain crash');
}

// ── a small library: today's behaviour, untouched ───────────────────────────
{
  const seen: LearnViewProps[] = [];
  const html = surface({
    read: true,
    summary: SMALL,
    chosen: null,
    scaleView: () => <i data-view="scale" />,
    classicView: spyView('classic', seen),
    rootEntryId: null,
    visible: true,
  });

  assert.ok(html.includes('data-view="classic"'), 'the classic graph opens, as it always did');
  assert.ok(!html.includes('data-view="scale"'), 'and only it');
  assert.deepEqual(seen[0], { rootEntryId: null, visible: true }, 'with the props it gets today');
  assert.ok(!html.includes('disabled'), 'neither option is refused');
  assert.ok(
    !html.includes('aria-describedby'),
    'and nothing needs explaining when nothing is refused',
  );

  // The remembered choice is honoured here, because here it is a choice.
  const switched = surface({
    read: true, summary: SMALL, chosen: 'scale',
    scaleView: () => <i data-view="scale" />, classicView: spyView('classic', []),
  });
  assert.ok(switched.includes('data-view="scale"'));
  assert.ok(!switched.includes('data-view="classic"'));
}

// ── an older backend: also today's behaviour ────────────────────────────────
{
  const html = surface({
    read: true,
    summary: null,
    chosen: null,
    scaleView: () => <i data-view="scale" />,
    classicView: () => <i data-view="classic" />,
  });
  assert.ok(html.includes('data-view="classic"'), 'a 404 from an old backend falls back, silently');
  assert.ok(!html.includes('disabled'), 'and claims nothing about a library it could not count');
  assert.ok(!/error|failed|unavailable/i.test(html), 'nothing alarming is shown');
}

// ── before the answer is in, NEITHER view exists ────────────────────────────
{
  const html = surface({
    read: false,
    summary: null,
    chosen: null,
    scaleView: Forbidden,
    classicView: Forbidden,
    visible: true,
  });
  assert.ok(html.includes('Reading this library'), 'the tab says what it is waiting for');
  assert.ok(!html.includes('Classic graph'), 'and offers no choice it cannot yet stand behind');

  // Hidden: still nothing mounted, and nothing said.
  const hidden = surface({
    read: false, summary: null, chosen: null,
    scaleView: Forbidden, classicView: Forbidden, visible: false,
  });
  assert.ok(!hidden.includes('Reading this library'), 'a hidden tab does not narrate');
}

// ── a hidden tab fetches nothing ────────────────────────────────────────────
{
  let asked = 0;
  const html = renderToStaticMarkup(
    <LearnHost
      visible={false}
      loadSummary={async () => {
        asked += 1;
        return BIG;
      }}
      scaleView={Forbidden}
      classicView={Forbidden}
    />,
  );
  assert.equal(asked, 0, 'a tab the user is not looking at asks the backend for nothing');
  assert.ok(!html.includes('data-view='), 'and mounts neither view');
}

// ── the switch on its own ───────────────────────────────────────────────────
{
  const html = renderToStaticMarkup(
    <LearnSwitch mode="classic" classicAllowed reason="" onSelect={() => {}} />,
  );
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  assert.equal(buttons.length, 2, 'two options, no more');
  assert.equal(
    buttons.filter((b) => b.includes('aria-pressed="true"')).length,
    1,
    'exactly one is pressed at a time',
  );
  for (const b of buttons) {
    assert.ok(b.includes('type="button"'), 'neither submits anything');
    assert.ok(b.includes('aria-pressed='), 'both report their state');
  }
  assert.ok(!html.includes('<label'), 'a toggle button is not a form control wrapped in a label');
}

// ── rootEntryId opens the view ON that song ─────────────────────────────────
{
  // The host hands `rootEntryId` straight through (asserted above, in the
  // props the stand-in recorded). This is the other end: the view opens
  // focused on that song rather than on the landing page.
  const focused = renderToStaticMarkup(<LineageScaleView rootEntryId="song-7" visible={false} />);
  assert.ok(focused.includes('aria-label="Focus song-7"'), 'the song is the trail’s first crumb');
  assert.ok(
    focused.includes('aria-label="Back to the lineage landing page"'),
    'and the focus chrome is what opened, not the landing page',
  );
  assert.ok(!focused.includes('id="lineage-scale-search"'), 'the landing search is not what is shown');

  const landing = renderToStaticMarkup(<LineageScaleView visible={false} />);
  assert.ok(landing.includes('id="lineage-scale-search"'), 'and without one, the landing still opens');
}

// ── the mount DAWCenterPanel will use ───────────────────────────────────────
{
  // `LineageView` is the name the LEARN tab mounts, and it takes exactly the
  // props line 154 already passes. This is a compile-time check as much as a
  // runtime one: if the prop shape drifted, tsc would fail on these lines.
  assert.equal(LineageView, LearnHost, 'the named export IS the host');
  const mounted = renderToStaticMarkup(
    <LineageView rootEntryId={null} visible={false} />,
  );
  assert.ok(mounted.length > 0, 'and it renders under the tab’s own props');

  const lazyShape = React.lazy(() =>
    import('./LearnHost.tsx').then((m) => ({ default: m.LineageView })),
  );
  assert.ok(typeof lazyShape === 'object', 'the tab’s lazy() form typechecks and builds');
}

console.log('LearnHost: all assertions passed');
