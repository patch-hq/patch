// Settings → Chats: the title and status switches, which are not usage settings.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import { ChatsPage } from '../src/components/settings/ChatsSection';
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

describe('mobile Settings → Chats', () => {
  it('title and status generation toggles write the shared settings', async () => {
    vi.mocked(api.setPreferences).mockImplementation(async (patch) => ({
      preferences: { ...DEFAULT_SHARED_SETTINGS, ...patch },
    }));
    const r = renderRN(<ChatsPage />);
    mounted.push(r);
    await flush();
    const get = (id: string) => findHost(r.root, byTestId(id));
    expect(get('title-generation').props.value).toBe(true);
    await actAsync(async () => {
      get('title-generation').props.onValueChange(false);
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ titleGenerationEnabled: false });
    await actAsync(async () => {
      get('status-generation').props.onValueChange(false);
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ statusGenerationEnabled: false });
  });
});
