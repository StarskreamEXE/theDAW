/**
 * catalogProviders: the ONE provider id, its label and its AI-ness.
 *
 * What it pins:
 *   * PRECEDENCE — a provider the backend detected in the file's own metadata
 *     wins over the model/source derivation, whatever the model says;
 *   * the derivation itself is UNCHANGED: same rules, same order, same
 *     fallback to 'stable-audio', for every entry that carries no provider;
 *   * the label the backend sent wins over this file's table (it is the only
 *     name that can be right for a provider the table has never heard of),
 *     while the palette still keys off the id;
 *   * AI-ness is the backend's flag when it sent one, and otherwise true for
 *     every derived engine except an import and the unknown bucket.
 *
 *   cd frontend && npx tsx src/catalog/catalogProviders.test.ts
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_PROVIDER_ORDER,
  entryProviderIsAi,
  entryProviderMeta,
  inferProvider,
  providerBadgeClass,
  providerMeta,
} from './catalogProviders.ts';

// ── the detected provider wins ───────────────────────────────────────────────
{
  assert.equal(
    inferProvider({ provider: 'bandcamp', model: 'suno', source: 'import' }),
    'bandcamp',
    'what the file said beats every derivation rule',
  );
  assert.equal(
    inferProvider({ provider: 'suno', model: 'sa3', source: 'generate' }),
    'suno',
    'including the rule that would have said stable-audio',
  );
  assert.equal(
    inferProvider({ provider: '  udio  ' }),
    'udio',
    'the slug is trimmed…',
  );
  assert.equal(
    inferProvider({ provider: 'Bandcamp' }),
    'Bandcamp',
    '…but never re-cased: the same string goes back to the server as provider=',
  );
}

// ── an absent / empty provider falls through to the derivation ───────────────
{
  for (const [what, value] of [
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', '   '],
  ] as const) {
    assert.equal(
      inferProvider({ provider: value, model: 'suno' }),
      'suno',
      `a ${what} provider is no provider`,
    );
  }
}

// ── the derivation, rule by rule, unchanged ──────────────────────────────────
{
  assert.equal(inferProvider({ model: 'suno' }), 'suno');
  assert.equal(inferProvider({ model: 'Suno v4.5' }), 'suno', 'matched as a substring, case-free');
  assert.equal(inferProvider({ model: 'magenta-rt' }), 'gemini-magenta');
  assert.equal(inferProvider({ model: 'gemini-music' }), 'gemini-magenta');
  assert.equal(inferProvider({ model: 'udio-130' }), 'udio');
  assert.equal(inferProvider({ model: 'riffusion-fuzz' }), 'riffusion');
  assert.equal(inferProvider({ model: '', source: 'import' }), 'import');
  assert.equal(inferProvider({ model: 'sa3', source: 'generate' }), 'stable-audio');
  assert.equal(inferProvider({ model: 'sa3', source: 'studio' }), 'stable-audio');
  assert.equal(inferProvider({}), 'stable-audio', 'the fallback for an entry that says nothing');
  // Order: the model is consulted before the source, so an IMPORTED Suno file
  // whose model says so is Suno, not 'import'.
  assert.equal(inferProvider({ model: 'suno', source: 'import' }), 'suno');
}

// ── labels ───────────────────────────────────────────────────────────────────
{
  assert.equal(entryProviderMeta({ model: 'sa3' }).label, 'Stable Audio', 'the table names a derived id');
  assert.equal(entryProviderMeta({ provider: 'suno' }).label, 'Suno');
  assert.equal(
    entryProviderMeta({ provider: 'suno', providerLabel: 'Suno AI' }).label,
    'Suno AI',
    'the backend’s own name wins over the table',
  );
  assert.equal(
    entryProviderMeta({ provider: 'apple-music' }).label,
    'Apple Music',
    'an unknown id is title-cased rather than left as a slug',
  );
  assert.equal(
    entryProviderMeta({ provider: 'apple-music', providerLabel: '   ' }).label,
    'Apple Music',
    'a blank label is not a label',
  );
  // The table row is shared: re-labelling one entry must not rename Suno for
  // the whole app.
  entryProviderMeta({ provider: 'suno', providerLabel: 'Something Else' });
  assert.equal(providerMeta('suno').label, 'Suno', 'the registry row is never mutated');

  // The palette keys off the id, so a re-labelled Suno is still orange.
  assert.equal(
    providerBadgeClass(inferProvider({ provider: 'suno', providerLabel: 'Suno AI' })),
    providerBadgeClass('suno'),
  );
}

// ── AI-ness ──────────────────────────────────────────────────────────────────
{
  assert.equal(entryProviderIsAi({ provider: 'suno', providerIsAi: true }), true);
  assert.equal(
    entryProviderIsAi({ provider: 'bandcamp', providerIsAi: false }),
    false,
    'a store/host says so and is believed',
  );
  assert.equal(
    entryProviderIsAi({ provider: 'suno', providerIsAi: false }),
    false,
    'the flag wins over the id, both ways',
  );

  // No flag: every derived engine is AI, except these two.
  assert.equal(entryProviderIsAi({ model: 'sa3' }), true, 'stable-audio');
  assert.equal(entryProviderIsAi({ model: 'suno' }), true, 'suno');
  assert.equal(entryProviderIsAi({ model: 'udio-130' }), true, 'udio');
  assert.equal(entryProviderIsAi({ source: 'import', model: '' }), false, 'an import is not AI');
  assert.equal(entryProviderIsAi({ provider: 'unknown' }), false, 'nor is the unknown bucket');
  assert.equal(entryProviderIsAi({ provider: 'Import' }), false, 'case-free on the id');
  assert.equal(
    entryProviderIsAi({ provider: 'bandcamp' }),
    false,
    'a provider this app has never heard of is not CLAIMED to be AI without a flag',
  );
}

// ── the seeded dropdown order ────────────────────────────────────────────────
{
  assert.ok(DEFAULT_PROVIDER_ORDER.includes('stable-audio'));
  assert.ok(DEFAULT_PROVIDER_ORDER.includes('suno'));
  // Every id the derivation can produce is already offered, so a dropdown
  // built from this list plus the loaded rows can never miss one.
  const derivable = [
    inferProvider({ model: 'suno' }),
    inferProvider({ model: 'magenta' }),
    inferProvider({ model: 'udio' }),
    inferProvider({ model: 'riffusion' }),
    inferProvider({ source: 'import', model: '' }),
    inferProvider({}),
  ];
  for (const id of derivable) {
    assert.ok(DEFAULT_PROVIDER_ORDER.includes(id), `${id} is offered up front`);
  }
}

console.log('catalogProviders: one id, one label, one AI flag');
