// lib/exitLog.ts — an exit is found on the next launch from a session marker.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { updates } = vi.hoisted(() => ({ updates: { updateId: 'u1' as string | null } }));
vi.mock('expo-updates', () => ({
  get updateId() {
    return updates.updateId;
  },
}));

import { store } from '../src/lib/credential';
import {
  beginSession,
  clearExitLog,
  exitLogText,
  noteCrashed,
  noteIntentionalRestart,
  readExitLog,
  setTelemetryEnabled,
  telemetryEnabled,
} from '../src/lib/exitLog';

beforeEach(() => {
  store().delete('patch.exitSession.v1');
  store().delete('patch.shareCrashReports.v1');
  clearExitLog();
  updates.updateId = 'u1';
});

describe('beginSession', () => {
  it('logs nothing on the first ever launch', () => {
    expect(beginSession().unexplained).toBe(false);
    expect(readExitLog()).toEqual([]);
  });

  it('flags a run that stopped while open with no crash', () => {
    beginSession(1_000);
    const found = beginSession(61_000);
    expect(found.unexplained).toBe(true);
    expect(readExitLog().map((e) => e.kind)).toEqual(['unexpected-exit']);
  });

  it('does not flag a run that crashed or was restarted on purpose', () => {
    beginSession();
    noteCrashed();
    expect(beginSession().unexplained).toBe(false);
    noteIntentionalRestart();
    expect(beginSession().unexplained).toBe(false);
    expect(readExitLog().map((e) => e.kind)).toEqual(['restart']);
  });

  it('records that an update was applied between runs', () => {
    beginSession();
    updates.updateId = 'u2';
    const found = beginSession();
    expect(found.unexplained).toBe(true);
    expect(readExitLog().map((e) => e.kind)).toEqual(['updated', 'unexpected-exit']);
    expect(readExitLog()[1]?.detail).toContain('update was applied');
  });
});

describe('sharing', () => {
  it('is off until the user turns it on', () => {
    expect(telemetryEnabled()).toBe(false);
    setTelemetryEnabled(true);
    expect(telemetryEnabled()).toBe(true);
  });
});

describe('log', () => {
  it('resets visibly when unreadable and renders as text', () => {
    store().set('patch.exitLog.v1', '{nope');
    expect(readExitLog()[0]?.detail).toContain('unreadable');
    expect(exitLogText()).toContain('closed');
  });
});
