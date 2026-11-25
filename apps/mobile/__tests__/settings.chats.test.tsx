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
import { useSettingsStore } from '../src/stores/settingsStore';

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

  it('snooze hours default to 9 and 17, and a changed hour writes the shared settings', async () => {
    vi.mocked(api.setPreferences).mockImplementation(async (patch) => ({
      preferences: { ...DEFAULT_SHARED_SETTINGS, ...patch },
    }));
    const r = renderRN(<ChatsPage />);
    mounted.push(r);
    await flush();
    const get = (id: string) => findHost(r.root, byTestId(id));
    expect(get('snooze-morning-hour').props.value).toBe('9');
    expect(get('snooze-evening-hour').props.value).toBe('17');
    await actAsync(async () => {
      get('snooze-morning-hour').props.onChangeText('7');
      await flush();
    });
    await actAsync(async () => {
      get('snooze-morning-hour').props.onBlur();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ snoozeMorningHour: 7 });
  });
});

describe('mobile Settings → Chats — Account for titles and status', () => {
  it('offers Automatic and every Claude account by label, and writes backgroundAccount', async () => {
    seedSettings({
      shared: {
        version: 1,
        hosts: [],
        secrets: {
          claude: [
            { id: 'c1', label: 'Personal', connected: true },
            { id: 'c2', label: 'Max', connected: true },
          ],
          codex: [],
          providerKeys: [],
        },
      },
    });
    vi.mocked(api.setPreferences).mockImplementation(async (patch) => ({
      preferences: { ...DEFAULT_SHARED_SETTINGS, ...patch },
    }));
    const r = renderRN(<ChatsPage />);
    mounted.push(r);
    await flush();
    const get = (id: string) => findHost(r.root, byTestId(id));
    expect(get('background-account-auto').props.accessibilityState.selected).toBe(true);
    expect(get('background-account-auto').props.accessibilityLabel).toContain('Automatic');
    expect(get('background-account-c2').props.accessibilityLabel).toContain('Max');
    await actAsync(async () => {
      get('background-account-c2').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ backgroundAccount: 'c2' });
    expect(get('background-account-c2').props.accessibilityState.selected).toBe(true);
  });

  it('shows an account it no longer holds as it is, never as Automatic', async () => {
    const data = seedSettings();
    useSettingsStore.setState({
      data: { ...data, preferences: { ...data.preferences, backgroundAccount: 'gone' } },
    });
    const r = renderRN(<ChatsPage />);
    mounted.push(r);
    await flush();
    const gone = findHost(r.root, byTestId('background-account-gone'));
    expect(gone.props.accessibilityState.selected).toBe(true);
    expect(gone.props.accessibilityLabel).toContain('gone (not held)');
  });
});

describe('mobile Settings → Chats — Models for small jobs', () => {
  async function mount() {
    seedSettings({ preferences: { ...DEFAULT_SHARED_SETTINGS, smallJobModels: ['m1', 'm2'] } });
    vi.mocked(api.setPreferences).mockImplementation(async (patch) => ({
      preferences: { ...DEFAULT_SHARED_SETTINGS, ...patch },
    }));
    const r = renderRN(<ChatsPage />);
    mounted.push(r);
    await flush();
    return findHost(r.root, byTestId('small-job-models-input'));
  }

  it('shows the saved order and writes an edited list on blur', async () => {
    const field = await mount();
    expect(field.props.value).toBe('m1, m2');
    await actAsync(async () => {
      field.props.onChangeText('m2, m1');
      await flush();
    });
    await actAsync(async () => {
      findHost(mounted[0]!.root, byTestId('small-job-models-input')).props.onBlur();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ smallJobModels: ['m2', 'm1'] });
  });

  it('refuses a repeated model and does not write', async () => {
    const field = await mount();
    await actAsync(async () => {
      field.props.onChangeText('m1, m1');
      await flush();
    });
    await actAsync(async () => {
      findHost(mounted[0]!.root, byTestId('small-job-models-input')).props.onBlur();
      await flush();
    });
    expect(api.setPreferences).not.toHaveBeenCalled();
  });
});
