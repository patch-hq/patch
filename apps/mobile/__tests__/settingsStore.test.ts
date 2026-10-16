// The Settings tab's store: a slow `/api/settings` read must not undo a newer
// `settings.changed` push that landed while it was in flight.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SettingsResponse, SharedState } from '../src/api/rest';

const settings = vi.fn<(signal?: AbortSignal) => Promise<SettingsResponse>>();
vi.mock('../src/api/rest', () => ({
  api: { settings: (signal?: AbortSignal) => settings(signal) },
}));

const { useSettingsStore } = await import('../src/stores/settingsStore');

const shared = (version: number, addressWord: string): SharedState =>
  ({
    version,
    settings: { addressWord },
    secrets: {},
    hosts: [],
  }) as never;

const response = (version: number, addressWord: string): SettingsResponse => {
  const { settings: preferences, ...rest } = shared(version, addressWord);
  return { devices: [], push: { tokenCount: 0 }, preferences, shared: rest };
};

beforeEach(() => {
  useSettingsStore.getState()._reset();
  settings.mockReset();
});

describe('settingsStore.load', () => {
  it('a read older than a push already applied keeps the pushed state', async () => {
    settings.mockResolvedValueOnce(response(1, 'patch'));
    await useSettingsStore.getState().load();

    let answer!: (r: SettingsResponse) => void;
    settings.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const slow = useSettingsStore.getState().load();
    useSettingsStore.getState().applyShared(shared(3, 'pushed'));
    answer(response(2, 'stale'));
    await slow;

    const data = useSettingsStore.getState().data;
    expect(data?.shared?.version).toBe(3);
    expect(data?.preferences.addressWord).toBe('pushed');
  });

  it('a newer read replaces the held state', async () => {
    settings.mockResolvedValueOnce(response(1, 'old'));
    await useSettingsStore.getState().load();
    settings.mockResolvedValueOnce(response(2, 'new'));
    await useSettingsStore.getState().load();
    const data = useSettingsStore.getState().data;
    expect(data?.shared?.version).toBe(2);
    expect(data?.preferences.addressWord).toBe('new');
  });

  it('a read that never answers fails with a message instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      settings.mockImplementationOnce(
        (signal) =>
          new Promise((_, reject) =>
            signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      );
      const pending = useSettingsStore.getState().load();
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      expect(useSettingsStore.getState().data).toBeNull();
      expect(useSettingsStore.getState().error).toMatch(/no answer from the server/);
    } finally {
      vi.useRealTimers();
    }
  });
});
