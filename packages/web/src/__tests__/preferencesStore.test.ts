// A slow `/api/settings` read must not undo a newer `settings.changed` push
// that landed while it was in flight.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SharedState } from '../api/rest.js';

const settings = vi.fn();
vi.mock('../api/rest.js', () => ({
  api: { settings: () => settings() },
}));

const { usePreferencesStore, DEFAULT_PREFERENCES } = await import('../stores/preferencesStore.js');

const shared = (version: number, addressWord: string): SharedState =>
  ({
    version,
    settings: { ...DEFAULT_PREFERENCES, addressWord },
    secrets: {},
    hosts: [],
  }) as never;

const response = (version: number, addressWord: string) => {
  const { settings: preferences, ...rest } = shared(version, addressWord);
  return { devices: [], preferences, shared: rest };
};

beforeEach(() => {
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES, loaded: false, shared: null });
  settings.mockReset();
});

describe('preferencesStore.load', () => {
  it('a read older than a push already applied keeps the pushed state', async () => {
    let answer!: (r: unknown) => void;
    settings.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const slow = usePreferencesStore.getState().load();
    usePreferencesStore.getState().apply(shared(3, 'pushed'));
    answer(response(2, 'stale'));
    await slow;

    const s = usePreferencesStore.getState();
    expect(s.shared?.version).toBe(3);
    expect(s.preferences.addressWord).toBe('pushed');
  });

  it('a newer read replaces the held state', async () => {
    usePreferencesStore.getState().apply(shared(1, 'old'));
    settings.mockResolvedValueOnce(response(2, 'new'));
    await usePreferencesStore.getState().load();
    const s = usePreferencesStore.getState();
    expect(s.shared?.version).toBe(2);
    expect(s.preferences.addressWord).toBe('new');
  });
});
