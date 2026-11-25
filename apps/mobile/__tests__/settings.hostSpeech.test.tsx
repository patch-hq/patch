// Settings → Dictation → Hosts transcribe with: the shared `speechBackend`.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import { DictationPage } from '../src/components/settings/PreferenceSections';
import { renderRN, findHost, byTestId, actAsync, flush } from './testUtils/render';
import { api } from '../src/api/rest';
import { resetHosts, seedSettings } from './testUtils/settingsFixtures';

vi.mock('../src/api/rest', () => ({ api: { setPreferences: vi.fn() } }));

const mounted: ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  resetHosts();
  seedSettings();
});

describe('mobile Settings → Dictation → Hosts transcribe with', () => {
  it('marks the saved engine and writes the one chosen', async () => {
    vi.mocked(api.setPreferences).mockImplementation(async (patch) => ({
      preferences: { ...DEFAULT_SHARED_SETTINGS, ...patch },
    }));
    const r = renderRN(<DictationPage />);
    mounted.push(r);
    await flush();
    const get = (id: string) => findHost(r.root, byTestId(id));
    expect(get('host-speech-auto').props.accessibilityState.selected).toBe(true);
    await actAsync(async () => {
      get('host-speech-groq').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ speechBackend: 'groq' });
  });
});
