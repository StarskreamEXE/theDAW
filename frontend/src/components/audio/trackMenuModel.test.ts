// Run with: npx tsx src/components/audio/trackMenuModel.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REASON,
  TRACK_MENU_GROUP_GAP_PX,
  allTrackMenuRows,
  audioExtForMime,
  buildTrackMenu,
  destinationName,
  packTrackMenuColumns,
  parseStemRowId,
  probeChecking,
  probeFailed,
  probeKnown,
  samplerPadName,
  shortFormatLabel,
  stemRowId,
  trackMenuColumnHeight,
  trackMenuGroupHeight,
  trackMenuMaxColumns,
  trackMenuSubjectKind,
  type TrackMenuEntry,
  type TrackMenuFacts,
  type TrackMenuGroup,
  type TrackMenuRow,
  type TrackMenuStem,
} from './trackMenuModel.ts';

const FORMATS = [
  { id: 'wav', label: 'WAV (PCM 16-bit)' },
  { id: 'flac', label: 'FLAC (lossless)' },
  { id: 'mp3', label: 'MP3 (320k)' },
];

/** The nine audio targets /api/convert/formats lists today. */
const ALL_AUDIO_FORMATS = ['wav', 'wav24', 'wav32f', 'flac', 'mp3', 'ogg', 'opus', 'm4a', 'aiff'].map((id) => ({
  id,
  label: id.toUpperCase(),
}));

const LYRICS = 'the names of the chemical elements';

const audioEntry: TrackMenuEntry = {
  id: 'e1',
  title: 'The Elements',
  kind: 'audio',
  model: 'imported',
  prompt: 'Imported from media bucket',
  style: 'scrubstep',
  lyrics: LYRICS,
  favorite: false,
  rating: null,
  analyzed: true,
};

/** Every backend probe answered: no stems, no MIDI, no timings, no melody, no map, nothing running. */
const bareLibrary: TrackMenuFacts = {
  kind: 'library',
  label: 'The Elements',
  entry: audioEntry,
  hasBytes: true,
  stems: probeKnown([]),
  wholeMidi: probeKnown(false),
  notation: probeKnown({ midi: 0, score: 0 }),
  lyricsDoc: probeKnown({ text: LYRICS, timed: false }),
  vocalNotes: probeKnown(false),
  rhythmReady: probeKnown(false),
  audioPath: probeKnown('C:/music/The Elements.mp3'),
  convertFormats: probeKnown(FORMATS),
  runningJob: probeKnown({ stems: false, vocalJobId: null }),
  localClient: true,
  clipboard: true,
  inCrate: false,
  inDjNext: false,
  freeSamplerPad: 0,
  activeSet: { id: 's1', name: 'Friday' },
};

const noTrack: TrackMenuFacts = {
  ...bareLibrary,
  kind: 'none',
  label: '',
  entry: null,
  hasBytes: false,
};

const FOUR_STEMS: TrackMenuStem[] = [
  { id: 'st-drums', name: 'drums', ext: 'wav' },
  { id: 'st-bass', name: 'bass', ext: 'wav' },
  { id: 'st-vocals', name: 'vocals', ext: 'flac' },
  { id: 'st-other', name: 'other', ext: 'wav' },
];

/** Stems, MIDI, a score, timings, a vocal melody and a meter map all exist. */
const derived: TrackMenuFacts = {
  ...bareLibrary,
  stems: probeKnown(FOUR_STEMS),
  wholeMidi: probeKnown(true),
  notation: probeKnown({ midi: 2, score: 1 }),
  lyricsDoc: probeKnown({ text: LYRICS, timed: true }),
  vocalNotes: probeKnown(true),
  rhythmReady: probeKnown(true),
};

const rowsOf = (facts: TrackMenuFacts) => allTrackMenuRows(buildTrackMenu(facts));
const row = (facts: TrackMenuFacts, id: string): TrackMenuRow => {
  const hit = rowsOf(facts).find((r) => r.id === id);
  assert.ok(hit, `row ${id} present`);
  return hit;
};
const groupOf = (facts: TrackMenuFacts, id: string) => buildTrackMenu(facts).find((g) => g.rows.some((r) => r.id === id))?.id;
const enabledIds = (facts: TrackMenuFacts) => rowsOf(facts).filter((r) => r.enabled).map((r) => r.id);

/** Rows that need nothing but a library entry record. */
const ENTRY_ROWS = [
  'dock-details', 'dock-lyric', 'save-bundle', 'save-metadata', 'save-lineage', 'copy-link',
  'show-in-library', 'lineage-graph', 'favorite', 'like', 'dislike', 'edit-meta', 'delete',
];
/** Rows that hand the audio bytes to a destination. */
const BYTES_ROWS = [
  'edit-new-track', 'edit-append', 'mix-source', 'morph-a', 'morph-b', 'make-init', 'make-inpaint',
  'make-chimera', 'midi-detect', 'save-copy', 'save-spectrogram', 'media-bucket', 'convert:wav',
];
/** Rows that act on the output, whatever is loaded. */
const TRACK_ROWS = ['sway', 'dock-levels', 'dock-spectral', 'copy-title'];
/** Rows that start a backend job and must say so. Starring queues four. */
const LONG_JOB_ROWS = [
  'edit-stems', 'loom-crate', 'midi-convert', 'midi-detect', 'run-analysis', 'run-stems', 'run-rhythm',
  'run-shards', 'run-transcribe', 'run-align', 'run-devices', 'run-melody', 'run-chords', 'run-sheet',
  'run-tabs', 'run-arrange', 'run-beatsaber', 'save-bundle', 'save-score-pack', 'save-spectrogram', 'favorite',
];
/** Rows that render the whole-mix MIDI with the synth. */
const SYNTH_ROWS = ['synth-edit', 'synth-init', 'synth-inpaint', 'synth-chimera'];
/** Always-off placeholders drawn while their group has nothing to list. */
const PLACEHOLDER_ROWS = ['convert-formats', 'stem-each'];

// (a) Kind resolution: the four footer states.
{
  assert.equal(trackMenuSubjectKind({ hasTrack: false, entryId: 'e1' }, true), 'none');
  assert.equal(trackMenuSubjectKind({ hasTrack: true, entryId: 'e1' }, true), 'library');
  assert.equal(trackMenuSubjectKind({ hasTrack: true, entryId: 'editor-timeline' }, false), 'editor');
  // A stem row, the MIX output and the MIDI beat load with no entry id.
  assert.equal(trackMenuSubjectKind({ hasTrack: true, entryId: null }, false), 'loose');
  // An entry deleted while it played is no longer a library entry.
  assert.equal(trackMenuSubjectKind({ hasTrack: true, entryId: 'gone' }, false), 'loose');
}

// (b) The menu's shape: twelve groups in reading order, unique row ids, and a
// reason exactly on the rows that are off.
{
  const groups = buildTrackMenu(bareLibrary);
  assert.deepEqual(
    groups.map((g) => g.id),
    ['play', 'open', 'make', 'dock', 'midi', 'dj', 'analyze', 'copy', 'save', 'convert', 'library', 'stems'],
  );
  assert.deepEqual(
    groups.map((g) => g.label),
    ['Play', 'Open in', 'Use in MAKE', 'Open in the dock', 'MIDI', 'DJ', 'Analyze and extract', 'Copy and show',
      'Save', 'Convert and save', 'Library', 'Stems'],
  );
  for (const facts of [bareLibrary, noTrack, derived]) {
    const ids = rowsOf(facts).map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'row ids are unique');
    for (const r of rowsOf(facts)) {
      assert.equal(r.enabled, r.reason === null, `${r.id}: enabled iff no reason`);
      assert.equal(r.title, r.reason ?? r.does, `${r.id}: the tooltip is the reason when off`);
      assert.ok(r.label.trim().length > 0 && r.does.trim().length > 0, `${r.id} has a label and a description`);
      // A stem key shows only its icon; its label is what a screen reader hears.
      if (!r.line) assert.ok(r.label.length <= 25, `${r.id} label "${r.label}" fits a 248px column`);
    }
  }
  // The same rows exist whatever is loaded, so the menu never reflows under the hand.
  assert.deepEqual(rowsOf(noTrack).map((r) => r.id), rowsOf(bareLibrary).map((r) => r.id));

  // Rows sit with their group's job.
  assert.equal(groupOf(bareLibrary, 'run-cover'), 'library');
  assert.equal(groupOf(bareLibrary, 'load-lyrics'), 'library');
  assert.equal(groupOf(bareLibrary, 'media-bucket'), 'open');
  assert.equal(groupOf(bareLibrary, 'melody-roll'), 'midi');
  assert.equal(groupOf(bareLibrary, 'stop-job'), 'analyze');
  for (const id of SYNTH_ROWS) assert.equal(groupOf(bareLibrary, id), 'midi');
}

// (c) No track: every row is off and says to load one.
{
  for (const r of rowsOf(noTrack)) {
    assert.equal(r.enabled, false, `${r.id} is off with nothing loaded`);
    assert.equal(r.reason, REASON.noTrack, `${r.id} says to load a track`);
  }
}

// (d) A library audio entry with nothing derived yet.
{
  const on = new Set(enabledIds(bareLibrary));
  for (const id of [...ENTRY_ROWS, ...BYTES_ROWS, ...TRACK_ROWS]) assert.ok(on.has(id), `${id} is on for a library entry`);
  for (const id of ['play-library', 'play-mix', 'edit-stems', 'loom-crate', 'nodefi-library', 'vj-send', 'dock-score',
    'dock-sing', 'dock-study', 'dock-midi', 'dock-draw', 'make-prompt', 'midi-convert', 'run-analysis', 'run-stems',
    'run-rhythm', 'run-shards', 'run-transcribe', 'run-align', 'run-devices', 'run-melody', 'run-chords', 'run-cover',
    'dj-deck-a', 'dj-deck-b', 'dj-next', 'dj-pad', 'dj-set', 'dj-automix', 'save-txt', 'show-in-folder', 'copy-path',
    'copy-prompt', 'copy-style', 'copy-lyrics', 'load-lyrics']) {
    assert.ok(on.has(id), `${id} is on for an analyzed audio entry with lyrics`);
  }
  // What needs stems, MIDI, a score, timings, a melody or a map says which step comes first.
  assert.equal(row(bareLibrary, 'nodefi-stems').reason, REASON.noStems);
  assert.equal(row(bareLibrary, 'stem-each').reason, REASON.noStems);
  for (const id of ['midi-roll', 'midi-step', 'midi-groove', 'run-sheet', 'save-midi', ...SYNTH_ROWS]) {
    assert.equal(row(bareLibrary, id).reason, REASON.noMidi, `${id} waits on Convert to MIDI`);
  }
  for (const id of ['run-tabs', 'run-arrange', 'run-beatsaber']) assert.equal(row(bareLibrary, id).reason, REASON.noMidi);
  assert.equal(row(bareLibrary, 'melody-roll').reason, REASON.noVocalNotes);
  assert.equal(row(bareLibrary, 'save-score-pack').reason, REASON.noScore);
  assert.equal(row(bareLibrary, 'save-lrc').reason, REASON.noTimedLyrics);
  assert.equal(row(bareLibrary, 'save-meter-map').reason, REASON.noRhythm);
  assert.equal(row(bareLibrary, 'stop-job').reason, REASON.noRunningJob);
  assert.equal(row(bareLibrary, 'suno-cover').reason, REASON.notSuno);
  assert.equal(row(bareLibrary, 'suno-mashup').reason, REASON.notSuno);
  assert.equal(row(bareLibrary, 'import').reason, REASON.alreadyInLibrary);

  // Long jobs are marked, and nothing else is.
  for (const r of rowsOf(bareLibrary)) {
    assert.equal(r.longJob, LONG_JOB_ROWS.includes(r.id), `${r.id} long-job flag`);
  }
  assert.equal(buildTrackMenu(bareLibrary).find((g) => g.id === 'convert')?.longJob, true);
  assert.match(row(bareLibrary, 'favorite').does, /queues stems, lyrics, MIDI and a score/);

  // Rows that replace or pick say so.
  assert.match(row(bareLibrary, 'midi-detect').does, /in place of the roll's notes/);
  assert.match(row(bareLibrary, 'run-stems').does, /Pick the stem count/);
  assert.match(row(bareLibrary, 'midi-convert').does, /from-stems setting/);
  assert.doesNotMatch(row(bareLibrary, 'edit-meta').does, /sheet/);

  // Each row that switches tabs names the right one.
  const goes = (id: string, facts = bareLibrary) => row(facts, id).goes;
  assert.deepEqual(goes('edit-new-track'), { area: 'center', tab: 'edit' });
  assert.deepEqual(goes('edit-stems'), { area: 'center', tab: 'edit' });
  assert.deepEqual(goes('mix-source'), { area: 'center', tab: 'mix' });
  assert.deepEqual(goes('morph-a'), { area: 'center', tab: 'edit' });
  assert.deepEqual(goes('loom-crate'), { area: 'center', tab: 'loom' });
  assert.deepEqual(goes('nodefi-library'), { area: 'center', tab: 'nodefi' });
  assert.deepEqual(goes('sway'), { area: 'center', tab: 'sway' });
  assert.deepEqual(goes('make-chimera'), { area: 'center', tab: 'make' });
  assert.deepEqual(goes('suno-cover'), { area: 'center', tab: 'make' });
  assert.deepEqual(goes('dj-deck-b'), { area: 'center', tab: 'dj' });
  assert.deepEqual(goes('dj-automix'), { area: 'center', tab: 'dj' });
  assert.deepEqual(goes('dock-details'), { area: 'dock', tab: 'details' });
  assert.deepEqual(goes('dock-study'), { area: 'dock', tab: 'sing' });
  assert.deepEqual(goes('dock-levels'), { area: 'dock', tab: 'levels' });
  assert.deepEqual(goes('midi-roll'), { area: 'dock', tab: 'midi' });
  assert.deepEqual(goes('midi-step'), { area: 'dock', tab: 'step-seq' });
  assert.deepEqual(goes('melody-roll'), { area: 'dock', tab: 'midi' });
  assert.deepEqual(goes('synth-edit'), { area: 'center', tab: 'edit' });
  assert.deepEqual(goes('synth-inpaint'), { area: 'center', tab: 'make' });
  assert.deepEqual(goes('run-chords'), { area: 'dock', tab: 'score' });
  assert.deepEqual(goes('show-in-library'), { area: 'library' });
  assert.equal(goes('vj-send'), null, 'the VJ set waits for VJ; it does not open it');
  assert.equal(goes('run-stems'), null);
  assert.equal(goes('dj-next'), null);
  assert.equal(goes('stop-job'), null);
  assert.equal(destinationName({ area: 'center', tab: 'nodefi' }), 'NodeF.I.');
  assert.equal(destinationName({ area: 'dock', tab: 'step-seq' }), 'STEP SEQ');
  assert.equal(destinationName({ area: 'library' }), 'the library');

  // Convert lists the formats as chips.
  const convert = buildTrackMenu(bareLibrary).find((g) => g.id === 'convert');
  assert.deepEqual(convert?.rows.map((r) => r.label), ['WAV', 'FLAC', 'MP3']);
  assert.ok(convert?.rows.every((r) => r.chip && r.enabled));
  assert.equal(row(bareLibrary, 'delete').danger, true);
}

// (e) An entry with stems, MIDI, a score, timings, a melody and a map: the rows waiting on them come on.
{
  const on = new Set(enabledIds(derived));
  for (const id of ['nodefi-stems', 'midi-roll', 'midi-step', 'midi-groove', 'run-sheet', 'run-tabs', 'run-arrange',
    'run-beatsaber', 'save-midi', 'save-score-pack', 'save-lrc', 'save-meter-map', 'melody-roll', ...SYNTH_ROWS]) {
    assert.ok(on.has(id), `${id} is on once stems, MIDI, a score, timings, a melody and a map exist`);
  }
  // A score alone (no MIDI artifact) is enough for Beat Saber but not for tab.
  const scoreOnly: TrackMenuFacts = { ...derived, notation: probeKnown({ midi: 0, score: 1 }) };
  assert.equal(row(scoreOnly, 'run-beatsaber').enabled, true);
  assert.equal(row(scoreOnly, 'run-tabs').reason, REASON.noMidi);

  // One line per stem, five keys each, in the stem group only.
  const stems = buildTrackMenu(derived).find((g) => g.id === 'stems') as TrackMenuGroup;
  assert.equal(stems.rows.length, FOUR_STEMS.length * 5);
  assert.ok(stems.rows.every((r) => r.enabled && r.line !== null && !r.chip));
  assert.deepEqual([...new Set(stems.rows.map((r) => r.line?.label))], ['drums', 'bass', 'vocals', 'other']);
  assert.deepEqual(
    stems.rows.filter((r) => r.line?.key === 'st-vocals').map((r) => r.id),
    ['edit', 'init', 'inpaint', 'chimera', 'save'].map((a) => stemRowId(a, 'st-vocals')),
  );
  assert.equal(row(derived, stemRowId('init', 'st-bass')).label, 'bass: Init audio');
  assert.deepEqual(row(derived, stemRowId('edit', 'st-bass')).goes, { area: 'center', tab: 'edit' });
  assert.deepEqual(row(derived, stemRowId('chimera', 'st-bass')).goes, { area: 'center', tab: 'make' });
  assert.equal(row(derived, stemRowId('save', 'st-bass')).goes, null);
  assert.equal(trackMenuGroupHeight(stems), 24 + FOUR_STEMS.length * 24, 'a stem line is one row tall');
  assert.ok(!rowsOf(derived).some((r) => r.id === 'stem-each'));
  // Stem keys are for library audio entries only.
  const video: TrackMenuFacts = { ...derived, entry: { ...audioEntry, kind: 'video' } };
  assert.equal(row(video, 'stem-each').reason, REASON.notAudio);

  assert.deepEqual(parseStemRowId(stemRowId('save', 'a:b')), { action: 'save', stemId: 'a:b' });
  assert.equal(parseStemRowId('stop-job'), null);
  assert.equal(parseStemRowId('stem:save:'), null);

  // The Stop row comes on for a running separation or a vocal job the menu started, and says which.
  const stemsRunning: TrackMenuFacts = { ...bareLibrary, runningJob: probeKnown({ stems: true, vocalJobId: null }) };
  assert.equal(row(stemsRunning, 'stop-job').enabled, true);
  assert.equal(row(stemsRunning, 'stop-job').does, 'Stop the stem separation running for it');
  const vocalRunning: TrackMenuFacts = { ...bareLibrary, runningJob: probeKnown({ stems: false, vocalJobId: 'j1' }) };
  assert.equal(row(vocalRunning, 'stop-job').does, 'Stop the vocal melody job running for it');
  const both: TrackMenuFacts = { ...bareLibrary, runningJob: probeKnown({ stems: true, vocalJobId: 'j1' }) };
  assert.match(row(both, 'stop-job').does, /stem separation and the vocal melody job/);
}

// (f) The EDIT timeline playing live: not an entry, no bytes, but it is audible.
{
  const editorLive: TrackMenuFacts = { ...noTrack, kind: 'editor', label: 'Editor Timeline', hasBytes: false };
  const on = new Set(enabledIds(editorLive));
  assert.deepEqual([...on].sort(), [...TRACK_ROWS].sort(), 'only the output rows are on');
  for (const id of ENTRY_ROWS) assert.equal(row(editorLive, id).reason, REASON.editorNotEntry, `${id} explains the timeline`);
  for (const id of BYTES_ROWS) assert.equal(row(editorLive, id).reason, REASON.editorLive, `${id} asks for a mixdown`);
  assert.equal(row(editorLive, 'import').reason, REASON.editorLive);
  assert.equal(row(editorLive, 'copy-title').enabled, true);

  // An editor render the player holds bytes for: the audio destinations come on,
  // and it can be saved to the library; entry rows stay off.
  const editorRender: TrackMenuFacts = { ...editorLive, hasBytes: true };
  for (const id of BYTES_ROWS) assert.equal(row(editorRender, id).enabled, true, `${id} takes the rendered bytes`);
  assert.equal(row(editorRender, 'import').enabled, true);
  assert.equal(row(editorRender, 'dock-details').reason, REASON.editorNotEntry);
}

// (g) A loose track (a stem, a MIX render) with bytes.
{
  const stem: TrackMenuFacts = { ...noTrack, kind: 'loose', label: 'The Elements · vocals', hasBytes: true };
  for (const id of BYTES_ROWS) assert.equal(row(stem, id).enabled, true, `${id} works on a stem`);
  for (const id of ENTRY_ROWS) assert.equal(row(stem, id).reason, REASON.looseNotEntry);
  assert.equal(row(stem, 'import').enabled, true);
  assert.equal(row(stem, 'stem-each').reason, REASON.looseNotEntry);
  const unreadable: TrackMenuFacts = { ...stem, hasBytes: false };
  assert.equal(row(unreadable, 'save-copy').reason, REASON.noBytes);
}

// (h) Probes that have not answered keep their rows off, and a failed probe says so.
{
  const pending: TrackMenuFacts = {
    ...bareLibrary,
    stems: probeChecking(),
    wholeMidi: probeChecking(),
    notation: probeChecking(),
    lyricsDoc: probeChecking(),
    vocalNotes: probeChecking(),
    rhythmReady: probeChecking(),
    audioPath: probeChecking(),
    convertFormats: probeChecking(),
    runningJob: probeChecking(),
  };
  for (const id of ['nodefi-stems', 'stem-each', 'midi-roll', 'synth-init', 'melody-roll', 'run-tabs', 'save-lrc',
    'save-txt', 'run-align', 'run-devices', 'save-meter-map', 'show-in-folder', 'copy-path', 'stop-job']) {
    assert.equal(row(pending, id).reason, REASON.checking, `${id} waits for its check`);
  }
  // The record's own lyrics can be copied before the lyrics document answers.
  assert.equal(row(pending, 'copy-lyrics').enabled, true);
  const convert = buildTrackMenu(pending).find((g) => g.id === 'convert');
  assert.equal(convert?.rows.length, 1);
  assert.equal(convert?.rows[0].reason, REASON.checking);
  // Rows that need no probe are live at once.
  assert.equal(row(pending, 'edit-new-track').enabled, true);

  const oldBackend: TrackMenuFacts = { ...bareLibrary, audioPath: probeFailed(REASON.pathRouteMissing) };
  assert.equal(row(oldBackend, 'show-in-folder').reason, REASON.pathRouteMissing);
  assert.equal(row({ ...bareLibrary, audioPath: probeFailed() }, 'copy-path').reason, REASON.probeFailed);
  assert.equal(row({ ...bareLibrary, audioPath: probeKnown(null) }, 'copy-path').reason, REASON.noPath);
  assert.equal(row({ ...bareLibrary, convertFormats: probeKnown([]) }, 'convert-formats').reason, REASON.noFormats);
}

// (i) Per-entry gates.
{
  const notLocal = { ...bareLibrary, localClient: false };
  assert.equal(row(notLocal, 'show-in-folder').reason, REASON.notLocal);
  assert.equal(row(notLocal, 'copy-path').enabled, true, 'a remote window can still copy the path');
  assert.equal(row({ ...bareLibrary, clipboard: false }, 'copy-link').reason, REASON.noClipboard);

  const raw: TrackMenuFacts = {
    ...bareLibrary,
    entry: { ...audioEntry, analyzed: false, lyrics: '', prompt: '', style: '' },
    lyricsDoc: probeKnown({ text: '', timed: false }),
  };
  for (const id of ['play-mix', 'make-prompt', 'dj-automix']) assert.equal(row(raw, id).reason, REASON.notAnalyzed);
  for (const id of ['run-align', 'run-devices', 'save-txt', 'copy-lyrics']) assert.equal(row(raw, id).reason, REASON.noLyrics);
  assert.equal(row(raw, 'copy-prompt').reason, REASON.noPrompt);
  assert.equal(row(raw, 'copy-style').reason, REASON.noStyle);

  // Words the backend reads (embedded in the file, or lyrics: tags) with an empty
  // lyrics field: every lyrics row is on.
  const embedded: TrackMenuFacts = { ...raw, lyricsDoc: probeKnown({ text: 'la la la', timed: false }) };
  for (const id of ['run-align', 'run-devices', 'save-txt', 'copy-lyrics']) assert.equal(row(embedded, id).enabled, true, `${id} reads the backend's words`);

  // Words only in the notes or the analysis (deriveLyrics' last resorts): they can be
  // copied, but the backend has none to align, analyze or export.
  const notesOnly: TrackMenuFacts = { ...raw, entry: { ...audioEntry, lyrics: 'pasted into the notes' } };
  notesOnly.lyricsDoc = probeKnown({ text: '', timed: false });
  assert.equal(row(notesOnly, 'copy-lyrics').enabled, true);
  for (const id of ['run-align', 'run-devices', 'save-txt']) assert.equal(row(notesOnly, id).reason, REASON.noLyrics);

  const suno: TrackMenuFacts = { ...bareLibrary, entry: { ...audioEntry, model: 'suno' } };
  assert.equal(row(suno, 'suno-cover').enabled, true);
  assert.equal(row(suno, 'suno-mashup').enabled, true);

  const video: TrackMenuFacts = { ...bareLibrary, entry: { ...audioEntry, kind: 'video' } };
  for (const id of ['edit-new-track', 'make-init', 'run-stems', 'dj-deck-a', 'save-copy', 'load-lyrics', 'synth-edit']) {
    assert.equal(row(video, id).reason, REASON.notAudio, `${id} needs audio`);
  }
  assert.equal(row(video, 'dock-details').enabled, true);

  const faved: TrackMenuFacts = { ...bareLibrary, entry: { ...audioEntry, favorite: true, rating: 'like' } };
  assert.equal(row(faved, 'favorite').label, 'Remove from favorites');
  assert.equal(row(faved, 'favorite').longJob, false, 'taking the star off queues nothing');
  assert.equal(row(faved, 'like').label, 'Remove the like');
  assert.equal(row(faved, 'dislike').label, 'Dislike');
  assert.equal(row(bareLibrary, 'favorite').label, 'Add to favorites');
}

// (j) DJ gates, names and small helpers.
{
  assert.equal(row({ ...bareLibrary, inDjNext: true }, 'dj-next').reason, REASON.inDjNext);
  assert.equal(row({ ...bareLibrary, inCrate: true }, 'loom-crate').reason, REASON.inCrate);
  assert.equal(row({ ...bareLibrary, activeSet: null }, 'dj-set').reason, REASON.noSet);
  assert.match(row(bareLibrary, 'dj-set').does, /"Friday"/);
  assert.equal(row({ ...bareLibrary, freeSamplerPad: null }, 'dj-pad').reason, REASON.noPad);
  assert.equal(row({ ...bareLibrary, freeSamplerPad: 2 }, 'dj-pad').label, 'Sampler pad 3');
  assert.equal(samplerPadName(9), '0', 'the tenth pad is 0, as the DJ sampler draws it');
  assert.equal(shortFormatLabel('wav32f'), 'WAV 32F');
  assert.equal(shortFormatLabel('weird'), 'WEIRD');
  assert.equal(audioExtForMime('audio/mpeg'), 'mp3');
  assert.equal(audioExtForMime('audio/webm;codecs=opus'), 'webm');
  assert.equal(audioExtForMime('AUDIO/X-WAV'), 'wav');
  assert.equal(audioExtForMime(''), 'wav');
}

// (k) Packing: groups stay whole and in order, the fewest columns that fit are
// used, and a screen too short for them spreads them and scrolls.
{
  const groups = buildTrackMenu(bareLibrary);
  const tallest = Math.max(...groups.map(trackMenuGroupHeight));
  const flat = (cols: TrackMenuGroup[][]) => cols.flat().map((g) => g.id);
  const colHeight = (col: TrackMenuGroup[]) =>
    col.reduce((h, g, i) => h + (i ? TRACK_MENU_GROUP_GAP_PX : 0) + trackMenuGroupHeight(g), 0);

  // The chip group: a heading plus one line for three formats, three lines for nine.
  assert.equal(trackMenuGroupHeight(groups.find((g) => g.id === 'convert') as TrackMenuGroup), 24 + 28);
  const nine = buildTrackMenu({ ...bareLibrary, convertFormats: probeKnown(ALL_AUDIO_FORMATS) });
  assert.equal(trackMenuGroupHeight(nine.find((g) => g.id === 'convert') as TrackMenuGroup), 24 + 3 * 28);

  const small = packTrackMenuColumns(groups, { maxColumns: 5, columnHeightPx: 600 });
  assert.equal(small.fits, true);
  assert.deepEqual(flat(small.columns), groups.map((g) => g.id), 'reading order is menu order');
  assert.ok(small.columns.every((c) => colHeight(c) <= 600));
  // One column fewer cannot hold them, so the count is the minimum.
  const oneFewer = packTrackMenuColumns(groups, { maxColumns: small.columns.length - 1, columnHeightPx: 600 });
  assert.equal(oneFewer.fits, false);

  // A screen too short: spread across the cap, flagged to scroll, nothing lost.
  const squeezed = packTrackMenuColumns(groups, { maxColumns: 2, columnHeightPx: tallest });
  assert.equal(squeezed.fits, false);
  assert.equal(squeezed.columns.length, 2);
  assert.deepEqual(flat(squeezed.columns), groups.map((g) => g.id));
  assert.equal(packTrackMenuColumns(groups, { maxColumns: 0, columnHeightPx: 600 }).columns.length, 1);
}

// (l) The two screens the menu must fit, with every audio format listed. The
// footer's key sits about 730px down a 768px screen and 1042px down a 1080px
// one; the card keeps 10px from it and from the top.
{
  const FIVE = [
    ['play', 'open', 'make'],
    ['dock', 'midi'],
    ['dj', 'analyze'],
    ['copy', 'save', 'convert'],
    ['library', 'stems'],
  ];
  assert.equal(trackMenuMaxColumns(1366), 5);
  assert.equal(trackMenuMaxColumns(1920), 6);
  assert.equal(trackMenuMaxColumns(320), 1);
  assert.equal(trackMenuColumnHeight(1032), 640);
  assert.equal(trackMenuColumnHeight(720), 634);

  // No stems, four, and the twelve a 12-stem separation makes: Stems is last,
  // so its height moves no group, and every row stays in view without scrolling.
  const twelve: TrackMenuStem[] = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `stem ${i}`, ext: 'wav' }));
  for (const stems of [[], FOUR_STEMS, twelve]) {
    const groups = buildTrackMenu({ ...derived, stems: probeKnown(stems), convertFormats: probeKnown(ALL_AUDIO_FORMATS) });
    const at1366 = packTrackMenuColumns(groups, { maxColumns: trackMenuMaxColumns(1366), columnHeightPx: trackMenuColumnHeight(720) });
    assert.equal(at1366.fits, true, `1366x768 shows every row without scrolling (${stems.length} stems)`);
    assert.deepEqual(at1366.columns.map((c) => c.map((g) => g.id)), FIVE, `1366x768 arrangement (${stems.length} stems)`);
    // A taller screen keeps the same columns: the column height is capped.
    const at1920 = packTrackMenuColumns(groups, { maxColumns: trackMenuMaxColumns(1920), columnHeightPx: trackMenuColumnHeight(1032) });
    assert.equal(at1920.fits, true, `1920x1080 shows every row without scrolling (${stems.length} stems)`);
    assert.deepEqual(at1920.columns.map((c) => c.map((g) => g.id)), FIVE, 'both screens put every group in the same place');
  }

  // 1280x720 has neither the height nor the width for five whole columns, so
  // the card spreads the groups over four and scrolls.
  const groups = buildTrackMenu({ ...bareLibrary, convertFormats: probeKnown(ALL_AUDIO_FORMATS) });
  const at1280 = packTrackMenuColumns(groups, { maxColumns: trackMenuMaxColumns(1280), columnHeightPx: trackMenuColumnHeight(672) });
  assert.equal(at1280.columns.length, 4);
  assert.equal(at1280.fits, false);
}

// (m) Every row the menu can build has an action. A row id with no case in
// trackMenuActions.ts would fail only at click time.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'trackMenuActions.ts'), 'utf8');
  const withFormats: TrackMenuFacts = { ...derived, convertFormats: probeKnown(ALL_AUDIO_FORMATS) };
  const ids = new Set([
    ...rowsOf(withFormats).map((r) => r.id),
    ...rowsOf(bareLibrary).map((r) => r.id),
    ...rowsOf({ ...bareLibrary, entry: { ...audioEntry, favorite: true, rating: 'like' } }).map((r) => r.id),
  ]);
  assert.ok(source.includes("row.id.startsWith('convert:')"), 'the convert chips have a handler');
  assert.ok(source.includes('parseStemRowId(row.id)'), 'the stem keys have a handler');
  for (const id of ids) {
    if (PLACEHOLDER_ROWS.includes(id)) continue;
    if (id.startsWith('convert:')) continue;
    const stemKey = parseStemRowId(id);
    if (stemKey) {
      assert.ok(source.includes(`case '${stemKey.action}':`), `stem key ${stemKey.action} has a case`);
      continue;
    }
    assert.ok(source.includes(`case '${id}':`), `row ${id} has a case in trackMenuActions.ts`);
  }
  // Placeholders never run: they are off in every state they appear in.
  for (const facts of [bareLibrary, noTrack, { ...bareLibrary, convertFormats: probeChecking<never>() }]) {
    for (const r of rowsOf(facts).filter((x) => PLACEHOLDER_ROWS.includes(x.id))) {
      assert.equal(r.enabled, false, `${r.id} is never enabled`);
    }
  }
}

console.log('trackMenuModel: all assertions passed');
