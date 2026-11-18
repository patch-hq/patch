import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readProbation,
  recordAlive,
  runWatchdog,
  takeUpdateFailure,
  writeProbation,
} from '../src/updateProbation.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'probation-'));
  writeProbation(home, {
    from: '1.0.0',
    to: '1.0.1',
    startedAt: 0,
    rollbackInstaller: '/x/install',
    serverUrl: 'https://s',
  });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function clock() {
  let t = 0;
  return {
    now: () => t,
    // each poll advances 5s and, via `onTick`, lets a test play the new host
    sleep: async (ms: number) => {
      t += ms;
      tick?.(t);
    },
  };
}
let tick: ((t: number) => void) | undefined;
beforeEach(() => {
  tick = undefined;
});

describe('update probation watchdog', () => {
  it('commits once the new host has stayed connected for the stable period', async () => {
    const c = clock();
    tick = (t) => {
      if (t >= 10_000) recordAlive(home, '1.0.1', t);
    };
    const log: string[] = [];
    const verdict = await runWatchdog({
      home,
      ...c,
      installedVersion: () => '1.0.1',
      log: (l) => log.push(l),
      rollback: async () => {
        throw new Error('must not roll back');
      },
    });
    expect(verdict).toBe('committed');
    expect(readProbation(home)).toBeUndefined();
    expect(takeUpdateFailure(home)).toBeUndefined();
  });

  it('rolls back and records why when the new host never connects', async () => {
    const c = clock();
    let rolled = false;
    const verdict = await runWatchdog({
      home,
      ...c,
      installedVersion: () => '1.0.0',
      log: () => {},
      rollback: async (p) => {
        rolled = p.rollbackInstaller === '/x/install';
      },
    });
    expect(verdict).toBe('rolled-back');
    expect(rolled).toBe(true);
    expect(readProbation(home)).toBeUndefined();
    const failure = takeUpdateFailure(home);
    expect(failure).toMatchObject({ from: '1.0.0', to: '1.0.1' });
    expect(failure?.reason).toContain('never connected');
    expect(takeUpdateFailure(home)).toBeUndefined();
  });

  it('rolls back a host that connected briefly then crash-looped (heartbeat restarts)', async () => {
    const c = clock();
    // a new pid-less heartbeat each time with since == at: never stable
    tick = (t) => {
      if (t < 60_000) recordAlive(home, '1.0.1', t);
    };
    const verdict = await runWatchdog({
      home,
      ...c,
      stableMs: 120_000,
      installedVersion: () => '1.0.0',
      log: () => {},
      rollback: async () => {},
    });
    expect(verdict).toBe('rolled-back');
    expect(takeUpdateFailure(home)?.reason).toMatch(/went silent|did not stay up/);
  });

  it('says so when the rollback itself fails or leaves the wrong version', async () => {
    const c = clock();
    await runWatchdog({
      home,
      ...c,
      installedVersion: () => '1.0.1',
      log: () => {},
      rollback: async () => {},
    });
    expect(takeUpdateFailure(home)?.reason).toContain('not 1.0.0');

    writeProbation(home, {
      from: '1.0.0',
      to: '1.0.1',
      startedAt: -1e9,
      rollbackInstaller: '/x',
      serverUrl: 's',
    });
    await runWatchdog({
      home,
      ...c,
      installedVersion: () => undefined,
      log: () => {},
      rollback: async () => {
        throw new Error('boom');
      },
    });
    expect(takeUpdateFailure(home)?.reason).toContain('ROLLBACK FAILED: boom');
  });

  it('does nothing when no update is on probation', async () => {
    rmSync(join(home, 'update-probation.json'));
    expect(await runWatchdog({ home, installedVersion: () => '1', log: () => {} })).toBe(
      'no-probation',
    );
  });

  it('only a host of the version on probation writes a heartbeat', () => {
    expect(recordAlive(home, '1.0.0')).toBe(false);
    expect(existsSync(join(home, 'update-probation.alive.json'))).toBe(false);
    expect(recordAlive(home, '1.0.1')).toBe(true);
    expect(
      JSON.parse(readFileSync(join(home, 'update-probation.alive.json'), 'utf8')).version,
    ).toBe('1.0.1');
  });
});
