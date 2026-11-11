// spec/05 § Keep running: open at login and keep the computer awake on mains
// power, both on by default, both remembered, and the display never held.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeepRunning, readPrefs, type KeepRunningHost } from './keep-running';

function fakeHost(battery = false) {
  const log: string[] = [];
  let onChange: ((b: boolean) => void) | null = null;
  let next = 1;
  const host: KeepRunningHost & { battery: boolean } = {
    battery,
    setOpenAtLogin: (on) => log.push(`login:${on}`),
    onBattery: () => host.battery,
    onPowerSourceChange: (cb) => (onChange = cb),
    holdAwake: () => {
      log.push('hold');
      return next++;
    },
    releaseAwake: (id) => log.push(`release:${id}`),
  };
  return { host, log, flip: (b: boolean) => ((host.battery = b), onChange?.(b)) };
}
const file = () => join(mkdtempSync(join(tmpdir(), 'patch-keep-')), 'keep-running.json');

test('first start: both on, saved, login item set, awake held on mains', () => {
  const f = file();
  const { host, log } = fakeHost(false);
  const state = new KeepRunning(f, host).start();
  assert.deepEqual(state, { openAtLogin: true, keepAwake: true, holdingAwake: true });
  assert.deepEqual(log, ['login:true', 'hold']);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { openAtLogin: true, keepAwake: true });
});

test('follows the power source: released on battery, held again on mains', () => {
  const { host, log, flip } = fakeHost(false);
  const k = new KeepRunning(file(), host);
  k.start();
  flip(true);
  assert.equal(k.state().holdingAwake, false);
  flip(false);
  assert.equal(k.state().holdingAwake, true);
  assert.deepEqual(log, ['login:true', 'hold', 'release:1', 'hold']);
});

test('turning things off is remembered and applied at once', () => {
  const f = file();
  const { host, log } = fakeHost(false);
  const k = new KeepRunning(f, host);
  k.start();
  k.set({ keepAwake: false, openAtLogin: false });
  assert.deepEqual(log.slice(2), ['login:false', 'release:1']);
  const again = fakeHost(false);
  assert.deepEqual(new KeepRunning(f, again.host).start(), {
    openAtLogin: false,
    keepAwake: false,
    holdingAwake: false,
  });
  assert.deepEqual(again.log, ['login:false']);
});

test('on battery at start, nothing is held', () => {
  const { host, log } = fakeHost(true);
  new KeepRunning(file(), host).start();
  assert.deepEqual(log, ['login:true']);
});

test('stop lets the computer sleep', () => {
  const { host, log } = fakeHost(false);
  const k = new KeepRunning(file(), host);
  k.start();
  k.stop();
  assert.deepEqual(log, ['login:true', 'hold', 'release:1']);
});

test('a damaged file is an error, not a silent return to "on"', () => {
  const f = file();
  writeFileSync(f, '{nope');
  assert.throws(() => readPrefs(f), /not readable/);
  writeFileSync(f, JSON.stringify({ keepAwake: 'yes' }));
  assert.throws(() => readPrefs(f), /keepAwake/);
});

test('set refuses a value that is not a boolean', () => {
  const { host } = fakeHost(false);
  const k = new KeepRunning(file(), host);
  k.start();
  assert.throws(() => k.set({ keepAwake: 'yes' as unknown as boolean }), /true or false/);
});
