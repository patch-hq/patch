import { describe, expect, it } from 'vitest';
import pino from 'pino';
import type { HostConditionEvent, HostHealthEvent } from '@patch/wire';
import { HostHealthTracker } from '../src/host-health.js';

const GB = 1024 ** 3;
const report = (over: Partial<HostHealthEvent> = {}): HostHealthEvent => ({
  type: 'host.health',
  hostId: 'h1',
  memTotalBytes: 16 * GB,
  memAvailableBytes: 8 * GB,
  swapTotalBytes: 4 * GB,
  swapUsedBytes: 0,
  load1: 1,
  cpuCount: 4,
  eventLoopLagMs: 5,
  intervalMs: 15_000,
  topProcesses: [],
  ...over,
});

function setup() {
  let now = 1_000_000;
  const broadcasts: HostConditionEvent[] = [];
  const notes: string[] = [];
  const tracker = new HostHealthTracker({
    logger: pino({ level: 'silent' }),
    hostName: () => 'Netcup',
    broadcast: (e) => broadcasts.push(e),
    notify: (m) => notes.push(m),
    now: () => now,
  });
  return { tracker, broadcasts, notes, advance: (ms: number) => (now += ms) };
}

describe('HostHealthTracker', () => {
  it('stays quiet while a host is healthy, apart from the first all-clear', () => {
    const { tracker, broadcasts, notes } = setup();
    tracker.observe(report());
    tracker.observe(report());
    expect(broadcasts.map((b) => b.state)).toEqual(['online']);
    expect(notes).toEqual([]);
    expect(tracker.conditionFor('h1')).toBeNull();
  });

  it('marks a host struggling once, names the culprits and notifies once', () => {
    const { tracker, broadcasts, notes } = setup();
    tracker.observe(report());
    const low = report({
      memAvailableBytes: 1 * GB,
      topProcesses: [{ name: 'vitest', count: 5, rssBytes: 11 * GB }],
    });
    tracker.observe(low);
    tracker.observe(low);
    const last = broadcasts.at(-1)!;
    expect(last).toMatchObject({ state: 'struggling', critical: false, reasons: ['memory'] });
    expect(notes).toEqual(['Netcup is low on memory — chats may be slow (5 vitest, 11 GB)']);
    expect(tracker.conditionFor('h1')).toEqual(last);
  });

  it('escalates to critical, then recovers', () => {
    const { tracker, broadcasts, notes } = setup();
    tracker.observe(report({ memAvailableBytes: 1 * GB }));
    tracker.observe(report({ memAvailableBytes: 0.2 * GB }));
    expect(broadcasts.at(-1)).toMatchObject({ state: 'struggling', critical: true });
    tracker.observe(report());
    expect(broadcasts.at(-1)).toMatchObject({ state: 'online', reasons: [] });
    expect(notes).toHaveLength(1);
  });

  it('does not notify again when it flaps inside the cooldown, but does after', () => {
    const { tracker, notes, advance } = setup();
    tracker.observe(report({ memAvailableBytes: 1 * GB }));
    tracker.observe(report());
    tracker.observe(report({ memAvailableBytes: 1 * GB }));
    expect(notes).toHaveLength(1);
    tracker.observe(report());
    advance(11 * 60_000);
    tracker.observe(report({ memAvailableBytes: 1 * GB }));
    expect(notes).toHaveLength(2);
  });

  it('calls a host whose reports run late slow to respond, until one arrives', () => {
    const { tracker, broadcasts, notes, advance } = setup();
    tracker.observe(report());
    advance(30_000);
    tracker.sweep();
    expect(broadcasts.at(-1)?.state).toBe('online');
    advance(16_000);
    tracker.sweep();
    expect(broadcasts.at(-1)).toMatchObject({ state: 'struggling', reasons: ['slow-link'] });
    expect(notes).toEqual(['Netcup is slow to respond — chats may be slow']);
    tracker.observe(report());
    expect(broadcasts.at(-1)?.state).toBe('online');
  });

  it('forgets a host that goes offline', () => {
    const { tracker } = setup();
    tracker.observe(report({ memAvailableBytes: 1 * GB }));
    tracker.observe({ type: 'host.offline', hostId: 'h1' });
    expect(tracker.conditionFor('h1')).toBeNull();
  });

  it('warns about a low battery that is not charging, with the charge', () => {
    const { tracker, broadcasts, notes } = setup();
    tracker.observe(report({ power: { onBattery: true, percent: 10 } }));
    expect(broadcasts.at(-1)).toMatchObject({
      state: 'struggling',
      reasons: ['battery'],
      batteryPercent: 10,
    });
    expect(notes).toEqual(['Netcup battery at 10%, not charging']);
  });

  describe('why a host dropped off', () => {
    it('says it ran out of battery when the last heartbeat was nearly flat and discharging', () => {
      const { tracker } = setup();
      tracker.observe(report({ power: { onBattery: true, percent: 4 } }));
      tracker.observe({ type: 'host.offline', hostId: 'h1' });
      expect(tracker.offlineReason('h1')).toBe('battery');
    });

    it('says it went to sleep when its machine reported sleeping after the last heartbeat', () => {
      const { tracker, advance } = setup();
      tracker.observe(report());
      advance(5_000);
      tracker.noteAsleep('h1', true);
      advance(60_000);
      tracker.observe({ type: 'host.offline', hostId: 'h1' });
      expect(tracker.offlineReason('h1')).toBe('asleep');
    });

    it('does not blame sleep once the machine has woken, or for an old report', () => {
      const { tracker, advance } = setup();
      tracker.noteAsleep('h1', true);
      advance(120_000);
      tracker.observe(report());
      tracker.observe({ type: 'host.offline', hostId: 'h1' });
      expect(tracker.offlineReason('h1')).toBe('unresponsive');
      tracker.observe({ type: 'host.online', hostId: 'h1' });
      expect(tracker.offlineReason('h1')).toBeUndefined();
      tracker.observe(report());
      tracker.noteAsleep('h1', true);
      tracker.noteAsleep('h1', false);
      tracker.observe({ type: 'host.offline', hostId: 'h1' });
      expect(tracker.offlineReason('h1')).toBe('unresponsive');
    });

    it('has no reason for a host that never reported', () => {
      const { tracker } = setup();
      tracker.observe({ type: 'host.offline', hostId: 'h2' });
      expect(tracker.offlineReason('h2')).toBeUndefined();
    });
  });
});
