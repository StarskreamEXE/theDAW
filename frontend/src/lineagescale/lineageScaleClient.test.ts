// Run with: npx tsx src/lineagescale/lineageScaleClient.test.ts
//
// The client for /api/lineage-scale. What this pins:
//
//   * the URL a request is made of — route, escaped id, and every parameter
//     the contract names, so a typo is a failing test and not a 422 in the
//     user's face;
//   * the CLAMPS. up/down are 0..8 and budget is 50..1500 on the server. A
//     depth control that has run past its end, or a saved budget from an older
//     build, must be corrected here rather than sent and rejected — and a
//     fractional or NaN value must never reach the wire at all;
//   * that entry ids are escaped into the path. Ids are data; one containing
//     '/' or '?' must not rewrite the route;
//   * that the requests go through apiJson, so a failure surfaces the FastAPI
//     `detail` instead of a bare status.
import assert from 'node:assert/strict';

const {
  BUDGET_MAX, BUDGET_MIN, DEPTH_MAX, LINEAGE_SCALE_BASE, RELATIVES_LIMIT_MAX,
  clampBudget, clampDepth, clampInt,
  fetchLineageSummary, fetchNeighbourhood, fetchRankings, fetchRelatives,
  neighbourhoodUrl, rankingsUrl, relativesUrl, summaryUrl,
} = await import('./lineageScaleClient.ts');

/** Stub fetch, remember the URL it was asked for, answer with `response`. */
const withFetch = async <T>(
  response: Response,
  run: () => Promise<T>,
): Promise<{ url: string; value: T | null; error: string | null }> => {
  const original = globalThis.fetch;
  let url = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    url = String(input);
    return response;
  }) as typeof fetch;
  try {
    // `run()` is awaited BEFORE the result object is built: an object literal
    // reads `url` in source order, so building it inline would capture the
    // empty string that was there before fetch ran.
    const value = await run();
    return { url, value, error: null };
  } catch (e) {
    return { url, value: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    globalThis.fetch = original;
  }
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The query part of a built URL, as a plain object. */
const params = (url: string): Record<string, string> => {
  const q = url.slice(url.indexOf('?') + 1);
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(q)) out[k] = v;
  return out;
};

// ── clampInt: the one arithmetic every clamp is built on ────────────────────
{
  assert.equal(clampInt(5, 0, 8, 2), 5);
  assert.equal(clampInt(-3, 0, 8, 2), 0, 'below the floor lands ON the floor');
  assert.equal(clampInt(99, 0, 8, 2), 8, 'above the ceiling lands ON the ceiling');
  assert.equal(clampInt(2.9, 0, 8, 2), 2, 'a fraction truncates — the wire wants an integer');
  assert.equal(clampInt(Number.NaN, 0, 8, 2), 2, 'NaN is not a depth; the default is');
  assert.equal(clampInt(Infinity, 0, 8, 2), 2, 'Infinity is not a number of generations either');
  assert.equal(clampInt(undefined, 0, 8, 2), 2);
  assert.equal(clampInt('4', 0, 8, 2), 4, 'a number that arrived as text still clamps');
  assert.equal(clampInt('nope', 0, 8, 2), 2);

  assert.equal(clampDepth(12, 1), DEPTH_MAX);
  assert.equal(clampDepth(undefined, 3), 3);
  assert.equal(clampBudget(10), BUDGET_MIN, 'the server floor is 50, not 10');
  assert.equal(clampBudget(99999), BUDGET_MAX);
  assert.equal(clampBudget(undefined), 400, 'the documented default');
}

// ── summary ─────────────────────────────────────────────────────────────────
{
  assert.equal(summaryUrl(), `${LINEAGE_SCALE_BASE}/summary`);

  const body = {
    entries: 194833, with_lineage: 173877, standalone: 20652,
    links_raw: 475174, links_distinct: 400000, by_kind: { derived_from: 164779 },
    largest_connected: 81501, largest_tree: 8618, full_view_ok: false, revision: 7,
  };
  const r = await withFetch(json(body), () => fetchLineageSummary());
  assert.equal(r.error, null);
  assert.equal(r.url, '/api/lineage-scale/summary');
  assert.equal(r.value?.largest_tree, 8618);
  assert.equal(r.value?.full_view_ok, false);
}

// ── rankings ────────────────────────────────────────────────────────────────
{
  assert.deepEqual(params(rankingsUrl('deepest', 25)), { list: 'deepest', limit: '25' });
  assert.deepEqual(params(rankingsUrl('most_derived')), { list: 'most_derived', limit: '50' });
  assert.equal(params(rankingsUrl('recent', 0)).limit, '1', 'a zero-row list is not a request');
  assert.equal(params(rankingsUrl('recent', 5000)).limit, '200', 'and neither is an unbounded one');

  const r = await withFetch(
    json({ list: 'mashup_sources', rows: [{ id: 'a', title: 'T', model: 'm', count: 3, detail: 'd' }] }),
    () => fetchRankings('mashup_sources', 50),
  );
  assert.equal(r.error, null);
  assert.ok(r.url.startsWith('/api/lineage-scale/rankings?'), r.url);
  assert.equal(r.value?.rows[0].count, 3);
}

// ── neighbourhood: clamps, defaults, escaping ───────────────────────────────
{
  assert.deepEqual(
    params(neighbourhoodUrl('song-1', { up: 2, down: 1, budget: 400 })),
    { up: '2', down: '1', budget: '400' },
  );
  assert.deepEqual(
    params(neighbourhoodUrl('song-1')),
    { up: '2', down: '1', budget: '400' },
    'the contract defaults are what an un-parameterised call sends',
  );
  assert.deepEqual(
    params(neighbourhoodUrl('song-1', { up: 99, down: -4, budget: 9 })),
    { up: '8', down: '0', budget: '50' },
    'out-of-range controls are corrected, never sent',
  );

  assert.ok(
    neighbourhoodUrl('a/b?c=d').startsWith(`${LINEAGE_SCALE_BASE}/a%2Fb%3Fc%3Dd/neighbourhood?`),
    'an id is escaped into the path: it cannot add a segment or a parameter',
  );

  const r = await withFetch(
    json({
      focus: 'song-1', nodes: [], edges: [], groups: [], hidden: {}, truncated: true, budget: 400,
    }),
    () => fetchNeighbourhood('song-1', { up: 3, down: 2, budget: 600 }),
  );
  assert.equal(r.error, null);
  assert.equal(r.url, '/api/lineage-scale/song-1/neighbourhood?up=3&down=2&budget=600');
  assert.equal(r.value?.truncated, true);
}

// ── relatives: direction / kind / sort / paging ─────────────────────────────
{
  assert.deepEqual(
    params(relativesUrl({ entryId: 'x', direction: 'down', kind: 'cover_of', sort: 'plays', offset: 200, limit: 100 })),
    { direction: 'down', kind: 'cover_of', sort: 'plays', offset: '200', limit: '100' },
  );
  assert.equal(
    params(relativesUrl({ entryId: 'x', direction: 'up', kind: '', sort: 'title', offset: -5, limit: 9999 })).kind,
    'all',
    'no kind means every kind, spelled the way the route spells it',
  );
  assert.equal(
    params(relativesUrl({ entryId: 'x', direction: 'up', kind: '', sort: 'title', offset: -5, limit: 9999 })).offset,
    '0',
    'a negative offset is page one',
  );
  assert.equal(
    params(relativesUrl({ entryId: 'x', direction: 'up', kind: 'all', sort: 'title', offset: 0, limit: 9999 })).limit,
    String(RELATIVES_LIMIT_MAX),
    'the page size ceiling is the route’s, applied before the request',
  );

  const r = await withFetch(
    json({ total: 312, rows: [{ id: 'c1', title: 'Cover', model: 'm', duration_sec: 61, play_count: 2, kinds: ['cover_of'] }] }),
    () => fetchRelatives({ entryId: 'x', direction: 'down', kind: 'cover_of', sort: 'recent', offset: 100, limit: 100 }),
  );
  assert.equal(r.error, null);
  assert.equal(r.url, '/api/lineage-scale/x/relatives?direction=down&kind=cover_of&sort=recent&offset=100&limit=100');
  assert.equal(r.value?.total, 312);
}

// ── errors come back as words, not statuses ─────────────────────────────────
{
  const r = await withFetch(json({ detail: 'no such entry' }, 404), () => fetchNeighbourhood('ghost'));
  assert.equal(r.value, null);
  assert.equal(r.error, 'no such entry', 'the route’s own words reach the user');

  const bare = await withFetch(new Response('', { status: 500 }), () => fetchLineageSummary());
  assert.ok(bare.error && bare.error.length > 0, 'a bodiless failure still says something');
}

console.log('lineageScaleClient: all assertions passed');
