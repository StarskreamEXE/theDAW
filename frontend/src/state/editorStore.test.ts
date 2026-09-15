import assert from 'node:assert/strict';
import { beginUndoStep, clipSourceSpanSec, freezeSignature, useEditorStore, type AudioClip, type EditorTrack } from './editorStore.ts';
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
// the other's fade — and each half's fades are fitted by clampClipFades, the
// one rule that governs fades everywhere. A 3 s fade-in on a 4 s half survives
// whole, because 3 ≤ 4: the old `half / 2` cap is gone.
{
  useEditorStore.setState({ clips: [clip({ fadeInSec: 3, fadeOutSec: 3 })], selectedClipId: null });
  const rightId = st().splitClipAt('c1', 4);
  assert.ok(rightId, 'split succeeds away from the edges');
  const [left, right] = st().clips;
  assert.equal(left.id, 'c1');
  assert.equal(left.durationSec, 4);
  assert.equal(left.fadeInSec, 3, 'fade-in kept whole — it fits inside the 4 s half');
  assert.equal(left.fadeOutSec, 0, 'left half does not inherit the fade-out');
  assert.equal(right.id, rightId);
  assert.equal(right.startSec, 4);
  assert.equal(right.offsetIntoSource, 4);
  assert.equal(right.durationSec, 6);
  assert.equal(right.fadeInSec, 0, 'right half does not inherit the fade-in');
  assert.equal(right.fadeOutSec, 3, 'fade-out kept whole — it fits inside the 6 s half');
  assert.equal(st().selectedClipId, rightId);
}

// A fade LONGER than the half it lands on is cut down to that half's length —
// the clamp still bites, it just bites at the clip's edge instead of halfway.
{
  useEditorStore.setState({ clips: [clip({ fadeInSec: 8, fadeOutSec: 9 })] });
  const rightId = st().splitClipAt('c1', 3);
  assert.ok(rightId);
  const [left, right] = st().clips;
  assert.equal(left.fadeInSec, 3, 'an 8 s fade-in on a 3 s half is cut to 3 s');
  assert.equal(right.fadeOutSec, 7, 'a 9 s fade-out on a 7 s half is cut to 7 s');
}

// Splitting too close to an edge is refused and leaves the clip alone.
{
  useEditorStore.setState({ clips: [clip()] });
  assert.equal(st().splitClipAt('c1', 0.01), null);
  assert.equal(st().splitClipAt('c1', 9.99), null);
  assert.equal(st().clips.length, 1);
}

// A clip with no fades splits into two halves with no fades — never NaN.
// fadeInSec / fadeOutSec are optional on AudioClip, and Math.min(undefined, x)
// is NaN; the first version of the split-fade fix tripped on exactly that.
{
  useEditorStore.setState({ clips: [clip({ fadeInSec: undefined, fadeOutSec: undefined })] });
  const rightId = st().splitClipAt('c1', 4);
  assert.ok(rightId);
  const [left, right] = st().clips;
  for (const [name, v] of [['left.fadeInSec', left.fadeInSec], ['left.fadeOutSec', left.fadeOutSec], ['right.fadeInSec', right.fadeInSec], ['right.fadeOutSec', right.fadeOutSec]] as const) {
    assert.equal(v, 0, `${name} is 0, not NaN`);
  }
}

// A STRETCHED clip splits at a timeline point, but `offsetIntoSource` is in
// SOURCE seconds — so the seam converts through the rate. Both halves keep the
// rate, and together they still cover exactly the source the whole clip did.
{
  useEditorStore.setState({
    clips: [clip({ durationSec: 10, sourceDuration: 40, offsetIntoSource: 5, timeStretchRate: 2 })],
  });
  const wholeSpan = 20; // 10 s of timeline at rate 2
  const rightId = st().splitClipAt('c1', 4);
  assert.ok(rightId);
  const [left, right] = st().clips;
  assert.equal(left.timeStretchRate, 2, 'the left half plays at the same rate');
  assert.equal(right.timeStretchRate, 2, 'and so does the right');
  assert.equal(right.offsetIntoSource, 13, '4 s of timeline at rate 2 is 8 s of source past the 5 s offset');
  assert.equal(
    clipSourceSpanSec(left) + clipSourceSpanSec(right), wholeSpan,
    'the halves cover the whole clip, no source lost or repeated',
  );
  assert.equal(
    right.offsetIntoSource, left.offsetIntoSource + clipSourceSpanSec(left),
    'the right half starts reading where the left half stopped',
  );
}

// ── beginUndoStep ────────────────────────────────────────────────────────────
// A gesture is one undo step because the recorder coalesces changes closer than
// 300 ms — but that same rule would fold a gesture into whatever edit happened
// just before it. beginUndoStep cuts the burst so the next change starts fresh.
{
  useEditorStore.setState({ clips: [clip()] });
  const base = st()._undo.length;
  useEditorStore.setState({ clips: [clip({ startSec: 1 })] });
  assert.equal(st()._undo.length, base, 'a change within the coalescing window records nothing new');
  beginUndoStep();
  useEditorStore.setState({ clips: [clip({ startSec: 2 })] });
  assert.equal(st()._undo.length, base + 1, 'beginUndoStep forces the next change to start a step');
}

/** Seat a fixture and report the undo depth it left behind. It deliberately
 *  does NOT cut the undo burst: each of the actions below begins its own step,
 *  so a menu action is undoable on its own however close it lands to the last
 *  edit. Anything that needed a `beginUndoStep()` here to look like one step
 *  would not be one step in the app either. */
const seat = (clips: AudioClip[]): number => {
  useEditorStore.setState({ clips, selectedClipId: null });
  return st()._undo.length;
};

// ── createCrossfade ──────────────────────────────────────────────────────────
// Two overlapping clips on one track: the earlier one fades out across the
// overlap, the later one fades in across it, both equal power, one undo step.
{
  const a = clip({ id: 'a', startSec: 0, durationSec: 10 });
  const b = clip({ id: 'b', startSec: 8, durationSec: 10 });
  const before = seat([a, b]);
  assert.equal(st().createCrossfade('a', 'b'), true, 'an overlapping pair crossfades');
  const [ca, cb] = st().clips;
  assert.equal(ca.fadeOutSec, 2, 'the earlier clip fades out across the 2 s overlap');
  assert.equal(ca.fadeOutCurve, 'equal-power');
  assert.equal(ca.fadeInSec, 0, 'its own fade-in is left alone');
  assert.equal(cb.fadeInSec, 2, 'the later clip fades in across the same 2 s');
  assert.equal(cb.fadeInCurve, 'equal-power');
  assert.equal(cb.fadeOutSec, 0, 'its own fade-out is left alone');
  assert.equal(st()._undo.length, before + 1, 'one undo step');
  st().undo();
  assert.equal(st().clips[0].fadeOutSec, 0, 'undo takes the whole crossfade back');
  assert.equal(st().clips[1].fadeInSec, 0);
}

// Each menu action begins its own undo step, so the 300 ms coalescer cannot
// swallow one into the last edit: two crossfades back to back are two steps,
// with nothing cutting the burst from outside.
{
  const before = seat([
    clip({ id: 'a', startSec: 0, durationSec: 10 }),
    clip({ id: 'b', startSec: 8, durationSec: 10 }),
  ]);
  assert.equal(st().createCrossfade('a', 'b'), true);
  assert.equal(st().createCrossfade('a', 'b'), true);
  assert.equal(st()._undo.length, before + 2, 'two actions inside 300 ms are two undo steps');
}

// The argument order is the selection's, not the timeline's: which clip fades
// out is decided by which one starts earlier.
{
  const a = clip({ id: 'a', startSec: 0, durationSec: 10 });
  const b = clip({ id: 'b', startSec: 8, durationSec: 10 });
  seat([a, b]);
  assert.equal(st().createCrossfade('b', 'a'), true);
  assert.equal(st().clips[0].fadeOutSec, 2, 'the earlier clip still fades OUT');
  assert.equal(st().clips[1].fadeInSec, 2, 'the later clip still fades IN');
}

// Clips that only touch are not a crossfade, and nothing is written.
{
  const before = seat([
    clip({ id: 'a', startSec: 0, durationSec: 8 }),
    clip({ id: 'b', startSec: 8, durationSec: 8 }),
  ]);
  assert.equal(st().createCrossfade('a', 'b'), false, 'touching clips do not overlap');
  assert.equal(st().clips[0].fadeOutSec, 0);
  assert.equal(st().clips[1].fadeInSec, 0);
  assert.equal(st()._undo.length, before, 'a refused crossfade records no undo step');
}

// Overlapping in time but on different tracks is two clips playing together,
// not a crossfade.
{
  seat([
    clip({ id: 'a', trackId: 't1', startSec: 0, durationSec: 10 }),
    clip({ id: 'b', trackId: 't2', startSec: 8, durationSec: 10 }),
  ]);
  assert.equal(st().createCrossfade('a', 'b'), false, 'different tracks never crossfade');
  assert.equal(st().clips[0].fadeOutSec, 0);
}

// A missing clip, or a clip with itself, is refused rather than throwing.
{
  seat([clip({ id: 'a', startSec: 0, durationSec: 10 })]);
  assert.equal(st().createCrossfade('a', 'gone'), false);
  assert.equal(st().createCrossfade('a', 'a'), false);
}

// The crossfade is fitted by the same clamp as every other fade: a clip already
// faded in over most of its length has no room left for a long fade-out.
{
  seat([
    clip({ id: 'a', startSec: 0, durationSec: 10, fadeInSec: 9 }),
    clip({ id: 'b', startSec: 4, durationSec: 10 }),
  ]);
  assert.equal(st().createCrossfade('a', 'b'), true);
  const [ca, cb] = st().clips;
  assert.equal(ca.fadeInSec, 9, 'the longer fade keeps its length');
  assert.equal(ca.fadeOutSec, 1, 'the 6 s crossfade is cut to the 1 s that is left');
  assert.equal(cb.fadeInSec, 6, 'the incoming clip has room for the whole overlap');
}

// ── stretchClipToFit / resetClipStretch ──────────────────────────────────────
// Dragging the edge stores a ratio; the audio is untouched and the clip's
// length on the timeline follows, because every renderer sizes itself from
// startSec + durationSec.
{
  const before = seat([clip({ id: 'a', durationSec: 10, sourceDuration: 10 })]);
  st().stretchClipToFit('a', 5);
  const c = st().clips[0];
  assert.equal(c.durationSec, 5, 'the clip now lasts 5 s');
  assert.equal(c.timeStretchRate, 2, '10 s of source into 5 s is double speed');
  assert.equal(c.stretchMode, 'repitch', 'the drag gesture is the live path');
  assert.equal(c.audioBlob, st().clips[0].audioBlob, 'nothing is re-rendered');
  assert.equal(st()._undo.length, before + 1, 'one undo step');
}

// Stretching an already-stretched clip measures against the SOURCE it covers,
// not against its current length, so the ratio never compounds.
{
  seat([clip({ id: 'a', durationSec: 5, sourceDuration: 10, timeStretchRate: 2 })]);
  st().stretchClipToFit('a', 20);
  const c = st().clips[0];
  assert.equal(c.durationSec, 20);
  assert.equal(c.timeStretchRate, 0.5, 'the same 10 s of source, now over 20 s');
}

// An 'offline' stretch is already baked into the blob, so that blob is the
// source the new ratio is measured against.
{
  seat([clip({ id: 'a', durationSec: 8, sourceDuration: 8, timeStretchRate: 3, stretchMode: 'offline' })]);
  st().stretchClipToFit('a', 4);
  assert.equal(st().clips[0].timeStretchRate, 2, 'baked audio counts as rate 1');
  assert.equal(st().clips[0].stretchMode, 'repitch');
}

// The left edge can stretch too: the clip's end stays put while its head moves.
{
  seat([clip({ id: 'a', startSec: 4, durationSec: 6, sourceDuration: 6 })]);
  st().stretchClipToFit('a', 2, 8);
  const c = st().clips[0];
  assert.equal(c.startSec, 8);
  assert.equal(c.durationSec, 2);
  assert.equal(c.timeStretchRate, 3, '6 s of source into 2 s');
  assert.equal(c.offsetIntoSource, 0, 'the clip still reads the same stretch of source');
}

// A stretch DRAG is still ONE undo step: it calls this on every pointer move,
// so it says `coalesce` and the pointer-down's single `beginUndoStep()` covers
// the whole gesture. Without it, every frame of a drag would be undoable.
{
  const before = seat([clip({ id: 'a', durationSec: 10, sourceDuration: 10 })]);
  beginUndoStep();
  st().stretchClipToFit('a', 9, undefined, { coalesce: true });
  st().stretchClipToFit('a', 8, undefined, { coalesce: true });
  st().stretchClipToFit('a', 7, undefined, { coalesce: true });
  assert.equal(st().clips[0].durationSec, 7);
  assert.equal(st()._undo.length, before + 1, 'the whole drag is one undo step');
}

// Nonsense lengths are refused instead of writing a NaN rate.
{
  seat([clip({ id: 'a', durationSec: 10, sourceDuration: 10 })]);
  st().stretchClipToFit('a', Number.NaN);
  st().stretchClipToFit('a', 0);
  st().stretchClipToFit('gone', 5);
  const c = st().clips[0];
  assert.equal(c.durationSec, 10, 'the clip is left exactly as it was');
  assert.equal(c.timeStretchRate, undefined);
}

// Reset clears the ratio AND restores the length it implied, or the clip would
// keep playing a different stretch of source at the original speed.
{
  const before = seat([clip({ id: 'a', durationSec: 5, sourceDuration: 10, timeStretchRate: 2 })]);
  st().resetClipStretch('a');
  const c = st().clips[0];
  assert.equal(c.timeStretchRate, undefined, 'the ratio is cleared');
  assert.equal(c.stretchMode, undefined, 'and the mode with it');
  assert.equal(c.durationSec, 10, 'back to the 10 s the audio actually takes');
  assert.equal(st()._undo.length, before + 1, 'one undo step of its own');
}

// Reset never claims timeline the source cannot fill.
{
  seat([clip({ id: 'a', durationSec: 9, sourceDuration: 10, offsetIntoSource: 6, timeStretchRate: 2 })]);
  st().resetClipStretch('a');
  assert.equal(st().clips[0].durationSec, 4, 'only the 4 s of source after the offset is left');
}

// ── setClipFadeCurve ─────────────────────────────────────────────────────────
{
  const before = seat([clip({ id: 'a', fadeInSec: 1, fadeOutSec: 1 })]);
  st().setClipFadeCurve('a', 'in', 'equal-power');
  assert.equal(st().clips[0].fadeInCurve, 'equal-power');
  assert.equal(st().clips[0].fadeOutCurve, undefined, 'the other end is untouched');
  assert.equal(st()._undo.length, before + 1, 'one undo step');
  st().setClipFadeCurve('a', 'out', 'exponential');
  assert.equal(st()._undo.length, before + 2, 'and the next choice is a step of its own');
  assert.equal(st().clips[0].fadeOutCurve, 'exponential');
  assert.equal(st().clips[0].fadeInCurve, 'equal-power', 'the first choice survives');
  st().setClipFadeCurve('gone', 'in', 'linear'); // no such clip: a no-op, not a throw
}

// ── freezeSignature ──────────────────────────────────────────────────────────
// The frozen master is stale as soon as anything that reaches the render
// changes. Every field the renderers read must move the signature — the ones
// T07b taught them to read (curves, stretch, warp) as much as the old ones.
{
  const track: EditorTrack = {
    id: 't1', name: 'T', nameAutoGenerated: false, volume: 1, pan: 0, mute: false, solo: false, color: '#fff',
  };
  const doc = (over: Partial<AudioClip> = {}) => ({
    clips: [clip({ ...over })],
    tracks: [track],
    masterFxChain: [] as ChainEntry[],
    masterVstChain: [] as ChainEntry[],
    bpm: 120,
  });
  const base = freezeSignature(doc());
  assert.equal(freezeSignature(doc()), base, 'the same document signs the same');

  const moved: Array<[string, Partial<AudioClip>]> = [
    ['startSec', { startSec: 1 }],
    ['durationSec', { durationSec: 9 }],
    ['offsetIntoSource', { offsetIntoSource: 1 }],
    ['fadeInSec', { fadeInSec: 1 }],
    ['fadeOutSec', { fadeOutSec: 1 }],
    ['muted', { muted: true }],
    ['gain', { gain: 0.5 }],
    ['fadeInCurve', { fadeInCurve: 'equal-power' }],
    ['fadeOutCurve', { fadeOutCurve: 'exponential' }],
    ['timeStretchRate', { timeStretchRate: 1.5 }],
    ['stretchMode', { stretchMode: 'offline' }],
    ['warpMarkers', { warpMarkers: [{ sourceSec: 1, targetSec: 2 }] }],
  ];
  for (const [name, over] of moved) {
    assert.notEqual(freezeSignature(doc(over)), base, `${name} changes the signature`);
  }
  // Derived data does not: peaks are recomputed from the audio, never rendered.
  assert.equal(freezeSignature(doc({ peaks: new Float32Array([1, 2]) })), base, 'peaks are not part of the render');
}

console.log('editorStore: ok');
