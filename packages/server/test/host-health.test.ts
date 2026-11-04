import { describe, expect, it } from 'vitest';
import type { HostHealthEvent } from '@patch/wire';
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
  const tracker = new HostHealthTracker({ now: () => now });
  return { tracker, advance: (ms: number) => (now += ms) };
}

describe('HostHealthTracker', () => {
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
