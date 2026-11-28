// lib/stallWatchdog.ts — a blocked JS thread is logged with what was open.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('expo-updates', () => ({ updateId: 'u1' }));

import { store } from '../src/lib/credential';
import { beginSession, clearExitLog, readExitLog } from '../src/lib/exitLog';
import { registerOverlay, setWatchdogRoute, startStallWatchdog } from '../src/lib/stallWatchdog';

beforeEach(() => {
  vi.useFakeTimers();
  store().delete('patch.exitSession.v1');
  clearExitLog();
  beginSession(Date.now());
});
afterEach(() => vi.useRealTimers());

describe('stall watchdog', () => {
  it('logs nothing while ticks are on time', () => {
    const stop = startStallWatchdog();
    vi.advanceTimersByTime(5_000);
    stop();
    expect(readExitLog()).toEqual([]);
  });

  it('names the screen and the open overlay when a tick is late', () => {
    setWatchdogRoute('/chats/abc');
    const close = registerOverlay('AnchoredMenu (non-modal)');
    const stop = startStallWatchdog();
    vi.advanceTimersByTime(500);
    // the thread is blocked: the clock moves, no timer runs
    vi.setSystemTime(Date.now() + 6_000);
    vi.advanceTimersByTime(500);
    stop();
    close();
    const [entry] = readExitLog();
    expect(entry?.kind).toBe('stall');
    expect(entry?.detail).toContain('/chats/abc');
    expect(entry?.detail).toContain('AnchoredMenu (non-modal)');
  });

  it('saves the context so an unrecovered freeze is named on relaunch', () => {
    setWatchdogRoute('/chats/xyz');
    const stop = startStallWatchdog();
    vi.advanceTimersByTime(500);
    stop();
    beginSession(Date.now() + 60_000);
    expect(readExitLog().at(-1)?.detail).toContain('/chats/xyz');
  });
});
