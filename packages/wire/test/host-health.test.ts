import { describe, expect, it } from 'vitest';
import { assessHostHealth, describeHostCondition } from '../src/host-health.js';

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

describe('describeHostCondition', () => {
  it('names the host and the biggest processes', () => {
    expect(
      describeHostCondition('Netcup', {
        reasons: ['memory'],
        critical: false,
        topProcesses: [{ name: 'vitest', count: 5, rssBytes: 11 * GB }],
      }),
    ).toBe('Netcup is low on memory — chats may be slow (5 vitest, 11 GB)');
  });

  it('says turns are on hold when critical', () => {
    expect(
      describeHostCondition('Netcup', { reasons: ['memory'], critical: true, topProcesses: [] }),
    ).toBe('Netcup is low on memory — new turns are on hold');
  });
});
