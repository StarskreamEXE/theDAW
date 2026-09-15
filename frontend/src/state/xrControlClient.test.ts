/**
 * The XR control bus publishes its manifest only on a socket that is still
 * open and current once the manifest has been built.
 *
 * Replays the order a real session produces: the bus connects, a control source
 * registers, and the socket closes while that source's entries are still
 * loading. Sending on the closed socket threw "Cannot read properties of null
 * (reading 'send')" as an unhandled rejection. Then the same race across a
 * reconnect: the bus reconnects on its own and the new socket opens before the
 * entries arrive. That socket must get one manifest, with the current version.
 */
import assert from 'node:assert/strict';

const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static made: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.made.push(this);
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  send(data: string): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error('send on a socket that is not open');
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

const g = globalThis as unknown as Record<string, unknown>;
g.window = {
  location: { protocol: 'http:', host: 'localhost:5173' },
  // The bus waits 2s before it reconnects; the fake timer keeps that path (the
  // module's own scheduleReconnect) and only shortens the wait.
  setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, Math.min(ms ?? 0, 5)),
  clearTimeout,
};
g.WebSocket = FakeSocket;

const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (done: () => boolean, what: string) => {
  for (let i = 0; i < 400; i += 1) {
    if (done()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};
type Sent = { type: string; version?: number; entries?: { id: string }[] };
const manifests = (s: FakeSocket): Sent[] =>
  s.sent.map((m) => JSON.parse(m) as Sent).filter((m) => m.type === 'manifest');

async function main(): Promise<void> {
  const xr = await import('./xrControlClient.ts');

  xr.startXrControl();
  const first = FakeSocket.made[0];
  assert.ok(first, 'the bus opens a socket');
  first.open();
  await tick();
  assert.ok(first.sent.some((m) => JSON.parse(m).type === 'host-hello'), 'the host declares itself on open');

  // A source whose entries take a moment, and the socket drops meanwhile.
  let release: () => void = () => undefined;
  const loading = new Promise<void>((r) => { release = r; });
  xr.registerXrControlSource({
    area: 'edit',
    buildEntries: async () => {
      await loading;
      return [{ id: 'edit.fx.mix', area: 'edit', group: 'FX', label: 'Mix', kind: 'knob', min: 0, max: 1 }];
    },
    apply: () => true,
  });
  first.close();
  release();
  await tick();
  await tick();
  assert.deepEqual(unhandled, [], 'a manifest built after the socket closed is dropped, not sent');
  assert.equal(manifests(first).length, 1, 'the closed socket got only the manifest sent on open');

  // The bus reconnects on its own after that drop.
  await until(() => FakeSocket.made.length >= 2, 'the bus to reconnect');
  const second = FakeSocket.made[1];
  second.open();
  await until(() => manifests(second).length === 1, 'the reconnected socket manifest');
  assert.equal(manifests(second)[0].version, 1, 'the reconnected socket gets the manifest as it stands');

  // A slow source registers on the reconnected bus, and that socket drops while
  // the source's entries load. The bus reconnects again, and the third socket
  // opens before the entries arrive, so two builds wait on the same source: the
  // one started for the dropped socket, and the one the third socket's open
  // started.
  let releaseMix: () => void = () => undefined;
  const mixLoading = new Promise<void>((r) => { releaseMix = r; });
  xr.registerXrControlSource({
    area: 'mix',
    buildEntries: async () => {
      await mixLoading;
      return [{ id: 'mix.fx.wet', area: 'mix', group: 'FX', label: 'Wet', kind: 'knob', min: 0, max: 1 }];
    },
    apply: () => true,
  });
  second.close();
  await until(() => FakeSocket.made.length >= 3, 'the bus to reconnect again');
  const third = FakeSocket.made[2];
  third.open();
  await tick();
  releaseMix();
  await until(() => manifests(third).length > 0, 'the third socket manifest');
  await tick();
  await tick();

  const got = manifests(third);
  assert.equal(got.length, 1, 'the new socket receives one manifest, not one per build in flight');
  assert.equal(got[0].version, 2, 'it carries the current manifest version');
  assert.deepEqual(
    got[0].entries?.map((e) => e.id).sort(),
    ['edit.fx.mix', 'mix.fx.wet'],
    'it lists every source, the one that was loading included',
  );
  assert.equal(manifests(second).length, 1, 'the dropped socket got only its on-open manifest');
  assert.deepEqual(unhandled, [], 'no build rejected');

  xr.stopXrControl();
  console.log('xrControlClient test passed');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
