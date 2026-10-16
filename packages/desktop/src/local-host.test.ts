// Unit tests for the daemon-on-this-Mac helpers (local-host.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOST_SERVICE_LABEL,
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
  assert.deepEqual(localHostStatus(home), { installed: true, hostId: 'D1' });
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
