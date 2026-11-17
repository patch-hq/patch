import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationsMaster } from './notificationsMaster';

const file = (): string => join(mkdtempSync(join(tmpdir(), 'notif-master-')), 'n.json');

describe('NotificationsMaster', () => {
  it('starts on, remembers off across instances and tells listeners', () => {
    const f = file();
    const a = new NotificationsMaster(f);
    const seen: boolean[] = [];
    a.onChange((o) => seen.push(o));
    assert.equal(a.isOff(), false);
    a.set(true);
    a.set(true);
    assert.deepEqual(seen, [true]);
    assert.equal(new NotificationsMaster(f).isOff(), true);
    a.set(false);
    assert.equal(new NotificationsMaster(f).isOff(), false);
  });

  it('a corrupt file throws instead of turning notifications back on', () => {
    const f = file();
    writeFileSync(f, '{"off":"yes"}');
    assert.throws(() => new NotificationsMaster(f), /expected/);
  });
});
