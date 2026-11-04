import { describe, expect, it } from 'vitest';
import { assessHostHealth, describeHostOffline } from '../src/host-health.js';

const GB = 1024 ** 3;
const base = {
  memTotalBytes: 16 * GB,
  memAvailableBytes: 8 * GB,
  swapTotalBytes: 4 * GB,
  swapUsedBytes: 0,
  load1: 1,
  cpuCount: 4,
  eventLoopLagMs: 5,
};

describe('assessHostHealth', () => {
  it('is quiet on a healthy host', () => {
    expect(assessHostHealth(base)).toEqual({ reasons: [], critical: false });
  });

  it('flags low memory, critical only when swap is gone or memory is nearly out', () => {
    const low = { ...base, memAvailableBytes: 1 * GB };
    expect(assessHostHealth(low)).toEqual({ reasons: ['memory'], critical: false });
    expect(assessHostHealth({ ...low, swapUsedBytes: 4 * GB })).toEqual({
      reasons: ['memory'],
      critical: true,
    });
    expect(assessHostHealth({ ...base, memAvailableBytes: 0.3 * GB }).critical).toBe(true);
  });

  it('does not call full swap alone a problem', () => {
    expect(assessHostHealth({ ...base, swapUsedBytes: 4 * GB }).reasons).toEqual([]);
  });

  it('flags load and event-loop lag, and says nothing about memory it cannot measure', () => {
    const r = assessHostHealth({
      load1: 60,
      cpuCount: 4,
      eventLoopLagMs: 3000,
    });
    expect(r).toEqual({ reasons: ['load', 'lag'], critical: false });
  });
});

describe('battery and offline wording', () => {
  it('flags a low, discharging battery but not a charging one', () => {
    expect(assessHostHealth({ ...base, power: { onBattery: true, percent: 10 } }).reasons).toEqual([
      'battery',
    ]);
    expect(assessHostHealth({ ...base, power: { onBattery: false, percent: 10 } }).reasons).toEqual(
      [],
    );
    expect(assessHostHealth({ ...base, power: { onBattery: true, percent: 60 } }).reasons).toEqual(
      [],
    );
  });

  it('words the reasons a host dropped', () => {
    expect(describeHostOffline('Mac', 'battery')).toBe('Mac ran out of battery');
    expect(describeHostOffline('Mac', 'asleep')).toBe('Mac went to sleep');
    expect(describeHostOffline('Mac', 'unresponsive')).toBe('Mac stopped responding');
    expect(describeHostOffline('Mac', undefined)).toBe('Mac is offline');
  });
});
