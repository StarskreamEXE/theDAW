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

console.log('Shell.pairing: all assertions passed');
