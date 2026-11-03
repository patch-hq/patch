import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SMALL_JOB_MODELS,
  parseSmallJobModels,
  runWithSmallJobModels,
} from '../src/smallJobModels.js';

describe('parseSmallJobModels', () => {
  it('uses the default list when nothing is configured', () => {
    expect(parseSmallJobModels(undefined)).toEqual([...DEFAULT_SMALL_JOB_MODELS]);
  });
  it('reads a comma-separated list, set model first', () => {
    expect(parseSmallJobModels(' a , b,c ')).toEqual(['a', 'b', 'c']);
  });
  it('refuses an empty entry rather than guessing', () => {
    expect(() => parseSmallJobModels('a,,b')).toThrow(/empty/);
    expect(() => parseSmallJobModels('  ')).toThrow(/empty/);
  });
  it('refuses a model named twice', () => {
    expect(() => parseSmallJobModels('a,b,a')).toThrow(/twice/);
  });
});

describe('runWithSmallJobModels', () => {
  it('runs on the set model and stops there when it works', async () => {
    const run = vi.fn(async (m: string) => `ok:${m}`);
    expect(await runWithSmallJobModels(['a', 'b'], 'job', run)).toBe('ok:a');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('walks the failover list in order and reports each failure', async () => {
    const warn = vi.fn();
    const run = vi.fn(async (m: string) => {
      if (m !== 'c') throw new Error(`${m} unavailable`);
      return 'ok:c';
    });
    const out = await runWithSmallJobModels(['a', 'b', 'c'], 'job', run, { warn });
    expect(out).toBe('ok:c');
    expect(run.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it('throws the last error, naming every model tried, when all fail', async () => {
    const run = async (m: string): Promise<string> => {
      throw new Error(`${m} down`);
    };
    await expect(runWithSmallJobModels(['a', 'b'], 'job', run)).rejects.toThrow(/b down/);
    await expect(runWithSmallJobModels(['a', 'b'], 'job', run)).rejects.toThrow(/a, b/);
  });
});
