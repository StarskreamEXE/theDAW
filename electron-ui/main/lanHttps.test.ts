// Run with: npx tsx electron-ui/main/lanHttps.test.ts
//
// The pure half of the desktop shell's LAN HTTPS listener (no Electron import
// -- this runs under plain node/tsx, unlike main/index.ts).
//   - parseLanHttpsPlan reads the plan backend/lib/lan_https.py prints, takes
//     the LAST JSON line (a wrapper can print ahead of it), and returns null
//     rather than a half-plan for anything it cannot use -- including an
//     "enabled" plan with no certificate, which would only crash-loop vite.
//   - lanListenerEnv adds exactly the four names vite.lan.config.ts reads and
//     removes the launch token under every spelling.
//   - lanListenerCommand goes through `cmd /c` on Windows, where npx is a .cmd
//     shim CreateProcess cannot exec.
//   - lanHttpsLogLine always says something, and says WHY when it is off.
import assert from 'node:assert/strict';
import {
  LAN_HTTPS_CERT_ENV,
  LAN_HTTPS_KEY_ENV,
  LAN_HTTPS_PORT_ENV,
  lanHttpsLogLine,
  lanListenerCommand,
  lanListenerEnv,
  parseLanHttpsPlan,
  type LanHttpsPlan,
} from './lanHttps';

const ENABLED = {
  enabled: true,
  port: 5443,
  url: 'https://192.168.1.34:5443',
  cert: 'C:\\theDAW\\data\\lan-cert\\lan-cert.pem',
  key: 'C:\\theDAW\\data\\lan-cert\\lan-key.pem',
  reason: null,
};

// ── parseLanHttpsPlan ─────────────────────────────────────────────────────
{
  const plan = parseLanHttpsPlan(`${JSON.stringify(ENABLED)}\n`);
  assert.deepEqual(plan, ENABLED);

  // A wrapper (uv, a venv shim, a warning filter) printed first: the LAST
  // parsable object wins, not the first.
  const noisy = `Installed 3 packages in 12ms\n{"stray": 1}\n${JSON.stringify(ENABLED)}\n`;
  assert.deepEqual(parseLanHttpsPlan(noisy), ENABLED, 'the plan is read from the last JSON line');

  // A disabled plan keeps its reason — that is the whole point of printing one.
  const off = { enabled: false, port: 5443, url: null, cert: null, key: null, reason: 'no LAN address' };
  assert.deepEqual(parseLanHttpsPlan(JSON.stringify(off)), off);

  // Nothing usable -> null, never a guess. The caller logs "no plan" and the
  // app runs exactly as it does today.
  assert.equal(parseLanHttpsPlan(''), null);
  assert.equal(parseLanHttpsPlan('Traceback (most recent call last):'), null);
  assert.equal(parseLanHttpsPlan('{not json'), null);
  assert.equal(parseLanHttpsPlan('[]'), null, 'an array is not a plan');
  assert.equal(parseLanHttpsPlan('{"port": 5443}'), null, 'no enabled flag');
  assert.equal(parseLanHttpsPlan('{"enabled": "yes", "port": 5443}'), null, 'enabled must be a boolean');
  assert.equal(parseLanHttpsPlan('{"enabled": false, "port": "5443"}'), null, 'port must be a number');
  assert.equal(parseLanHttpsPlan('{"enabled": false, "port": 70000}'), null, 'port must be a TCP port');
  assert.equal(parseLanHttpsPlan('{"enabled": false, "port": 0}'), null, 'port must be a TCP port');

  // An enabled plan missing any of url/cert/key is a broken contract, not a
  // usable plan: starting vite without a certificate only crash-loops.
  for (const missing of ['url', 'cert', 'key'] as const) {
    const broken: Record<string, unknown> = { ...ENABLED };
    broken[missing] = null;
    assert.equal(parseLanHttpsPlan(JSON.stringify(broken)), null, `enabled with no ${missing}`);
    broken[missing] = '   ';
    assert.equal(parseLanHttpsPlan(JSON.stringify(broken)), null, `enabled with blank ${missing}`);
  }
}

// ── lanListenerEnv ────────────────────────────────────────────────────────
{
  const base = {
    PATH: '/usr/bin',
    THEDAW_LAUNCH_TOKEN: 'secret-a',
    thedaw_launch_token: 'secret-b',
    Thedaw_Launch_Token: 'secret-c',
  };
  const env = lanListenerEnv(base, ENABLED as LanHttpsPlan);

  assert.equal(env.PATH, '/usr/bin', 'the base environment is kept');
  assert.equal(env.ENABLE_HMR, 'true');
  assert.equal(env[LAN_HTTPS_CERT_ENV], ENABLED.cert);
  assert.equal(env[LAN_HTTPS_KEY_ENV], ENABLED.key);
  assert.equal(env[LAN_HTTPS_PORT_ENV], '5443', 'the port is a string, as an environment value must be');

  // No spelling of the launch token survives: vite runs the frontend's own
  // devDependencies, and that code must not be able to pass as this shell.
  for (const key of Object.keys(env)) {
    assert.notEqual(key.toUpperCase(), 'THEDAW_LAUNCH_TOKEN', `launch token leaked as ${key}`);
  }
  assert.ok(!Object.values(env).some((v) => String(v).startsWith('secret-')), 'no token value survived');

  // The caller's object is not mutated (buildBaseEnv()'s result is reused).
  assert.equal(base.THEDAW_LAUNCH_TOKEN, 'secret-a');

  // Only the four names are added.
  const added = Object.keys(env).filter((k) => !(k in base));
  assert.deepEqual(added.sort(), ['ENABLE_HMR', LAN_HTTPS_CERT_ENV, LAN_HTTPS_KEY_ENV, LAN_HTTPS_PORT_ENV].sort());

  // A plan that is off, or has no certificate, is a programming error here
  // rather than a listener started with nothing to serve TLS with.
  assert.throws(() => lanListenerEnv(base, { ...ENABLED, enabled: false } as LanHttpsPlan));
  assert.throws(() => lanListenerEnv(base, { ...ENABLED, cert: null } as LanHttpsPlan));
  assert.throws(() => lanListenerEnv(base, { ...ENABLED, key: null } as LanHttpsPlan));
}

// ── lanListenerCommand ────────────────────────────────────────────────────
{
  const win = lanListenerCommand('win32');
  assert.equal(win.command, 'cmd', 'npx is a .cmd shim on Windows — CreateProcess cannot exec it');
  assert.deepEqual(win.args, ['/c', 'npx vite --config vite.lan.config.ts']);

  for (const platform of ['linux', 'darwin']) {
    const posix = lanListenerCommand(platform);
    assert.equal(posix.command, 'npx', platform);
    assert.deepEqual(posix.args, ['vite', '--config', 'vite.lan.config.ts'], platform);
  }
}

// ── lanHttpsLogLine ───────────────────────────────────────────────────────
{
  assert.equal(lanHttpsLogLine(ENABLED as LanHttpsPlan), 'LAN (https): https://192.168.1.34:5443');
  assert.equal(
    lanHttpsLogLine({ enabled: false, port: 5443, url: null, cert: null, key: null, reason: 'no certificate' }),
    'LAN (https): off - no certificate',
    'a launcher that turns it off has to say why',
  );
  // Never silent, even with nothing to go on.
  assert.equal(lanHttpsLogLine(null), 'LAN (https): off - no plan could be read');
  assert.equal(
    lanHttpsLogLine({ enabled: false, port: 5443, url: null, cert: null, key: null, reason: null }),
    'LAN (https): off - unavailable',
  );
}

console.log('lanHttps: plan parsing + token-free child env + platform command contract passed');
