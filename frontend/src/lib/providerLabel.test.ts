/**
 * providerLabel: the pure display model behind every provider badge.
 *
 * What it pins:
 *   * an entry ALWAYS has a provider — the slug the backend detected when it
 *     sent one, the model/source derivation when it did not — so no caller has
 *     to choose between two badges; only a null/undefined entry has none;
 *   * a provider the frontend has never heard of still reads sensibly, from
 *     the backend's label when it sent one and from a title-cased slug when it
 *     did not, so a new provider needs no frontend change;
 *   * `(AI)` follows `providerIsAi` when the backend sent it, and otherwise
 *     every derived engine except an import;
 *   * the search text carries both the human label and the slug;
 *   * `hasProvider` is the exact, case-insensitive membership test the
 *     provider filter runs, over that same one id.
 *
 *   cd frontend && npx tsx src/lib/providerLabel.test.ts
 */
import assert from 'node:assert/strict';
import { hasProvider, providerDisplay, providerSearchText } from './providerLabel.ts';

// ── no entry → no display model ──────────────────────────────────────────────
{
  assert.equal(providerDisplay(null), null, 'null entry');
  assert.equal(providerDisplay(undefined), null, 'undefined entry');
}

// ── an entry with no detected provider still has one ─────────────────────────
{
  // This is the change T06 made: the badge used to render nothing here, while
  // the Catalogue drew a derived one beside it. One provider, one badge.
  const bare = providerDisplay({});
  assert.ok(bare, 'an entry with no provider field still resolves');
  assert.equal(bare.slug, 'stable-audio', 'theDAW’s own generations are Stable Audio');
  assert.equal(bare.label, 'Stable Audio');
  assert.equal(bare.isAi, true, 'a generation engine is AI');

  const imported = providerDisplay({ source: 'import', model: 'import' });
  assert.ok(imported);
  assert.equal(imported.slug, 'import');
  assert.equal(imported.label, 'Imported');
  assert.equal(imported.isAi, false, 'an import is not an AI service');
  assert.equal(imported.accessibleName, 'Source: Imported', 'and is never announced as one');

  // A label/flag with no slug does not stop the derivation answering.
  const partial = providerDisplay({ providerLabel: 'Suno', providerIsAi: true, providerId: 'abc' });
  assert.ok(partial);
  assert.equal(partial.slug, 'stable-audio', 'a label alone is not a provider id');
}

// ── a fully-populated AI provider ────────────────────────────────────────────
{
  const info = providerDisplay({
    provider: 'suno',
    providerLabel: 'Suno',
    providerIsAi: true,
    providerId: 'c0ffee00-0000-4000-8000-000000000001',
  });
  assert.ok(info, 'a labelled provider has a display model');
  assert.equal(info.slug, 'suno');
  assert.equal(info.label, 'Suno');
  assert.equal(info.isAi, true);
  assert.equal(info.text, 'Suno', 'the badge shows the label');
  assert.equal(info.accessibleName, 'Source: Suno (AI)', 'the ticket-specified accessible name');
  assert.equal(info.providerId, 'c0ffee00-0000-4000-8000-000000000001');
}

// ── the detected provider beats the derivation ───────────────────────────────
{
  // A Suno track imported as a file: `model` says 'import', the FILE says Suno.
  const info = providerDisplay({
    provider: 'suno',
    providerLabel: 'Suno',
    providerIsAi: true,
    model: 'import',
    source: 'import',
  });
  assert.ok(info);
  assert.equal(info.slug, 'suno', 'what the file said wins over model/source');
  assert.equal(info.isAi, true, 'and so does its AI flag');
}

// ── a non-AI provider: a store/host is never announced as AI ─────────────────
{
  const info = providerDisplay({ provider: 'bandcamp', providerLabel: 'Bandcamp', providerIsAi: false });
  assert.ok(info);
  assert.equal(info.isAi, false);
  assert.equal(info.accessibleName, 'Source: Bandcamp', 'no "(AI)" on a store/host');
  assert.equal(info.providerId, null, 'a missing id is null, never ""');
}

// ── with no flag, a detected provider is judged like a derived one ───────────
{
  for (const flag of [null, undefined] as const) {
    const info = providerDisplay({ provider: 'udio', providerLabel: 'Udio', providerIsAi: flag });
    assert.ok(info);
    assert.equal(info.isAi, true, `providerIsAi=${String(flag)} falls back to the id`);
    assert.equal(info.accessibleName, 'Source: Udio (AI)');
  }
  // …and the two ids that are not an AI service stay that way.
  const imported = providerDisplay({ provider: 'import', providerIsAi: null });
  assert.ok(imported);
  assert.equal(imported.isAi, false, 'an import is not AI without a flag either');
}

// ── an unlabelled / unknown provider still reads sensibly ────────────────────
{
  const bare = providerDisplay({ provider: 'apple-music' });
  assert.ok(bare);
  assert.equal(bare.label, 'Apple Music', 'a missing label title-cases the slug');
  assert.equal(bare.slug, 'apple-music', 'the slug itself is untouched');

  const underscored = providerDisplay({ provider: 'some_new_engine', providerLabel: '  ' });
  assert.ok(underscored);
  assert.equal(underscored.label, 'Some New Engine', 'a blank label falls back the same way');

  // A label the backend DID send is passed through verbatim, whatever it is.
  const raw = providerDisplay({ provider: 'oddcase', providerLabel: 'oDDcase Studio' });
  assert.ok(raw);
  assert.equal(raw.label, 'oDDcase Studio', 'the backend label is never re-cased');

  // Even for a provider this app's own table knows, the backend's name wins:
  // it is the one that can be right when the table has drifted.
  const relabelled = providerDisplay({ provider: 'suno', providerLabel: 'Suno AI' });
  assert.ok(relabelled);
  assert.equal(relabelled.label, 'Suno AI');
}

// ── surrounding whitespace never reaches the UI ──────────────────────────────
{
  const info = providerDisplay({
    provider: '  suno  ',
    providerLabel: '  Suno  ',
    providerId: '  track-1  ',
  });
  assert.ok(info);
  assert.equal(info.slug, 'suno');
  assert.equal(info.label, 'Suno');
  assert.equal(info.providerId, 'track-1');
}

// ── search text ──────────────────────────────────────────────────────────────
{
  assert.equal(providerSearchText(null), '', 'no entry contributes nothing to the haystack');
  assert.equal(
    providerSearchText({ provider: 'suno', providerLabel: 'Suno' }),
    'Suno',
    'label and slug that differ only in case are not repeated',
  );
  const both = providerSearchText({ provider: 'apple-music', providerLabel: 'Apple Music' });
  assert.ok(both.includes('Apple Music'), 'the label is searchable');
  assert.ok(both.includes('apple-music'), 'the slug is searchable too');
  // A derived provider is searchable as well: typing "stable" finds theDAW's
  // own generations, exactly as "suno" finds the detected ones.
  assert.ok(providerSearchText({ model: 'sa3' }).toLowerCase().includes('stable audio'));
}

// ── hasProvider ──────────────────────────────────────────────────────────────
{
  const entry = { provider: 'Suno' };
  assert.equal(hasProvider(entry, 'suno'), true, 'case-insensitive both ways');
  assert.equal(hasProvider(entry, 'SUNO'), true);
  assert.equal(hasProvider(entry, 'udio'), false, 'a different provider does not match');
  assert.equal(hasProvider(entry, ''), false, 'an empty wanted slug matches nothing');
  assert.equal(hasProvider(entry, null), false, 'a null wanted slug matches nothing');
  assert.equal(hasProvider(null, 'suno'), false, 'and neither does a missing entry');

  // The derived half is a first-class member of the same filter.
  assert.equal(hasProvider({ model: 'sa3' }, 'stable-audio'), true);
  assert.equal(hasProvider({ model: 'sa3' }, 'suno'), false);
  assert.equal(hasProvider({ source: 'import', model: 'import' }, 'import'), true);
}

console.log('providerLabel: all assertions passed');
