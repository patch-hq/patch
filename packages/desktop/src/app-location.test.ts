// spec/05 § Desktop first run, § Keep running: offering to move the Mac app to
// Applications, and a login item that points at where the app really is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMacLoginItem,
  isTransientLocation,
  macLoginItemBlocker,
  shouldOfferMove,
  type MacLoginItemHost,
} from './app-location';

test('the disk image and a translocated download are not places to open at login from', () => {
  assert.equal(isTransientLocation('/Volumes/Patch 1.1.1253-arm64/Patch.app'), true);
  assert.equal(
    isTransientLocation('/private/var/folders/x/T/AppTranslocation/0A1B/d/Patch.app'),
    true,
  );
  assert.equal(isTransientLocation('/Users/a/Downloads/Patch.app'), false);
  assert.equal(isTransientLocation('/Applications/Patch.app'), false);
  assert.match(macLoginItemBlocker('/Volumes/Patch/Patch.app') ?? '', /Move it to Applications/);
  assert.equal(macLoginItemBlocker('/Applications/Patch.app'), null);
});

test('the move is offered only on a packaged Mac first run outside Applications, never to a quiet instance', () => {
  const base = {
    platform: 'darwin' as const,
    packaged: true,
    quiet: false,
    inApplications: false,
    firstRun: true,
  };
  assert.equal(shouldOfferMove(base), true);
  assert.equal(shouldOfferMove({ ...base, inApplications: true }), false);
  assert.equal(shouldOfferMove({ ...base, firstRun: false }), false);
  assert.equal(shouldOfferMove({ ...base, quiet: true }), false);
  assert.equal(shouldOfferMove({ ...base, packaged: false }), false);
  assert.equal(shouldOfferMove({ ...base, platform: 'linux' }), false);
});

/** A fake macOS login-item store that, like the real one, keeps the path it was registered from. */
function fakeMac(bundlePath: string, dir = mkdtempSync(join(tmpdir(), 'patch-login-'))) {
  const calls: string[] = [];
  const warnings: string[] = [];
  const mac = { item: null as string | null, refuse: false };
  const host: MacLoginItemHost = {
    bundlePath,
    recordFile: join(dir, 'login-item.json'),
    registered: () => mac.item !== null,
    register: () => {
      calls.push('register');
      // Registering again does not repoint an item macOS already holds.
      if (!mac.refuse && mac.item === null) mac.item = host.bundlePath;
    },
    unregister: () => {
      calls.push('unregister');
      mac.item = null;
    },
    warn: (m) => warnings.push(m),
  };
  return { host, mac, calls, warnings, dir };
}

test('first turned on: registered from the running bundle, and the path recorded', () => {
  const { host, mac } = fakeMac('/Applications/Patch.app');
  applyMacLoginItem(true, host);
  assert.equal(mac.item, '/Applications/Patch.app');
  assert.deepEqual(JSON.parse(readFileSync(host.recordFile, 'utf8')), {
    path: '/Applications/Patch.app',
  });
});

test('a later launch from the same place leaves the item alone', () => {
  const { host, calls } = fakeMac('/Applications/Patch.app');
  applyMacLoginItem(true, host);
  calls.length = 0;
  applyMacLoginItem(true, host);
  assert.deepEqual(calls, []);
});

test('moved since it was registered: the old item is removed and the new place registered', () => {
  const { host, mac, dir } = fakeMac('/Users/a/Downloads/Patch.app');
  applyMacLoginItem(true, host);
  assert.equal(mac.item, '/Users/a/Downloads/Patch.app');
  const moved = fakeMac('/Applications/Patch.app', dir);
  moved.mac.item = mac.item;
  applyMacLoginItem(true, moved.host);
  assert.equal(moved.mac.item, '/Applications/Patch.app');
  assert.deepEqual(moved.calls, ['unregister', 'register']);
});

test('turned off at login by hand in System Settings: registered again from here', () => {
  const { host, mac, calls } = fakeMac('/Applications/Patch.app');
  applyMacLoginItem(true, host);
  mac.item = null;
  calls.length = 0;
  applyMacLoginItem(true, host);
  assert.equal(mac.item, '/Applications/Patch.app');
});

test('a damaged record is said and rebuilt, not fatal', () => {
  const { host, mac, warnings } = fakeMac('/Applications/Patch.app');
  writeFileSync(host.recordFile, '{nope');
  applyMacLoginItem(true, host);
  assert.equal(mac.item, '/Applications/Patch.app');
  assert.match(warnings.join('\n'), /not readable/);
});

test('macOS refusing the item is said, and nothing is recorded so the next launch tries again', () => {
  const { host, mac, warnings } = fakeMac('/Applications/Patch.app');
  mac.refuse = true;
  applyMacLoginItem(true, host);
  assert.match(warnings.join('\n'), /did not add \/Applications\/Patch\.app/);
  assert.equal(existsSync(host.recordFile), false);
});

test('turned off: unregistered and the record dropped', () => {
  const { host, mac } = fakeMac('/Applications/Patch.app');
  applyMacLoginItem(true, host);
  applyMacLoginItem(false, host);
  assert.equal(mac.item, null);
  assert.equal(existsSync(host.recordFile), false);
});

test('from the disk image it refuses, saying why', () => {
  const { host, mac } = fakeMac('/Volumes/Patch/Patch.app');
  assert.throws(() => applyMacLoginItem(true, host), /disk image/);
  assert.equal(mac.item, null);
});
