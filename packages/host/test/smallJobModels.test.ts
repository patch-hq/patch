import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SHARED_SETTINGS,
  DEFAULT_SMALL_JOB_MODELS,
  SharedSettingsPatch,
} from '@patch/wire';
import { runWithSmallJobModels } from '../src/smallJobModels.js';

describe('the smallJobModels setting', () => {
  it('starts as the default list', () => {
    expect(DEFAULT_SHARED_SETTINGS.smallJobModels).toEqual([...DEFAULT_SMALL_JOB_MODELS]);
  });
  it('takes a list, set model first', () => {
    expect(SharedSettingsPatch.parse({ smallJobModels: ['a', 'b', 'c'] }).smallJobModels).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
  it('refuses an empty list, an empty entry and a model named twice', () => {
    expect(() => SharedSettingsPatch.parse({ smallJobModels: [] })).toThrow();
    expect(() => SharedSettingsPatch.parse({ smallJobModels: ['a', ''] })).toThrow();
    expect(() => SharedSettingsPatch.parse({ smallJobModels: ['a', 'b', 'a'] })).toThrow(/twice/);
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
