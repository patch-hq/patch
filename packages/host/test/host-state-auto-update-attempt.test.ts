// A scheduled self-update records the version it tried BEFORE installing, in
// host.json, so a failing installer that restarts the host cannot be retried
// for the same build on every restart.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostStateStore } from '../src/hostState.js';

const logger = { warn: () => undefined };

describe('lastAutoUpdateAttempt', () => {
  it('survives a host restart', () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-hoststate-'));
    try {
      new HostStateStore(home, logger as never).update({ lastAutoUpdateAttempt: '1.2.3' });
      expect(new HostStateStore(home, logger as never).get().lastAutoUpdateAttempt).toBe('1.2.3');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
