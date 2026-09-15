import assert from 'node:assert/strict';
import { useEditorStore, type AudioClip } from './editorStore.ts';
import type { ChainEntry } from './effectChainStore.ts';

const st = () => useEditorStore.getState();

// A minimal clip: only the fields the operations under test read. The cast
// keeps the fixture from drifting every time an optional field is added.
const clip = (over: Partial<AudioClip> = {}): AudioClip =>
  ({
    id: 'c1',
    trackId: 't1',
    label: 'take',
    audioBlob: new Blob(),
    mimeType: 'audio/wav',
    sourceDuration: 10,
    offsetIntoSource: 0,
    durationSec: 10,
    startSec: 0,
    color: '#fff',
    fadeInSec: 0,
    fadeOutSec: 0,
    gain: 1,
    muted: false,
    ...over,
  }) as AudioClip;

// Undo reaches the master VST rack. A track's VST inserts ride inside `tracks`
// and were always undoable; the master rack lives in its own slice and used to
// be the one rack edit history could not take back.
{
  // The setup write is itself a document change, so the recorder logs it and
  // would coalesce the edit under test into the same 300 ms step. undo() pops
  // that setup step and resets the coalescing clock, so the edit under test
  // starts a fresh step.
  useEditorStore.setState({ masterVstChain: [], _undo: [], _redo: [] });
  st().undo();
  const before = st()._undo.length;
  const entry: ChainEntry = { id: 'v1', effect: 'vst3', params: {}, enabled: true };
  useEditorStore.setState({ masterVstChain: [entry] });
  assert.equal(st()._undo.length, before + 1, 'a master VST edit records an undo step');
  st().undo();
  assert.deepEqual(st().masterVstChain, [], 'undo restores the master VST rack');
  st().redo();
  assert.deepEqual(st().masterVstChain, [entry], 'redo re-applies it');
  st().undo(); // leaves lastDocChangeAt reset, so the next edit is a fresh step
}

// A split keeps each fade on the end it belongs to. The fade-in stays on the
// left half and the fade-out moves to the right half — neither half inherits
// the other's fade — and a fade is capped at half its new half's length.
{
  useEditorStore.setState({ clips: [clip({ fadeInSec: 3, fadeOutSec: 3 })], selectedClipId: null });
  const rightId = st().splitClipAt('c1', 4);
  assert.ok(rightId, 'split succeeds away from the edges');
  const [left, right] = st().clips;
  assert.equal(left.id, 'c1');
  assert.equal(left.durationSec, 4);
  assert.equal(left.fadeInSec, 2, 'fade-in kept, capped to half of 4 s');
  assert.equal(left.fadeOutSec, 0, 'left half does not inherit the fade-out');
  assert.equal(right.id, rightId);
  assert.equal(right.startSec, 4);
  assert.equal(right.offsetIntoSource, 4);
  assert.equal(right.durationSec, 6);
  assert.equal(right.fadeInSec, 0, 'right half does not inherit the fade-in');
  assert.equal(right.fadeOutSec, 3, 'fade-out kept (3 s fits within half of 6 s)');
  assert.equal(st().selectedClipId, rightId);
}

// Splitting too close to an edge is refused and leaves the clip alone.
{
  useEditorStore.setState({ clips: [clip()] });
  assert.equal(st().splitClipAt('c1', 0.01), null);
  assert.equal(st().splitClipAt('c1', 9.99), null);
  assert.equal(st().clips.length, 1);
}

console.log('editorStore: ok');
