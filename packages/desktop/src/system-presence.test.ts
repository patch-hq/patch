import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SystemPresence, type PowerMonitorLike } from './system-presence.js';

function fakeMonitor(): PowerMonitorLike & {
  emit(e: string): void;
  idle: number;
  state: 'active' | 'idle' | 'locked' | 'unknown';
} {
  const handlers = new Map<string, () => void>();
  return {
    idle: 0,
    state: 'active',
    on(event, listener) {
      handlers.set(event, listener);
    },
    emit(e) {
      handlers.get(e)?.();
    },
    getSystemIdleTime() {
      return this.idle;
    },
    getSystemIdleState() {
      return this.state;
    },
  };
}

function setup() {
  const m = fakeMonitor();
  let changes = 0;
  const p = new SystemPresence(m, () => changes++);
  p.start();
  return { m, p, changes: () => changes };
}

test('reports idle time in milliseconds and no away while the user is at the machine', () => {
  const { m, p } = setup();
  m.idle = 7;
  assert.deepEqual(p.read(), { idleMs: 7000 });
});

test('locking reports away: locked at once, unlocking clears it, each telling the renderer', () => {
  const { m, p, changes } = setup();
  m.emit('lock-screen');
  assert.equal(changes(), 1);
  assert.deepEqual(p.read(), { idleMs: 0, away: 'locked' });
  m.emit('unlock-screen');
  assert.equal(changes(), 2);
  assert.deepEqual(p.read(), { idleMs: 0 });
});

test('going to sleep reports away: asleep, and waking reports again straight away', () => {
  const { m, p, changes } = setup();
  m.emit('suspend');
  assert.equal(p.read().away, 'asleep');
  m.emit('resume');
  assert.equal(changes(), 2);
  assert.equal(p.read().away, undefined);
});

test('asleep outranks locked, and a lock that outlives the sleep shows once awake', () => {
  const { m, p } = setup();
  m.emit('lock-screen');
  m.emit('suspend');
  assert.equal(p.read().away, 'asleep');
  m.emit('resume');
  assert.equal(p.read().away, 'locked');
});

test("the OS's own locked state counts where the session locks without the event", () => {
  const { m, p } = setup();
  m.state = 'locked';
  assert.equal(p.read().away, 'locked');
});

test('an idle but unlocked machine is not away: idle time alone is the server’s call', () => {
  const { m, p } = setup();
  m.idle = 3600;
  m.state = 'idle';
  assert.deepEqual(p.read(), { idleMs: 3_600_000 });
});
