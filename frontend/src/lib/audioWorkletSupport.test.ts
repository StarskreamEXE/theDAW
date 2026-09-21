/**
 * The AudioWorklet gate: availability, the two reasons it can be missing, the
 * promise contract every call site depends on, and the source-level rule that
 * keeps a thirteenth unguarded `addModule` from appearing.
 *
 * Why the promise contract matters: every worklet loader in the app caches the
 * promise (`moduleByCtx.set(ctx, p)`) and hangs a `.catch()` off it. A helper
 * that THREW instead of rejecting would skip both — the cache would never be
 * cleaned up and the catch would never run — so "rejects, never throws" is
 * tested directly rather than inferred.
 *
 * Run: `npx tsx src/lib/audioWorkletSupport.test.ts`
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AudioWorkletUnavailableError,
  INSECURE_CONTEXT_MESSAGE,
  UNSUPPORTED_MESSAGE,
  addWorkletModule,
  audioWorkletAvailable,
  describeAudioWorkletProblem,
  type AudioWorkletEnv,
} from './audioWorkletSupport.ts';

/** A context whose `audioWorklet` works, like a secure page's. */
const liveCtx = (record: string[]): BaseAudioContext =>
  ({
    audioWorklet: {
      addModule: async (url: string) => {
        record.push(url);
      },
    },
  }) as unknown as BaseAudioContext;

/** An `OfflineAudioContext` shape: same inherited `audioWorklet`, plus the
 *  `startRendering` that tells the two apart elsewhere in the codebase. */
const offlineCtx = (record: string[]): BaseAudioContext =>
  ({
    startRendering: async () => undefined,
    audioWorklet: {
      addModule: async (url: string) => {
        record.push(url);
      },
    },
  }) as unknown as BaseAudioContext;

/** What a plain-http LAN page hands you: no `audioWorklet` at all. */
const insecureCtx = (): BaseAudioContext => ({}) as unknown as BaseAudioContext;

// ── audioWorkletAvailable ────────────────────────────────────────────────────
{
  assert.equal(audioWorkletAvailable(liveCtx([])), true, 'a live context with addModule');
  assert.equal(audioWorkletAvailable(offlineCtx([])), true, 'an OfflineAudioContext is no different');
  assert.equal(audioWorkletAvailable(insecureCtx()), false, 'no audioWorklet at all');
  assert.equal(audioWorkletAvailable(null), false);
  assert.equal(audioWorkletAvailable(undefined), false);
  assert.equal(
    audioWorkletAvailable({ audioWorklet: {} } as unknown as BaseAudioContext),
    false,
    'an audioWorklet object without a callable addModule is not usable',
  );
  assert.equal(
    audioWorkletAvailable({ audioWorklet: { addModule: 'nope' } } as unknown as BaseAudioContext),
    false,
  );
}

// ── addWorkletModule: the happy path forwards, once, verbatim ────────────────
{
  const loaded: string[] = [];
  const p = addWorkletModule(liveCtx(loaded), '/chop.worklet.js');
  assert.ok(p instanceof Promise, 'always a promise, so callers can cache it');
  await p;
  assert.deepEqual(loaded, ['/chop.worklet.js']);

  const offlineLoaded: string[] = [];
  await addWorkletModule(offlineCtx(offlineLoaded), '/granular-morph.worklet.js');
  assert.deepEqual(offlineLoaded, ['/granular-morph.worklet.js'], 'offline contexts load the same way');
}

// ── addWorkletModule REJECTS, never throws synchronously ─────────────────────
{
  const secure = globalThis.isSecureContext;
  try {
    Object.defineProperty(globalThis, 'isSecureContext', { value: false, configurable: true, writable: true });
    let rejection: unknown;
    // If this threw, the assignment would never happen and the test would die
    // here with the raw error instead of reaching the assertions below.
    const p = addWorkletModule(insecureCtx(), '/chop.worklet.js');
    assert.ok(p instanceof Promise, 'an unavailable worklet still returns a promise');
    await p.then(
      () => assert.fail('must not resolve'),
      (e: unknown) => {
        rejection = e;
      },
    );
    assert.ok(rejection instanceof AudioWorkletUnavailableError, 'rejects with the typed error');
    assert.equal((rejection as AudioWorkletUnavailableError).reason, 'insecure-context');
    assert.equal((rejection as AudioWorkletUnavailableError).message, INSECURE_CONTEXT_MESSAGE);
    assert.match(
      (rejection as AudioWorkletUnavailableError).message,
      /localhost/,
      'the message tells the user somewhere to actually go',
    );
    assert.equal((rejection as Error).name, 'AudioWorkletUnavailableError');

    // The per-context caches in the call sites rely on `.catch()` firing.
    let caught = 0;
    await addWorkletModule(insecureCtx(), '/x.js').catch(() => {
      caught += 1;
    });
    assert.equal(caught, 1, 'a normal .catch() chain sees it');
  } finally {
    Object.defineProperty(globalThis, 'isSecureContext', { value: secure, configurable: true, writable: true });
  }
}

// ── a secure page with no AudioWorklet is 'unsupported', not 'insecure' ──────
{
  const secure = globalThis.isSecureContext;
  try {
    Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true, writable: true });
    const err = await addWorkletModule(insecureCtx(), '/x.js').then(
      () => null,
      (e: unknown) => e as AudioWorkletUnavailableError,
    );
    assert.ok(err instanceof AudioWorkletUnavailableError);
    assert.equal(err.reason, 'unsupported');
    assert.equal(err.message, UNSUPPORTED_MESSAGE);
  } finally {
    Object.defineProperty(globalThis, 'isSecureContext', { value: secure, configurable: true, writable: true });
  }
}

// ── a throwing addModule still comes back as a rejection ────────────────────
{
  const ctx = {
    audioWorklet: {
      addModule: () => {
        throw new Error('synchronous boom');
      },
    },
  } as unknown as BaseAudioContext;
  const err = await addWorkletModule(ctx, '/x.js').then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.equal(err?.message, 'synchronous boom', 'the real failure is preserved, not replaced');
}

// ── describeAudioWorkletProblem, with injected globals ──────────────────────
{
  const withWorklet = (): AudioWorkletEnv => {
    class Base {}
    Object.defineProperty(Base.prototype, 'audioWorklet', { get: () => ({}), configurable: true });
    class Ctx extends Base {}
    return { isSecureContext: true, BaseAudioContext: Base, AudioContext: Ctx };
  };

  assert.equal(describeAudioWorkletProblem(withWorklet()), null, 'a secure, supporting page has no problem');

  // Secure-context gating hides `audioWorklet` from the prototype entirely;
  // `isSecureContext` is the only thing that says why.
  const insecure = describeAudioWorkletProblem({
    isSecureContext: false,
    AudioContext: class {},
    BaseAudioContext: class {},
  });
  assert.ok(insecure, 'a plain-http LAN page has a problem');
  assert.equal(insecure.reason, 'insecure-context');
  assert.match(insecure.title, /\S/);
  assert.match(insecure.detail, /https:\/\//, 'says to use https');
  assert.match(insecure.detail, /localhost/, 'says to use localhost');
  assert.match(insecure.detail, /ssh -L/, 'gives the from-another-computer way out');

  const unsupported = describeAudioWorkletProblem({
    isSecureContext: true,
    AudioContext: class {},
    BaseAudioContext: class {},
  });
  assert.ok(unsupported);
  assert.equal(unsupported.reason, 'unsupported', 'secure but no worklet is the browser, not the address');
  assert.match(unsupported.detail, /AudioWorklet/);

  // Only one of the two constructors needs to carry it.
  class OnlyBase {}
  Object.defineProperty(OnlyBase.prototype, 'audioWorklet', { get: () => ({}), configurable: true });
  assert.equal(
    describeAudioWorkletProblem({ isSecureContext: true, BaseAudioContext: OnlyBase }),
    null,
    'BaseAudioContext alone is enough',
  );
  class OnlyCtx {}
  Object.defineProperty(OnlyCtx.prototype, 'audioWorklet', { get: () => ({}), configurable: true });
  assert.equal(
    describeAudioWorkletProblem({ isSecureContext: true, AudioContext: OnlyCtx }),
    null,
    'AudioContext alone is enough',
  );

  // No Web Audio whatsoever (an ancient browser) reads as unsupported.
  const none = describeAudioWorkletProblem({ isSecureContext: true });
  assert.equal(none?.reason, 'unsupported');
}

// ── SOURCE GUARD: nothing under src calls addModule directly ────────────────
{
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      if (!/\.tsx?$/.test(entry.name)) return [];
      if (/\.test\.tsx?$/.test(entry.name)) return []; // tests fake contexts on purpose
      if (entry.name === 'audioWorkletSupport.ts') return []; // the one allowed site
      return [full];
    });

  const DIRECT_CALL = /\.audioWorklet\s*(\?\.)?\.?\s*addModule\s*\(/;
  const offenders = sourceFiles(srcRoot)
    .map((file) => ({ file, lines: readFileSync(file, 'utf8').split(/\r?\n/) }))
    .flatMap(({ file, lines }) =>
      lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => DIRECT_CALL.test(line))
        .map(({ i }) => `${relative(srcRoot, file).replace(/\\/g, '/')}:${i + 1}`),
    );

  assert.deepEqual(
    offenders,
    [],
    'every worklet load goes through addWorkletModule (lib/audioWorkletSupport.ts), ' +
      'or it crashes with "reading \'addModule\'" on any non-secure page',
  );

  // The scan is only worth anything if it can actually see a violation.
  assert.ok(DIRECT_CALL.test("p = ctx.audioWorklet.addModule('/chop.worklet.js')"));
  assert.ok(DIRECT_CALL.test('await offline.audioWorklet.addModule(URL);'));
  assert.ok(DIRECT_CALL.test('void ctx.audioWorklet?.addModule(URL);'));
  assert.ok(!DIRECT_CALL.test('addWorkletModule(ctx, URL)'));
  assert.ok(sourceFiles(srcRoot).length > 50, 'the scan reached the tree, not an empty directory');
}

console.log('audioWorkletSupport: ok');
