/**
 * T20 re-audit items 6 and 7 (Shell.tsx).
 *
 * Item 6 (INTEGRATION): nothing in the UI ever produced the LAN pairing
 * token link — `GET /api/pairing/token` (backend/lib/pairing.py) had no
 * caller anywhere in frontend/src, and no code appended `#pair=<token>` to
 * any share link. This asserts Shell now fetches that route and appends the
 * token to the companion URL as a fragment, and that a failed fetch cannot
 * break the existing link (no unguarded `.then`/throw on failure).
 *
 * Item 7 (INTEGRATION): the XR posture code and the LAN pairing token both
 * used the key name `pair` — the query string for the XR code, the URL
 * fragment for the token — never colliding in code, but RemoteGate told
 * users holding a pairing token to paste it into the QUERY string, where it
 * would silently fail as a posture code. Shell's companion link now uses
 * `?xrcode=` for the XR posture code, keeping `#pair=` free for the actual
 * LAN pairing token.
 *
 * P-20260921-lan-https (below the T20 sections): the same share panel now
 * hands out the LAN **https** address when the launcher has a TLS listener up,
 * because AudioWorklet, the microphone and Web MIDI exist only in a secure
 * context and a plain-http LAN link ships a broken EDIT tab to every device
 * that scans the QR.
 *
 * Shell needs the full app-store tree mounted to exercise this at runtime,
 * so per the house pattern for a component-only fix (see Shell.test.ts /
 * audioEditorPanelWiring.test.ts) this asserts the wiring at SOURCE level.
 *
 * Run: `npx tsx src/components/layout/Shell.pairing.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'Shell.tsx'),
  'utf8',
);

// ── item 6: the pairing-token route is actually called ─────────────────
assert.match(
  source,
  /fetch\(\s*['"]\/api\/pairing\/token['"]/,
  'Shell must call GET /api/pairing/token to mint the LAN pairing link',
);

const pairingEffectStart = source.indexOf("fetch('/api/pairing/token'");
assert.ok(pairingEffectStart >= 0, 'the pairing-token fetch must be present');
// The fetch chain (through its .catch) must sit within a bounded window of
// source — proves the .catch actually belongs to THIS fetch call, not some
// unrelated one elsewhere in the file.
const pairingChain = source.slice(pairingEffectStart, pairingEffectStart + 700);
assert.match(
  pairingChain,
  /\.catch\(/,
  'the pairing-token fetch must have a .catch — a failed fetch (no backend yet, gate rejected) must not throw and break the existing companion link',
);

// ── companionUrl appends the token as a URL FRAGMENT, not a query param ──
const companionUrlStart = source.indexOf('const companionUrl = useMemo');
assert.ok(companionUrlStart >= 0, 'companionUrl must still be defined');
const companionUrlBody = source.slice(companionUrlStart, source.indexOf('\n', source.indexOf('}, [', companionUrlStart)));
assert.match(
  companionUrlBody,
  /#pair=/,
  'companionUrl must append the LAN pairing token as `#pair=<token>` (a URL fragment, per lib/pairing.ts — never a server-visible query param)',
);

// ── item 7: the XR posture code moved to ?xrcode=, not ?pair= ──────────
assert.match(
  companionUrlBody,
  /\?xrcode=/,
  'companionUrl must build the XR posture code as ?xrcode=, not ?pair= (which now names the LAN pairing token instead)',
);
assert.doesNotMatch(
  companionUrlBody,
  /\?pair=/,
  'companionUrl must not build the XR posture-code query as ?pair= — that name now belongs to the LAN pairing token fragment',
);

// ══ P-20260921-lan-https: the shared link is the SECURE one when there is one ══
//
// A browser exposes AudioContext.audioWorklet, the microphone, Web MIDI, the
// clipboard and crypto.subtle only in a secure context. A phone or second PC
// opening `http://<lan-ip>:5173` is neither https nor localhost, so the EDIT
// tab died there with "Cannot read properties of undefined (reading
// 'addModule')". The launcher now runs a TLS listener beside the http one and
// `GET /api/network/lan` reports its address as `https_url` while it is up;
// handing out the plain-http address anyway would ship a broken app to every
// device that scans the QR.

// ── the share URL comes from /api/network/lan ──────────────────────────────
assert.match(
  source,
  /fetch\(\s*['"]\/api\/network\/lan['"]/,
  'Shell must read the LAN address from GET /api/network/lan — the route that also reports the https listener',
);
assert.doesNotMatch(
  source,
  /\/api\/vj\/lan-ip/,
  'the old /api/vj/lan-ip call must be gone: it only ever returns an IP, so a Shell still using it can never ' +
    'offer the https address and would keep handing phones a link with no audio',
);

const lanFetchStart = source.indexOf("fetch('/api/network/lan'");
assert.ok(lanFetchStart >= 0, 'the LAN fetch must be present');
// Bounded window, as above: proves these belong to THIS fetch's chain.
const lanChain = source.slice(lanFetchStart, lanFetchStart + 1200);
assert.match(
  lanChain,
  /\.catch\(/,
  'the LAN fetch must have a .catch — no backend yet, or no LAN, must not throw out of the effect',
);
assert.match(lanChain, /https_url/, 'the response`s https_url must actually be read');
assert.match(
  lanChain,
  /startsWith\(\s*['"]https:\/\/['"]\s*\)/,
  'only an https:// address may be treated as the secure one — swapping one insecure origin for another fixes nothing',
);
assert.match(
  lanChain,
  /setLanHttpsUrl\(/,
  'the https address must be kept, so the certificate note and the AudioWorklet notice can name it',
);
assert.match(
  lanChain,
  /lanReachablePort\(\)/,
  'with no listener up, the http link must still be built exactly as before (packaged app has no window port)',
);

// ── the companion link rides the same base, so it is https too ─────────────
assert.match(
  companionUrlBody,
  /const base = \(shareUrl \|\| ''\)/,
  'the companion URL must be derived from shareUrl, so the secure address reaches the phone companion too',
);

// ── the note that tells the user what the certificate warning is ───────────
assert.match(
  source,
  /Secure address/,
  'the share panel must say the link is the secure one',
);
assert.match(
  source,
  /The first visit shows a certificate warning; choose Proceed\./,
  'and must warn about the self-signed certificate prompt — an unexplained browser warning reads as a broken ' +
    'link and the user stops there',
);
const noteStart = source.indexOf('Secure address');
const noteContext = source.slice(Math.max(0, noteStart - 300), noteStart);
assert.match(
  noteContext,
  /shareUrlIsLanHttps/,
  'the certificate note must be gated on THIS machine`s own listener being the link — a pasted Cloudflare ' +
    'tunnel URL is https too, and shows no certificate warning at all',
);
const gateStart = source.indexOf('const shareUrlIsLanHttps');
assert.ok(gateStart >= 0, 'shareUrlIsLanHttps must be defined');
assert.match(
  source.slice(gateStart, source.indexOf('\n', gateStart)),
  /shareUrl === lanHttpsUrl/,
  'the gate must compare the URL actually being shared against the detected listener, so the override wins',
);

// ── the AudioWorklet notice is told the address ────────────────────────────
assert.match(
  source,
  /<AudioWorkletUnavailableNotice\s+secureUrl=\{lanHttpsUrl \|\| null\}/,
  'the standing "audio is switched off on this address" notice must name the https address when one exists — ' +
    'that notice is what the affected device actually sees',
);

console.log('Shell.pairing: all assertions passed');
