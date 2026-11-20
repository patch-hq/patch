// Unit tests for the daemon-on-this-Mac helpers (local-host.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOST_SERVICE_LABEL,
  HOST_SYSTEMD_UNITS,
  ensureHostAnswering,
  friendlyComputerName,
  hostProcess,
  installLocalHost,
  isPairingCode,
  localHostStatus,
  serverOrigin,
} from './local-host';

const CODE = 'aB3_-xYz0123456789aB3_-xYz0123456789aB3_-xY';

test('a Mac with nothing installed reports no host', () => {
  const home = mkdtempSync(join(tmpdir(), 'patch-home-'));
  assert.deepEqual(localHostStatus(home), { installed: false, hostId: null });
});

test('an installed host reports its service and identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'patch-home-'));
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(home, 'Library', 'LaunchAgents', `${HOST_SERVICE_LABEL}.plist`), '');
  mkdirSync(join(home, '.patch'));
  writeFileSync(join(home, '.patch', 'daemon-identity.json'), JSON.stringify({ hostId: 'D1' }));
  assert.deepEqual(localHostStatus(home, 'darwin'), { installed: true, hostId: 'D1' });
});

test('on Linux the host is its systemd user unit, not a launchd plist', () => {
  const home = mkdtempSync(join(tmpdir(), 'patch-home-'));
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(home, 'Library', 'LaunchAgents', `${HOST_SERVICE_LABEL}.plist`), '');
  assert.equal(localHostStatus(home, 'linux').installed, false);
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(join(home, '.config', 'systemd', 'user', HOST_SYSTEMD_UNITS[0]), '');
  assert.equal(localHostStatus(home, 'linux').installed, true);
});

test('only a base64url nonce counts as a pairing code', () => {
  assert.equal(isPairingCode(CODE), true);
  assert.equal(isPairingCode('abc; rm -rf ~'), false);
  assert.equal(isPairingCode('$(whoami)0123456789'), false);
  assert.equal(isPairingCode(42), false);
});

test("the installer reports to the SPA's own origin", () => {
  assert.equal(serverOrigin('https://patch.tomchambers.me/app/'), 'https://patch.tomchambers.me');
});

function fakeSpawn(exitCode: number, printed: string) {
  const calls: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
  const impl = ((cmd: string, args: string[], opts: { env: Record<string, string> }) => {
    calls.push({ cmd, args, env: opts.env });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(printed));
      child.emit('close', exitCode);
    });
    return child;
  }) as never;
  return { impl, calls };
}

test('runs the published installer with the code as environment, not as shell text', async () => {
  const { impl, calls } = fakeSpawn(0, 'service started');
  const res = await installLocalHost({
    serverUrl: 'https://s',
    code: CODE,
    home: '/Users/t',
    spawnImpl: impl,
  });
  assert.deepEqual(res, { ok: true, exitCode: 0, output: 'service started' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.args.join(' ').includes(CODE), false);
  assert.equal(calls[0]!.env['PATCH_PAIRING_CODE'], CODE);
  assert.equal(calls[0]!.env['PATCH_SERVER_URL'], 'https://s');
  assert.equal(calls[0]!.env['HOME'], '/Users/t');
});

test("a failed install says so, with the installer's own words", async () => {
  const { impl } = fakeSpawn(75, 'the pairing code could not be submitted');
  const res = await installLocalHost({
    serverUrl: 'https://s',
    code: CODE,
    home: '/h',
    spawnImpl: impl,
  });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 75);
  assert.match(res.output, /could not be submitted/);
});

test('an installer that cannot be downloaded is a failed install', async () => {
  const res = await installLocalHost({
    serverUrl: 'http://127.0.0.1:9',
    code: CODE,
    home: mkdtempSync(join(tmpdir(), 'patch-home-')),
  });
  assert.equal(res.ok, false);
  assert.notEqual(res.exitCode, 0);
});

test('refuses something that is not a pairing code without running anything', async () => {
  const { impl, calls } = fakeSpawn(0, '');
  const res = await installLocalHost({
    serverUrl: 'https://s',
    code: 'x;y',
    home: '/h',
    spawnImpl: impl,
  });
  assert.equal(res.ok, false);
  assert.equal(calls.length, 0);
});
test('the name the person chose travels to the installer as environment', async () => {
  const { impl, calls } = fakeSpawn(0, '');
  await installLocalHost({
    serverUrl: 'https://s',
    code: CODE,
    home: '/h',
    name: "Tom's MacBook Pro",
    spawnImpl: impl,
  });
  assert.equal(calls[0]!.env['PATCH_HOST_NAME'], "Tom's MacBook Pro");
});

test('the suggested name is the computer name, not the network hostname', () => {
  const run = (cmd: string): string => (cmd.endsWith('scutil') ? "Tom's MacBook Pro\n" : '');
  assert.equal(friendlyComputerName(run, 'darwin', 'WC-M-K0X7P0RV6C'), "Tom's MacBook Pro");
  assert.equal(
    friendlyComputerName(() => 'Study Box\n', 'linux', 'ubuntu-1'),
    'Study Box',
  );
  assert.equal(
    friendlyComputerName(
      () => {
        throw new Error('no hostnamectl');
      },
      'linux',
      'box.example.com',
    ),
    'box',
  );
});

function recorder(loadedAfter: (calls: string[][]) => boolean) {
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'print') return { ok: loadedAfter(calls), output: '' };
    return { ok: true, output: '' };
  };
  return { calls, run };
}

function macHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'patch-home-'));
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(home, 'Library', 'LaunchAgents', `${HOST_SERVICE_LABEL}.plist`), '');
  return home;
}

test('stopping a loaded host boots it out of launchd and waits for it to be gone', async () => {
  const r = recorder((c) => !c.some((x) => x[1] === 'bootout'));
  const h = hostProcess({ home: macHome(), uid: 501, platform: 'darwin', run: r.run });
  await h.stop();
  assert.ok(r.calls.some((c) => c.join(' ').endsWith(`bootout gui/501/${HOST_SERVICE_LABEL}`)));
  assert.ok(!r.calls.some((c) => c[1] === 'disable'));
});

test('turn off also disables the job so it stays off', async () => {
  const r = recorder((c) => !c.some((x) => x[1] === 'bootout'));
  await hostProcess({ home: macHome(), uid: 501, platform: 'darwin', run: r.run }).stop({
    keepOff: true,
  });
  assert.ok(r.calls.some((c) => c[1] === 'disable'));
});

test('stopping a host that is not loaded does nothing', async () => {
  const r = recorder(() => false);
  await hostProcess({ home: macHome(), uid: 501, platform: 'darwin', run: r.run }).stop();
  assert.ok(!r.calls.some((c) => c[1] === 'bootout'));
});

test('starting an unloaded host bootstraps it; restarting a loaded one kills it with kickstart -k', async () => {
  const home = macHome();
  const unloaded = recorder(() => false);
  await hostProcess({ home, uid: 501, platform: 'darwin', run: unloaded.run }).start();
  assert.ok(unloaded.calls.some((c) => c[1] === 'bootstrap'));
  const loaded = recorder(() => true);
  await hostProcess({ home, uid: 501, platform: 'darwin', run: loaded.run }).restart();
  assert.ok(loaded.calls.some((c) => c[1] === 'kickstart' && c[2] === '-k'));
  await hostProcess({ home, uid: 501, platform: 'darwin', run: loaded.run }).start();
  assert.ok(loaded.calls.some((c) => c[1] === 'kickstart' && c[2] !== '-k'));
});

test('a failing launchctl is an error, not silence', async () => {
  const run = async () => ({ ok: false, output: 'boom' });
  await assert.rejects(
    hostProcess({ home: macHome(), uid: 501, platform: 'darwin', run }).restart(),
    /boom/,
  );
});

test('restarting with no host service installed says so', async () => {
  const home = mkdtempSync(join(tmpdir(), 'patch-home-'));
  const run = async () => ({ ok: true, output: '' });
  await assert.rejects(
    hostProcess({ home, uid: 501, platform: 'darwin', run }).restart(),
    /no host service/,
  );
});

test('on Linux the host is controlled through its systemd user unit', async () => {
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return { ok: true, output: '' };
  };
  const h = hostProcess({ home: '/h', uid: 1000, platform: 'linux', run });
  await h.stop({ keepOff: true });
  await h.restart();
  assert.deepEqual(calls, [
    ['systemctl', '--user', 'disable', 'patch-host.service'],
    ['systemctl', '--user', 'stop', 'patch-host.service'],
    ['systemctl', '--user', 'restart', 'patch-host.service'],
  ]);
});

function fakeProcess() {
  const log: string[] = [];
  return {
    log,
    p: {
      stop: async () => void log.push('stop'),
      start: async () => void log.push('start'),
      restart: async () => void log.push('restart'),
    },
  };
}

test('a host that already answers is left alone', async () => {
  const f = fakeProcess();
  const how = await ensureHostAnswering({ process: f.p, answering: async () => true });
  assert.equal(how, 'already-up');
  assert.deepEqual(f.log, []);
});

test('a stopped host is started, and a start that answers is enough', async () => {
  const f = fakeProcess();
  const how = await ensureHostAnswering({
    process: f.p,
    answering: async () => f.log.includes('start'),
    pollMs: 1,
  });
  assert.equal(how, 'started');
  assert.deepEqual(f.log, ['start']);
});

test('a host that does not answer in time is killed and restarted', async () => {
  const f = fakeProcess();
  const how = await ensureHostAnswering({
    process: f.p,
    answering: async () => f.log.includes('restart'),
    waitMs: 20,
    pollMs: 1,
  });
  assert.equal(how, 'restarted');
  assert.deepEqual(f.log, ['start', 'restart']);
});

test('a host that never answers is an error', async () => {
  const f = fakeProcess();
  await assert.rejects(
    ensureHostAnswering({ process: f.p, answering: async () => false, waitMs: 10, pollMs: 1 }),
    /did not answer/,
  );
});
