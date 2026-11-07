import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyStart,
  countUpdateAttempt,
  recordShutdown,
  recordStart,
  restartStorm,
} from '../src/runDiag.js';
import { redactArgs } from '../src/installer/runLog.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'run-diag-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('run diagnostics', () => {
  it('first start is a first boot', () => {
    expect(recordStart(home, '1.0.1').reason.kind).toBe('first-boot');
  });

  it('a start after a recorded signal says so', () => {
    recordStart(home, '1.0.1');
    recordShutdown(home, { via: 'SIGTERM', caller: 'signal received' });
    const { reason } = recordStart(home, '1.0.1');
    expect(reason.kind).toBe('restart-after-signal');
    expect(reason.previousExit).toContain('SIGTERM');
  });

  it('a control stop is distinguished from a signal', () => {
    recordStart(home, '1.0.1');
    recordShutdown(home, { via: 'control-stop', caller: 'POST /stop' });
    expect(recordStart(home, '1.0.1').reason.kind).toBe('restart-after-stop-request');
  });

  it('a different version is a restart after update', () => {
    recordStart(home, '1.0.1');
    recordShutdown(home, { via: 'SIGTERM', caller: 'x' });
    expect(recordStart(home, '1.0.2').reason.kind).toBe('restart-after-update');
  });

  it('no shutdown record means an unrecorded exit', () => {
    recordStart(home, '1.0.1');
    const { reason } = recordStart(home, '1.0.1');
    expect(reason.kind).toBe('restart-after-unrecorded-exit');
    expect(reason.previousExit).toContain('no shutdown record');
  });

  it('the first shutdown request wins', () => {
    recordStart(home, '1.0.1');
    recordShutdown(home, { via: 'SIGTERM', caller: 'a' });
    recordShutdown(home, { via: 'SIGINT', caller: 'b' });
    const rec = JSON.parse(readFileSync(join(home, 'run-state.json'), 'utf8'));
    expect(rec.shutdown.via).toBe('SIGTERM');
  });

  it('a corrupt record throws for the caller to log, not silently resets', () => {
    writeFileSync(join(home, 'run-state.json'), '{nope');
    expect(() => recordStart(home, '1.0.1')).toThrow();
  });

  it('classifies without a previous run', () => {
    expect(classifyStart(undefined, '1').kind).toBe('first-boot');
  });

  it('summarises a restart storm only above the threshold', () => {
    const now = 100_000;
    expect(restartStorm([now - 40_000, now - 20_000, now], now)).toBeUndefined();
    const storm = restartStorm([now - 57_000, now - 38_000, now - 19_000, now], now);
    expect(storm?.count).toBe(4);
    expect(storm?.intervalsMs).toEqual([19_000, 19_000, 19_000]);
  });

  it('records a storm across real starts', () => {
    let storm;
    for (let i = 0; i < 5; i += 1) storm = recordStart(home, '1.0.1', 1_000_000 + i * 19_000).storm;
    expect(storm?.count).toBe(4);
  });

  it('counts install attempts per version', () => {
    expect(countUpdateAttempt(home, '1.0.2')).toBe(1);
    expect(countUpdateAttempt(home, '1.0.2')).toBe(2);
    expect(countUpdateAttempt(home, '1.0.3')).toBe(1);
  });

  it('redacts the token from installer argv', () => {
    expect(redactArgs(['--non-interactive', '--internal-token', 'secret', '--server', 'x'])).toBe(
      '--non-interactive --internal-token <redacted> --server x',
    );
  });
});
