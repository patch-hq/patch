import { describe, expect, it } from 'vitest';
import { groupProcesses, parseMeminfo } from '../src/healthReport.js';

describe('parseMeminfo', () => {
  it('reads memory and swap in bytes', () => {
    const m = parseMeminfo(
      'MemTotal:       16000000 kB\nMemFree: 1 kB\nMemAvailable:    1000000 kB\nSwapTotal:       4000000 kB\nSwapFree:        500000 kB\n',
    );
    expect(m).toEqual({
      memTotalBytes: 16000000 * 1024,
      memAvailableBytes: 1000000 * 1024,
      swapTotalBytes: 4000000 * 1024,
      swapUsedBytes: 3500000 * 1024,
    });
  });

  it('throws loudly when a field is missing', () => {
    expect(() => parseMeminfo('MemTotal: 1 kB\n')).toThrow(/MemAvailable/);
  });
});

describe('groupProcesses', () => {
  it('groups look-alikes, names interpreter scripts, biggest first', () => {
    const out = [
      ' 2097152 node node /repo/node_modules/vitest/vitest.mjs run',
      ' 2097152 node node /repo/node_modules/vitest/vitest.mjs run',
      '  102400 sshd sshd: tom',
      ' 1048576 claude claude --resume x',
    ].join('\n');
    expect(groupProcesses(out)).toEqual([
      { name: 'vitest', count: 2, rssBytes: 4194304 * 1024 },
      { name: 'claude', count: 1, rssBytes: 1048576 * 1024 },
      { name: 'sshd', count: 1, rssBytes: 102400 * 1024 },
    ]);
  });
});
