// Run with: npx tsx src/lib/lineageInsights.test.ts
//
// The library's INFO tab and the lineage window's node inspector read a
// track's family through these helpers, so both must agree on who a track
// came from, what came from it, and how far the family reaches.
import assert from 'node:assert/strict';
import { relativesOf, themesOf, tokenize, type LineageEdge } from './lineageInsights.ts';

// A made B by init, B and C were chimera sources of D, D has a stem S.
const edges: LineageEdge[] = [
  { from_id: 'A', to_id: 'B', kind: 'init_for' },
  { from_id: 'B', to_id: 'D', kind: 'chimera_source_of' },
  { from_id: 'C', to_id: 'D', kind: 'chimera_source_of' },
  { from_id: 'D', to_id: 'S', kind: 'stem_of' },
];

const d = relativesOf('D', edges);
assert.deepEqual(d.incoming.map((e) => e.from_id).sort(), ['B', 'C']);
assert.deepEqual(d.outgoing.map((e) => e.to_id), ['S']);
assert.deepEqual([...d.ancestors].sort(), ['A', 'B', 'C'], 'ancestors walk every hop back');
assert.deepEqual([...d.descendants], ['S']);
assert.deepEqual(d.spawnedByKind, { stem_of: 1 });

const a = relativesOf('A', edges);
assert.equal(a.incoming.length, 0, 'a root came from nothing');
assert.deepEqual([...a.descendants].sort(), ['B', 'D', 'S']);
assert.equal(a.ancestors.size, 0);

// A cycle must not loop forever or count the start as its own relative.
const cycle = relativesOf('X', [
  { from_id: 'X', to_id: 'Y', kind: 'derived_from' },
  { from_id: 'Y', to_id: 'X', kind: 'derived_from' },
]);
assert.deepEqual([...cycle.descendants], ['Y']);
assert.deepEqual([...cycle.ancestors], ['Y']);

// A track with no edges at all.
const lone = relativesOf('Z', edges);
assert.equal(lone.incoming.length + lone.outgoing.length + lone.ancestors.size + lone.descendants.size, 0);

// Themes: stopwords and short words are not counted; the most frequent lead.
assert.deepEqual(tokenize('The dark ambient pad, with a dark drone'), ['dark', 'ambient', 'pad', 'dark', 'drone']);
const t = themesOf([
  { prompt: 'dark ambient pad', tags: ['ambient', 'night'] },
  { prompt: 'dark techno', tags: ['night'] },
  null,
  { prompt: undefined, tags: 'not a list' },
]);
assert.deepEqual(t.terms[0], ['dark', 2]);
assert.deepEqual(t.tags[0], ['night', 2]);
assert.equal(t.tags.length, 2);

console.log('lineageInsights: ok');
