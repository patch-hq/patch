// A slow `/api/settings` read must not undo a newer `settings.changed` push
// that landed while it was in flight.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AccountPreferences, SharedState } from '../api/rest.js';

const settings = vi.fn();
const setPreferences = vi.fn();
vi.mock('../api/rest.js', () => ({
  api: { settings: () => settings(), setPreferences: (p: unknown) => setPreferences(p) },
}));

// The shared setup already pulled the real store in (via the voice-readiness
// imports); drop it so the store under test is built against the mocked api.
vi.resetModules();
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

describe('preferencesStore.update', () => {
  it('rejects when the server answers without the value that was sent', async () => {
    setPreferences.mockResolvedValueOnce({ preferences: DEFAULT_PREFERENCES });
    await expect(
      usePreferencesStore.getState().update({ meetingTranscriptionModel: 'x' }),
    ).rejects.toThrow('did not save meetingTranscriptionModel');
  });

  it('settles on the committed preferences when they match', async () => {
    const preferences = { ...DEFAULT_PREFERENCES, meetingTranscriptionModel: 'x' };
    setPreferences.mockResolvedValueOnce({ preferences });
    await usePreferencesStore.getState().update({ meetingTranscriptionModel: 'x' });
    expect(usePreferencesStore.getState().preferences.meetingTranscriptionModel).toBe('x');
  });

  it('accepts a nested voiceAgent the server returns in its own key order', async () => {
    const sent = {
      setups: {
        elevenlabs: {
          sound: {
            stability: 0.7,
            similarity: 0.8,
            speed: 0.95,
            expressive: true,
            eagerness: 'patient',
          },
          voice: 'adam',
          model: 'claude-sonnet-5-5',
        },
        gemini: { sound: {}, model: 'g' },
        openai: { sound: {}, model: 'o' },
      },
      provider: 'elevenlabs',
    } as unknown as AccountPreferences['voiceAgent'];
    const returned = {
      provider: 'elevenlabs',
      setups: {
        gemini: { model: 'g', sound: {} },
        openai: { model: 'o', sound: {} },
        elevenlabs: {
          model: 'claude-sonnet-5-5',
          voice: 'adam',
          sound: {
            eagerness: 'patient',
            expressive: true,
            speed: 0.95,
            similarity: 0.8,
            stability: 0.7,
          },
        },
      },
    } as unknown as AccountPreferences['voiceAgent'];
    setPreferences.mockResolvedValueOnce({
      preferences: { ...DEFAULT_PREFERENCES, voiceAgent: returned },
    });
    await usePreferencesStore.getState().update({ voiceAgent: sent });
    expect(usePreferencesStore.getState().preferences.voiceAgent).toEqual(returned);
  });

  it('still rejects a voiceAgent whose value changed', async () => {
    const sent = { provider: 'elevenlabs', setups: { a: { sound: { speed: 0.95 } } } };
    const got = { provider: 'elevenlabs', setups: { a: { sound: { speed: 1 } } } };
    setPreferences.mockResolvedValueOnce({
      preferences: { ...DEFAULT_PREFERENCES, voiceAgent: got },
    });
    await expect(
      usePreferencesStore.getState().update({ voiceAgent: sent } as never),
    ).rejects.toThrow('did not save voiceAgent');
  });
});
