import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRotation } from '../src/accountFailover.js';
import { readAccountExhaustion, writeAccountExhaustion } from '../src/accountAvailabilityStore.js';

describe('persisted account availability', () => {
  it('survives a daemon restart and prevents a spent account being selected', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'patch-account-state-')), 'availability.json');
    let now = 1_700_000_000_000;
    const first = new AccountRotation(
      () => now,
      [],
      (entries) => writeAccountExhaustion(path, entries),
    );
    first.markExhausted('spent', 'session limit', now + 60_000);

    const restarted = new AccountRotation(() => now, readAccountExhaustion(path));
    expect(
      restarted.usableAccount([
        { id: 'spent', connected: true },
        { id: 'ready', connected: true },
      ]),
    ).toBe('ready');

    now += 60_001;
    expect(restarted.isExhausted('spent')).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([
      expect.objectContaining({ accountId: 'spent' }),
    ]);
  });
});
