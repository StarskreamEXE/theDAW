/**
 * The Lyria tab with a Lyria this backend did not start -- one an earlier
 * session left on the port, still running with that session's keys.
 *
 * Replayed as it happens: the panel opens, GET /api/lyria/url adopts the
 * leftover (`external: true`) and reports a checkout the backend could not
 * move to the pinned commit. The panel must say why, and offer "Restart with
 * current keys". A first press is refused by the backend (a Lyria from
 * another folder holds the port): the reason is shown and the button stays.
 * A second press succeeds: the panel switches to the fresh child (mock
 * badge, no restart button) and reloads the frame.
 *
 * Then theDAW's own child, the normal case after the first open: GET
 * /api/lyria/url answers `external: false` with the same dirty-checkout note.
 * The note tells the user to restart Lyria after discarding the changes, so
 * the button must be there too. Pressed after the discard, the backend moves
 * the checkout (`updated`) and the note and the button go away.
 *
 * The button is found by its visible text, the name it has for a screen
 * reader and for speech input alike.
 *
 * Also holds the type scale: no text under 12px and no small mono labels in
 * the panel's own chrome.
 *
 * Real component, real React (react-dom/client + act) under jsdom; `fetch`
 * is stubbed and every call recorded. LyriaPanel reaches `state/playerStore`
 * (through libraryStore), which reads the Vite-only `import.meta.env.DEV`
 * behind a `typeof window !== 'undefined'` guard, so the panel is imported
 * BEFORE the jsdom globals exist -- the same order MetronomeVolumeControl.test
 * and MixerStrips.b12.test use.
 *
 * Run: `npx tsx src/views/LyriaPanel.restart.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

async function main(): Promise<void> {
  const { LyriaPanel, lyriaCheckoutNote } = await import('./LyriaPanel.tsx');

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost:5173/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    'window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLButtonElement',
    'HTMLIFrameElement', 'Node', 'Event', 'KeyboardEvent', 'getComputedStyle', 'localStorage', 'navigator',
  ]) {
    Object.defineProperty(g, key, {
      value: (dom.window as unknown as Record<string, unknown>)[key],
      configurable: true,
      writable: true,
    });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const dirty =
    'The Lyria checkout at C:\\lyria has local changes to tracked files, so theDAW left it at 192032e instead of moving it to ef8b16f. Commit or discard them, then restart Lyria.';
  const calls: Array<{ url: string; method: string }> = [];
  let urlReply: unknown = {
    url: 'http://127.0.0.1:5188',
    mode: 'external',
    mock: null,
    external: true,
    checkout: { state: 'dirty', commit: '192032e', reason: dirty },
  };
  let restartReply: { status: number; body: unknown } = {
    status: 409,
    body: { detail: 'The Lyria on port 5188 runs from D:\\other, not from C:\\lyria. Stop it there, then press Restart again.' },
  };
  g.fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/lyria/url') return json(200, urlReply);
    if (url === '/api/lyria/restart') return json(restartReply.status, restartReply.body);
    if (url === '/api/lyria/import-new') return json(200, { imported: [], skipped: 0 });
    return json(404, { detail: 'not stubbed' });
  };

  const React = await import('react');
  const { act } = React;
  const { createRoot } = await import('react-dom/client');

  const doc = dom.window.document;
  const host = doc.getElementById('root')!;
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(LyriaPanel));
  });
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  await settle();

  // The panel adopted the leftover: it says why the checkout stayed, offers
  // the restart, and claims no cost mode for a process it did not start.
  assert.ok(host.textContent?.includes('has local changes to tracked files'), host.textContent ?? '');
  const restart = () =>
    Array.from<HTMLButtonElement>(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === 'Restart with current keys' && !b.hasAttribute('aria-label'),
    ) ?? null;
  assert.ok(restart(), 'the restart button renders for an adopted Lyria');
  assert.ok(!host.textContent?.includes('Live $0.08') && !/\bMock\b/.test(host.textContent ?? ''));
  const frameBefore = host.querySelector('iframe');
  assert.ok(frameBefore, 'the adopted Lyria is framed');

  // The type scale: nothing under 12px, nothing in small mono.
  assert.ok(!/text-\[(?:[0-9]|1[01])px\]/.test(host.innerHTML), 'text under 12px in the Lyria panel');
  assert.ok(!host.innerHTML.includes('font-mono'), 'small mono label in the Lyria panel');

  // First press: refused, reason shown, the button stays.
  await act(async () => {
    restart()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settle();
  assert.equal(calls.filter((c) => c.url === '/api/lyria/restart' && c.method === 'POST').length, 1);
  assert.ok(host.querySelector('[role="alert"]')?.textContent?.includes('runs from D:\\other'), host.textContent ?? '');
  assert.ok(restart(), 'a refused restart keeps the button');

  // Second press: the fresh child is ours, in mock mode.
  restartReply = {
    status: 200,
    body: {
      ok: true,
      url: 'http://127.0.0.1:5188',
      mode: 'mock',
      mock: true,
      external: false,
      checkout: { state: 'managed', reason: '' },
    },
  };
  await act(async () => {
    restart()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settle();
  assert.equal(restart(), null, 'no restart button once the child is ours and the checkout has nothing to say');
  assert.equal(host.querySelector('[role="alert"]'), null, 'the refusal clears');
  assert.ok(/\bMock\b/.test(host.textContent ?? ''), 'the cost mode is shown for our own child');
  assert.ok(!host.textContent?.includes('has local changes'), 'an empty reason shows no note');
  assert.notEqual(host.querySelector('iframe'), frameBefore, 'the frame reloads against the fresh child');

  assert.equal(lyriaCheckoutNote(undefined), '');
  assert.equal(lyriaCheckoutNote({ state: 'updated', reason: 'Moved from 192032e.' }), '');
  assert.equal(lyriaCheckoutNote({ state: 'failed', reason: 'Could not fetch.' }), 'Could not fetch.');

  await act(async () => root.unmount());

  // ── theDAW's own child on a checkout with local changes ─────────────────
  urlReply = {
    url: 'http://127.0.0.1:5188',
    mode: 'mock',
    mock: true,
    external: false,
    checkout: { state: 'dirty', commit: '192032e', reason: dirty },
  };
  const ownRoot = createRoot(host);
  await act(async () => {
    ownRoot.render(React.createElement(LyriaPanel));
  });
  await settle();
  assert.ok(host.textContent?.includes('then restart Lyria'), host.textContent ?? '');
  assert.ok(restart(), 'the note asks for a restart, so the button is there for our own child too');
  const restartsBefore = calls.filter((c) => c.url === '/api/lyria/restart').length;
  // The user discarded the edit; the restart moves the checkout.
  restartReply = {
    status: 200,
    body: {
      ok: true,
      url: 'http://127.0.0.1:5188',
      mode: 'mock',
      mock: true,
      external: false,
      checkout: { state: 'updated', commit: 'ef8b16f', reason: 'Moved from 192032e.' },
    },
  };
  await act(async () => {
    restart()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settle();
  assert.equal(calls.filter((c) => c.url === '/api/lyria/restart').length, restartsBefore + 1);
  assert.ok(!host.textContent?.includes('local changes'), 'the note goes once the checkout moved');
  assert.equal(restart(), null, 'and so does the button');
  await act(async () => ownRoot.unmount());
  console.log('LyriaPanel.restart.test.tsx: all assertions passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
