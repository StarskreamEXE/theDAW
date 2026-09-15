/**
 * EDIT's lane FX rack on a lane that holds MIDI and has never had an insert.
 *
 * Replays the sequence that took the app down: a new arrangement, a MIDI clip
 * placed on its lane with the store call EDIT's MIDI import makes, the lane's FX
 * rack opened, then effects added, reordered, bypassed, removed, undone and
 * redone through the rack's own controls, and the rack reopened on the chainless
 * lane. A lane without `fxChain` made the rack's store selector return a new
 * array on every read, React re-rendered forever and threw "Maximum update depth
 * exceeded". An audio lane sits beside the MIDI lane throughout.
 *
 * Then undo to the start and redo to the end across a MIDI clip's background
 * bounce, with the rack open. EDIT decodes peaks for a clip that has none and
 * re-bounces a MIDI clip whose audio does not match its instrument, and undo
 * restores clips in both states. Recorded as edits, those writes emptied the
 * redo stack, so the lane's effects never came back.
 *
 * Renders the real FxChainList with react-dom in jsdom.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!doctype html><html><body><div id="rack-midi"></div><div id="rack-audio"></div><div id="rack-bounce"></div></body></html>',
  { pretendToBeVisual: true, url: 'http://localhost/' },
);
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  'window', 'document', 'HTMLElement', 'Node', 'Element', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'MutationObserver',
]) {
  Object.defineProperty(g, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const consoleErrors: string[] = [];
const realConsoleError = console.error;
console.error = (...args: unknown[]) => {
  consoleErrors.push(args.map(String).join(' '));
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // Imported after the DOM globals exist: react-dom decides at load time
  // whether it runs in a browser.
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useEditorStore } = await import('../../state/editorStore.ts');
  const { RACK_EFFECTS } = await import('../../lib/rackEffects.ts');
  const { FxChainList, chainForScope, effectEntryLabel } = await import('./EffectWindows.tsx');
  const { act } = React;
  const doc = dom.window.document as Document;
  const ed = () => useEditorStore.getState();

  // ── A new arrangement: a MIDI lane and an audio lane ──────────────────────
  ed().loadProject({ tracks: [], clips: [] });
  const midiTrackId = ed().tracks[0].id;
  // The clip addMidiClipFromBytes builds for an imported .mid.
  ed().addClipToTrack({
    trackId: midiTrackId,
    label: 'four-notes',
    audioBlob: new Blob([], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    sourceDuration: 2,
    offsetIntoSource: 0,
    durationSec: 2,
    startSec: 0,
    color: '#a855f7',
    sourceKind: 'piano-roll',
    sourcePianoRoll: [60, 64, 67, 72].map((note, i) => ({ id: `n${i}`, note, step: i * 4, length: 4, velocity: 100 })),
    sourceBpm: 120,
    sourceTotalSteps: 16,
  });
  const audioTrackId = ed().addTrack();
  ed().addClipToTrack({
    trackId: audioTrackId,
    label: 'sine',
    audioBlob: new Blob([], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    sourceDuration: 1,
    offsetIntoSource: 0,
    durationSec: 1,
    startSec: 0,
    color: '#06b6d4',
  });

  const track = (id: string) => ed().tracks.find((t) => t.id === id)!;
  assert.equal(ed().clips.find((c) => c.trackId === midiTrackId)?.sourceKind, 'piano-roll');
  assert.equal(track(midiTrackId).fxChain, undefined, 'the MIDI lane starts with no insert chain');
  assert.equal(track(audioTrackId).fxChain, undefined, 'the audio lane starts with no insert chain');

  const midiScope = { kind: 'track', trackId: midiTrackId } as const;

  // Space the rack edits from the clip inserts so undo has a step that lands
  // on "MIDI on the lane, no chain" (history folds edits closer than 300 ms).
  await sleep(400);

  // ── Open both lanes' racks ────────────────────────────────────────────────
  const midiRoot = createRoot(doc.getElementById('rack-midi')!);
  const audioRoot = createRoot(doc.getElementById('rack-audio')!);
  const renderRack = (root: typeof midiRoot, trackId: string) =>
    root.render(
      React.createElement(FxChainList, {
        scope: { kind: 'track', trackId },
        onOpenEntry: () => undefined,
        // The handler WaveformEditor's track FX popover passes.
        onAddEffect: (effectId: string) => ed().addTrackEffect(trackId, effectId),
        emptyHint: 'No inserts on this track yet',
      }),
    );
  await act(async () => {
    renderRack(midiRoot, midiTrackId);
    renderRack(audioRoot, audioTrackId);
  });
  // Checked after the first render, so a regression fails on the render above
  // with React's "Maximum update depth exceeded" and names the crash.
  assert.equal(
    chainForScope(midiScope),
    chainForScope(midiScope),
    'a chainless lane resolves to the same array on every read',
  );

  const midiRack = doc.getElementById('rack-midi')!;
  const audioRack = doc.getElementById('rack-audio')!;
  const select = () => midiRack.querySelector('select[name="fx-add-effect"]') as HTMLSelectElement | null;
  assert.ok(select(), 'the MIDI lane rack renders its Add effect control');
  assert.ok(audioRack.querySelector('select[name="fx-add-effect"]'), 'the audio lane rack renders too');
  const midiSelectId = select()!.id;
  const audioSelectId = (audioRack.querySelector('select[name="fx-add-effect"]') as HTMLSelectElement).id;
  assert.ok(midiSelectId && audioSelectId && midiSelectId !== audioSelectId, 'each rack select has its own id');
  assert.equal(
    doc.querySelector(`label[for="${midiSelectId}"]`)?.textContent,
    'Add effect',
    'the Add effect select is named by its own label',
  );
  assert.ok(midiRack.textContent?.includes('No inserts on this track yet'));

  const chain = () => track(midiTrackId).fxChain ?? [];
  const ids = () => chain().map((e) => e.effect);
  const pick = async (effectId: string) => {
    const el = select();
    assert.ok(el, 'Add effect control present');
    await act(async () => {
      el.value = effectId;
      el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
  };
  const click = async (el: Element | null | undefined, what: string) => {
    assert.ok(el, `${what} button present`);
    await act(async () => {
      (el as HTMLElement).click();
    });
  };

  // ── Add an effect to the MIDI lane ────────────────────────────────────────
  const first = RACK_EFFECTS[0];
  const second = RACK_EFFECTS[1];
  await pick(first.id);
  assert.deepEqual(ids(), [first.id], 'the effect lands in the MIDI lane chain');
  assert.equal(chain()[0].enabled, true);
  assert.ok(midiRack.textContent?.includes(effectEntryLabel(chain()[0])), 'the rack lists the new insert');
  assert.equal(track(audioTrackId).fxChain, undefined, 'the audio lane is untouched');
  assert.equal(select()?.value, '', 'the add control resets for the next pick');

  // ── A second effect, reorder both ways, bypass, remove ────────────────────
  await pick(second.id);
  assert.deepEqual(ids(), [first.id, second.id]);
  await click(midiRack.querySelectorAll('button[aria-label="Move down"]')[0], 'Move down');
  assert.deepEqual(ids(), [second.id, first.id]);
  await click(midiRack.querySelectorAll('button[aria-label="Move up"]')[1], 'Move up');
  assert.deepEqual(ids(), [first.id, second.id]);
  await click(midiRack.querySelector(`button[aria-label="Bypass ${effectEntryLabel(chain()[0])}"]`), 'Bypass');
  assert.equal(chain()[0].enabled, false);
  await click(midiRack.querySelector(`button[aria-label="Remove ${effectEntryLabel(chain()[1])}"]`), 'Remove');
  assert.deepEqual(ids(), [first.id]);

  // ── The audio lane beside it takes an effect of its own ───────────────────
  const audioSelect = audioRack.querySelector('select[name="fx-add-effect"]') as HTMLSelectElement;
  await act(async () => {
    audioSelect.value = second.id;
    audioSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  assert.deepEqual((track(audioTrackId).fxChain ?? []).map((e) => e.effect), [second.id]);
  assert.deepEqual(ids(), [first.id], 'the MIDI lane chain is unchanged by the audio lane add');

  // ── Undo back to the chainless MIDI lane with the rack still open ─────────
  await act(async () => {
    while (ed()._undo.length > 0 && track(midiTrackId).fxChain !== undefined) ed().undo();
  });
  assert.equal(track(midiTrackId).fxChain, undefined, 'undo returns the lane to no chain');
  assert.equal(ed().clips.find((c) => c.trackId === midiTrackId)?.sourceKind, 'piano-roll', 'the MIDI clip is still on the lane');
  assert.ok(midiRack.textContent?.includes('No inserts on this track yet'), 'the open rack shows the empty lane');

  await act(async () => {
    while (ed()._redo.length > 0) ed().redo();
  });
  assert.deepEqual(ids(), [first.id], 'redo restores the chain');

  // ── Close and reopen the rack on a chainless lane (tab switch and back) ───
  await act(async () => {
    while (ed()._undo.length > 0 && track(midiTrackId).fxChain !== undefined) ed().undo();
  });
  await act(async () => midiRoot.unmount());
  const reopened = createRoot(doc.getElementById('rack-midi')!);
  await act(async () => renderRack(reopened, midiTrackId));
  await pick(second.id);
  assert.deepEqual(ids(), [second.id], 'an effect added after reopening lands in the chain');

  await act(async () => {
    reopened.unmount();
    audioRoot.unmount();
  });

  // ── Undo to the start and redo to the end across a MIDI clip's bounce ─────
  type Clip = ReturnType<typeof ed>['clips'][number];
  const PEAKS_MS = 520;
  const RENDER_MS = 600;
  const bouncedWav = new Blob([new Uint8Array(64)], { type: 'audio/wav' });
  const bouncedPeaks = new Float32Array(8).fill(0.5);
  const silentPeaks = new Float32Array(8);
  let bounces = 0;
  let peakDecodes = 0;
  const rendering = new Set<string>();
  const decoding = new Set<string>();
  const programOf = (c: Clip) => c.instrumentProgram ?? ed().tracks.find((t) => t.id === c.trackId)?.instrumentProgram;
  // EDIT's two background writers, which both run again when undo restores a
  // clip from before they landed. The peaks decode stores peaks for a clip that
  // has none through cachePeaks. The instrument sync renders a MIDI clip whose
  // audio does not match its instrument and stores it through applyClipRender,
  // the write EDIT's MIDI import uses for its first bounce.
  const syncClips = () => {
    for (const c of ed().clips) {
      if (!c.peaks && !decoding.has(c.id)) {
        decoding.add(c.id);
        setTimeout(() => {
          decoding.delete(c.id);
          if (!ed().clips.some((x) => x.id === c.id && !x.peaks)) return;
          peakDecodes += 1;
          ed().cachePeaks(c.id, silentPeaks);
        }, PEAKS_MS);
      }
      const program = programOf(c);
      if (c.sourceKind !== 'piano-roll' || !c.sourcePianoRoll?.length || program === undefined) continue;
      if (program === c.renderedProgram || rendering.has(c.id)) continue;
      rendering.add(c.id);
      setTimeout(() => {
        rendering.delete(c.id);
        const live = ed().clips.find((x) => x.id === c.id);
        if (!live || programOf(live) !== program) return;
        bounces += 1;
        ed().applyClipRender(c.id, { audioBlob: bouncedWav, mimeType: 'audio/wav', renderedProgram: program }, bouncedPeaks);
      }, RENDER_MS);
    }
  };

  const bounceHistory = async (order: 'bounce first' | 'effect first') => {
    ed().loadProject({ tracks: [], clips: [] });
    const laneId = ed().tracks[0].id;
    const unsubscribe = useEditorStore.subscribe(syncClips);
    const host = doc.getElementById('rack-bounce')!;
    const root = createRoot(host);
    await act(async () => renderRack(root, laneId));
    const laneChain = () =>
      (ed().tracks.find((t) => t.id === laneId)?.fxChain ?? []).map((e) => `${e.effect}${e.enabled ? '' : ':off'}`);
    const laneClip = () => ed().clips.find((c) => c.trackId === laneId);
    const rackRows = () => host.querySelectorAll('button[title^="Open "][title$=" controls"]').length;
    const add = async (effectId: string) => {
      const el = host.querySelector('select[name="fx-add-effect"]') as HTMLSelectElement;
      await act(async () => {
        el.value = effectId;
        el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
    };
    // Time passes inside act, so a bounce that lands meanwhile flushes with it.
    const wait = (ms: number) => act(async () => { await sleep(ms); });

    // The clip EDIT's MIDI import adds: silent audio, the instrument it will
    // be bounced with, and no bounce yet.
    await act(async () => {
      ed().addClipToTrack({
        trackId: laneId,
        label: 'bounced-lead',
        audioBlob: new Blob([], { type: 'audio/wav' }),
        mimeType: 'audio/wav',
        sourceDuration: 2,
        offsetIntoSource: 0,
        durationSec: 2,
        startSec: 0,
        color: '#a855f7',
        sourceKind: 'piano-roll',
        sourcePianoRoll: [60, 64, 67, 72].map((note, i) => ({ id: `b${i}`, note, step: i * 4, length: 4, velocity: 100 })),
        sourceBpm: 120,
        sourceTotalSteps: 16,
        instrumentProgram: 1,
      });
    });
    if (order === 'bounce first') {
      await wait(RENDER_MS + 150);
      assert.equal(laneClip()?.renderedProgram, 1, `${order}: the import bounce landed`);
      // Spaced from the bounce, so a bounce recorded as an edit would be its
      // own undo step rather than folding into this one.
      await wait(400);
      await add(first.id);
    } else {
      await wait(400);
      await add(first.id);
      assert.equal(laneClip()?.renderedProgram, undefined, `${order}: the effect landed before the bounce`);
      await wait(RENDER_MS);
      assert.equal(laneClip()?.renderedProgram, 1, `${order}: the import bounce landed`);
    }
    await wait(400);
    await add(second.id);
    await wait(400);
    await click(host.querySelector('button[aria-label^="Bypass "]'), 'Bypass');
    const want = [`${first.id}:off`, second.id];
    assert.deepEqual(laneChain(), want);
    const steps = ed()._undo.length;

    const bouncesBeforeUndo = bounces;
    const decodesBeforeUndo = peakDecodes;
    while (ed()._undo.length > 0) {
      const undo0 = ed()._undo.length;
      const redo0 = ed()._redo.length;
      await act(async () => {
        ed().undo();
        await sleep(RENDER_MS + 150); // a re-bounce lands before the next press
      });
      assert.equal(ed()._undo.length, undo0 - 1, `${order}: each undo steps back once (undo ${undo0} -> ${ed()._undo.length})`);
      assert.equal(ed()._redo.length, redo0 + 1, `${order}: the redo stack survives the re-bounce (redo ${redo0} -> ${ed()._redo.length})`);
      assert.equal(rackRows(), laneChain().length, `${order}: the open rack lists the lane's chain`);
    }
    assert.deepEqual(laneChain(), [], `${order}: undo returns the lane to no effects`);
    assert.equal(laneClip(), undefined, `${order}: undo removes the imported clip`);
    if (order === 'effect first') {
      assert.ok(bounces > bouncesBeforeUndo, `${order}: undo restored the clip from before its bounce and it was bounced again`);
      assert.ok(peakDecodes > decodesBeforeUndo, `${order}: undo restored the clip from before its peaks and they were decoded again`);
    }

    while (ed()._redo.length > 0) {
      await act(async () => {
        ed().redo();
        await sleep(20);
      });
    }
    assert.equal(ed()._undo.length, steps, `${order}: redo returns every step`);
    assert.deepEqual(laneChain(), want, `${order}: redo brings the lane's effects back`);
    assert.equal(rackRows(), want.length, `${order}: the open rack lists them`);
    assert.equal(laneClip()?.renderedProgram, 1, `${order}: the clip comes back bounced`);
    assert.equal(steps, 4, `${order}: the import and three rack edits are four undo steps, and the bounce adds none`);

    unsubscribe();
    await act(async () => root.unmount());
  };
  await bounceHistory('bounce first');
  await bounceHistory('effect first');

  const loops = consoleErrors.filter((m) => /getSnapshot should be cached|Maximum update depth/.test(m));
  assert.deepEqual(loops, [], 'no render loop reported');
  console.error = realConsoleError;
  console.log('EffectWindows lane FX rack test passed');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error = realConsoleError;
    console.error(err);
    const loops = consoleErrors.filter((m) => /getSnapshot should be cached|Maximum update depth/.test(m));
    if (loops.length) console.error(`React reported: ${loops[0]}`);
    process.exit(1);
  },
);
