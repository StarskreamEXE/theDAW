/**
 * EDIT's track FX rack across a lane's removal and the undo that restores it.
 *
 * Replays the order the editor produces: effects on a lane, the lane's rack
 * opened from its F button, the lane removed from its header, then undo, redo
 * and undo again. The rack of a removed lane closes and stays closed through
 * every step. A rack open on a neighbouring lane stays open throughout.
 */
import assert from 'node:assert/strict';
import { useEditorStore } from './editorStore.ts';
import { useTrackFxRackStore } from './trackFxRackStore.ts';

const ed = () => useEditorStore.getState();
const rack = () => useTrackFxRackStore.getState();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// History folds edits closer than 300 ms into one undo step; space each edit
// so every undo below lands on the step it names.
const SPACE_MS = 400;

async function main(): Promise<void> {
  // ── An arrangement with two lanes, effects on the second ──────────────────
  ed().loadProject({ tracks: [], clips: [] });
  const keep = ed().tracks[0].id;
  const doomed = ed().addTrack();
  await sleep(SPACE_MS);
  ed().addTrackEffect(doomed, 'reverb');
  await sleep(SPACE_MS);
  assert.equal(ed().tracks.find((t) => t.id === doomed)?.fxChain?.length, 1);

  // ── Its rack opened from the F button, then the lane removed ──────────────
  rack().toggle({ trackId: doomed, x: 240, y: 733 });
  assert.deepEqual(rack().rack, { trackId: doomed, x: 240, y: 733 }, 'the F button opens the lane rack at the click');

  ed().removeTrack(doomed);
  assert.equal(ed().tracks.some((t) => t.id === doomed), false, 'the lane is gone');
  assert.equal(rack().rack, null, 'removing the lane closes its rack in the same write');

  // ── Undo brings the lane back with its effects, and the rack stays shut ───
  ed().undo();
  const restored = ed().tracks.find((t) => t.id === doomed);
  assert.ok(restored, 'undo restores the lane');
  assert.equal(restored?.fxChain?.length, 1, 'undo restores the lane effects');
  assert.equal(rack().rack, null, 'the restored lane rack stays closed after undo');

  ed().redo();
  assert.equal(rack().rack, null, 'redo removes the lane again with the rack closed');
  ed().undo();
  assert.equal(rack().rack, null, 'a second undo still leaves the rack closed');

  // ── The rack reopens on the restored lane only when asked ────────────────
  rack().toggle({ trackId: doomed, x: 240, y: 700 });
  assert.equal(rack().rack?.trackId, doomed, 'the restored lane rack opens from its F button');
  rack().toggle({ trackId: doomed, x: 240, y: 700 });
  assert.equal(rack().rack, null, 'a second F press closes it');

  // ── A neighbour lane's rack survives another lane's removal and undo ─────
  await sleep(SPACE_MS);
  rack().open({ trackId: keep, x: 240, y: 160 });
  ed().removeTrack(doomed);
  assert.equal(rack().rack?.trackId, keep, 'removing a different lane leaves the open rack alone');
  ed().undo();
  assert.equal(rack().rack?.trackId, keep, 'undo leaves the neighbour rack open');

  // ── Toggling another lane moves the rack there ────────────────────────────
  rack().toggle({ trackId: doomed, x: 240, y: 700 });
  assert.equal(rack().rack?.trackId, doomed, 'the F button of another lane moves the rack to that lane');

  // ── A removed lane's id cannot reopen a rack ─────────────────────────────
  await sleep(SPACE_MS);
  ed().removeTrack(doomed);
  assert.equal(rack().rack, null);
  rack().open({ trackId: doomed, x: 1, y: 1 });
  assert.equal(rack().rack, null, 'a stale lane id (a menu opened before the removal) opens nothing');
  ed().undo();
  assert.equal(rack().rack, null, 'and undo after it still leaves the rack closed');

  // ── A project load that replaces the lane closes its rack ─────────────────
  rack().open({ trackId: doomed });
  assert.equal(rack().rack?.trackId, doomed);
  ed().loadProject({ tracks: [], clips: [] });
  assert.equal(rack().rack, null, 'a project load without the lane closes its rack');

  console.log('trackFxRackStore test passed');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
