import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UPDATE_ALL_EXPIRES_MS, UpdateControl } from '../src/update-control.js';

describe('UpdateControl: one switch for every part of Patch', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'update-control-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lets releases move while auto-update is on', () => {
    const c = new UpdateControl({ dataDir: dir });
    c.setAutoUpdate(() => true);
    expect(c.mayUpdate()).toBe(true);
  });

  it('holds everything while auto-update is off and nothing was asked for', () => {
    const c = new UpdateControl({ dataDir: dir });
    c.setAutoUpdate(() => false);
    expect(c.mayUpdate()).toBe(false);
  });

  it('Update everything lifts the hold until it is cleared, across a restart', () => {
    const c = new UpdateControl({ dataDir: dir });
    c.setAutoUpdate(() => false);
    let checked = 0;
    c.onUpdateAllRequested(() => (checked += 1));
    c.requestUpdateAll();
    expect(checked).toBe(1);
    expect(c.mayUpdate()).toBe(true);

    const afterRestart = new UpdateControl({ dataDir: dir });
    afterRestart.setAutoUpdate(() => false);
    expect(afterRestart.mayUpdate()).toBe(true);

    afterRestart.clearUpdateAll();
    expect(afterRestart.mayUpdate()).toBe(false);
  });

  it('an Update everything that never finishes stops lifting the hold', () => {
    let now = 1_000;
    const c = new UpdateControl({ dataDir: dir, now: () => now });
    c.setAutoUpdate(() => false);
    c.requestUpdateAll();
    now += UPDATE_ALL_EXPIRES_MS + 1;
    expect(c.mayUpdate()).toBe(false);
  });
});
