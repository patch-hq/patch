import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detachCommand } from './detach-command.mjs';

test('with systemd-run, the deploy gets a cgroup scope of its own', () => {
  const r = detachCommand('/usr/bin/node', ['ship.mjs', '--foreground'], { systemdRun: true });
  assert.equal(r.cmd, 'systemd-run');
  assert.deepEqual(r.args, [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '/usr/bin/node',
    'ship.mjs',
    '--foreground',
  ]);
  assert.equal(r.scoped, true);
});

test('without systemd-run, it runs plainly and says it is not scoped', () => {
  const r = detachCommand('/usr/bin/node', ['ship.mjs'], { systemdRun: false });
  assert.deepEqual(r, { cmd: '/usr/bin/node', args: ['ship.mjs'], scoped: false });
});
