/**
 * vstParamStore — the plugin's own parameter list, as the app keeps it.
 *
 * Run: npx tsx src/state/vstParamStore.test.ts
 */
import assert from 'node:assert/strict';

import { paramFromWire, useVstParamStore, visibleVstParams, vstParamKey, type VstParamWire } from './vstParamStore.ts';

const wire = (index: number, over: Partial<VstParamWire> = {}): VstParamWire => ({
  index,
  name: `Param ${index}`,
  label: '',
  default: 0.5,
  value: 0.5,
  steps: 0,
  automatable: true,
  discrete: false,
  boolean: false,
  ...over,
});
const st = () => useVstParamStore.getState();

/* ── an older host sends no flags and no text: nothing is hidden, nothing is read-only ── */
{
  const p = paramFromWire(wire(3));
  assert.deepEqual(
    { hidden: p.hidden, readOnly: p.readOnly, bypass: p.bypass, programChange: p.programChange, text: p.text },
    { hidden: false, readOnly: false, bypass: false, programChange: false, text: '' },
  );
  assert.equal(vstParamKey(3), 'p3', 'the key is the one ChainEntry.params already uses');
}

/* ── the list keeps EVERY parameter (the index is the plugin's own); the panel shows the visible ones ── */
{
  st().setList('e1', [wire(0), wire(1, { hidden: true }), wire(2, { read_only: true, text: '-3.1 dB' })]);
  const list = st().lists.e1;
  assert.deepEqual(list.map((p) => p.index), [0, 1, 2]);
  assert.deepEqual(visibleVstParams(list).map((p) => p.index), [0, 2]);
  assert.equal(list[2].readOnly, true);
  assert.equal(list[2].text, '-3.1 dB');
}

/* ── a value that moved carries its text; an unchanged one does not swap the list ── */
{
  const before = st().lists.e1;
  st().setValue('e1', 0, 0.5);
  assert.equal(st().lists.e1, before, 'same value, no text: nothing to re-render');
  st().setValue('e1', 0, 0.25, '-12.0 dB');
  assert.equal(st().lists.e1[0].value, 0.25);
  assert.equal(st().lists.e1[0].text, '-12.0 dB');
  assert.notEqual(st().lists.e1, before);
  st().setValue('e1', 0, 0.3); // moved, the host said nothing about text yet: keep the old words
  assert.equal(st().lists.e1[0].text, '-12.0 dB');
  st().setValue('nope', 0, 0.1); // unknown entry / index: no throw, no change
  st().setValue('e1', 99, 0.1);
}

/* ── a late text answer never labels a newer value ── */
{
  st().setValue('e1', 0, 0.8);
  st().setText('e1', 0, 0.3, 'stale words'); // asked while the slider was at 0.3
  assert.equal(st().lists.e1[0].text, '-12.0 dB', 'the answer for 0.3 is dropped: the value is 0.8 now');
  st().setText('e1', 0, 0.8, '-1.9 dB');
  assert.equal(st().lists.e1[0].text, '-1.9 dB');
}

/* ── clear ── */
{
  st().clear('e1');
  assert.equal(st().lists.e1, undefined);
  const same = st();
  st().clear('e1');
  assert.equal(st().lists, same.lists, 'clearing twice changes nothing');
}

console.log('vstParamStore: ok');
