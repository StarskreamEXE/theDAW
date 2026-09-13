/**
 * convertClient: the names a saved library entry is offered under, and a
 * conversion that fails before anything is saved.
 *
 * entryFileName names every saved copy of a library entry (DETAILS, the
 * player footer, the catalogue menu, Convert to…), so the Save As dialog opens
 * with a name Windows accepts and the right extension on it.
 *
 * Run: `npx tsx src/convert/convertClient.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { convertLibraryEntry, entryAudioFileName, entryFileName, type ConvertFormat } from './convertClient';

// ── entryFileName ───────────────────────────────────────────────────────────
assert.equal(entryFileName('My Song', 'wav'), 'My Song.wav');
assert.equal(entryFileName('My Song', '.WAV'), 'My Song.wav');
assert.equal(entryFileName('take.wav', 'wav'), 'take.wav', 'an extension already on the title is not doubled');
assert.equal(entryFileName('TAKE.WAV', '.wav'), 'TAKE.WAV', 'the extension match ignores case');
assert.equal(entryFileName('a/b:c?', 'mp3'), 'a_b_c_.mp3', 'characters Windows refuses become _');
assert.equal(entryFileName('a\u0001b', 'mp3'), 'a_b.mp3', 'control characters become _');
assert.equal(entryFileName('', 'flac', 'converted'), 'converted.flac');
assert.equal(entryFileName('   ', 'flac'), 'track.flac', 'a blank title falls back');
assert.equal(entryFileName('Song', ''), 'Song', 'no extension adds nothing');
assert.equal(entryFileName('x'.repeat(200), 'wav'), `${'x'.repeat(120)}.wav`, 'the title is capped at 120 characters');

// ── entryAudioFileName ──────────────────────────────────────────────────────
assert.equal(entryAudioFileName({ title: 'Night Drive', audioFilename: 'abc123.FLAC' }), 'Night Drive.flac');
assert.equal(entryAudioFileName({ title: 'Night Drive', audioFilename: '' }), 'Night Drive');
assert.equal(entryAudioFileName({ title: 'Night Drive' }), 'Night Drive');
assert.equal(entryAudioFileName({ title: 'imported.mp3', audioFilename: 'imported.mp3' }), 'imported.mp3');
assert.equal(entryAudioFileName({ title: 'Night Drive', audioFilename: 'C:\\lib\\e1\\take.wav' }), 'Night Drive.wav');

// ── convertLibraryEntry: a failed conversion rejects with the backend's detail
const mp3: ConvertFormat = { id: 'mp3', ext: 'mp3', kind: 'audio', label: 'MP3', mime: 'audio/mpeg' };
const realFetch = globalThis.fetch;
const calls: Array<{ url: string; body: string }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(input), body: String(init?.body ?? '') });
  return new Response(JSON.stringify({ detail: 'ffmpeg is not installed' }), {
    status: 422,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

try {
  await assert.rejects(convertLibraryEntry('entry 1', mp3, 'Song'), /ffmpeg is not installed/);
  assert.equal(calls.length, 1, 'nothing is saved after a failed conversion');
  assert.equal(calls[0].url, '/api/convert/library/entry%201');
  assert.deepEqual(JSON.parse(calls[0].body), { format: 'mp3' });
} finally {
  globalThis.fetch = realFetch;
}

console.log('convertClient tests passed');
