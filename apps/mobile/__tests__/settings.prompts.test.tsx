// Settings → Prompts: every prompt Patch sends to an agent in one list, each
// Default or Custom, opening the shared full-screen editor.

import React from 'react';
import { act } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_WATCH_CHECK_IN_PROMPT } from '@patch/wire';
import { LayerEditor } from '../src/components/settings/AgentBehaviorSection';
import { PromptsPage } from '../src/components/settings/PromptsSection';
import { SETTINGS_PAGES } from '../src/components/settings/pages';
import { renderRN, findHost, byTestId, textOf, actAsync, flush } from './testUtils/render';
import { api } from '../src/api/rest';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { useSettingsStore } from '../src/stores/settingsStore';
import {
  reportHost,
  resetHosts,
  seedSettings,
  settingsFixture,
} from './testUtils/settingsFixtures';

const send = vi.fn();
vi.mock('../src/api/ws', () => ({ getWs: () => ({ send }) }));
vi.mock('../src/api/rest', () => ({
  api: { settings: vi.fn(), setPreferences: vi.fn(), models: vi.fn() },
}));

type R = ReturnType<typeof renderRN>;
const mounted: R[] = [];
function mount(el: React.ReactElement): R {
  const r = renderRN(el);
  mounted.push(r);
  return r;
}
const get = (r: R, id: string): ReturnType<typeof findHost> => findHost(r.root, byTestId(id));

beforeEach(() => {
  send.mockReset();
  __resetRouterMock();
  useSettingsStore.getState()._reset();
  vi.mocked(api.settings).mockReset().mockResolvedValue(settingsFixture());
  vi.mocked(api.setPreferences)
    .mockReset()
    .mockImplementation(async (patch) => ({
      preferences: { ...settingsFixture().preferences, ...patch },
    }));
  vi.mocked(api.models).mockReset().mockResolvedValue({ models: [] });
  resetHosts();
  reportHost('home', { hostName: 'laptop', runsManager: true });
  seedSettings();
});

afterEach(() => {
  for (const r of mounted.splice(0)) {
    try {
      act(() => r.unmount());
    } catch {
      // already unmounted by the test
    }
  }
});

describe('Settings → Prompts', () => {
  it('is a page of its own', () => {
    expect(SETTINGS_PAGES.find((p) => p.id === 'prompts')?.title).toBe('Prompts');
  });

  it('lists every prompt as Default, and opens its editor', async () => {
    const r = mount(<PromptsPage />);
    await flush();
    for (const layer of [
      'watch-check-in',
      'sweep',
      'goal-judge',
      'link-summary',
      'job-autonomy',
      'tools',
      'system',
    ]) {
      expect(textOf(get(r, `prompt-${layer}-state`))).toBe('Default');
    }
    await actAsync(() => get(r, 'prompt-watch-check-in-edit').props.onPress());
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/settings/layer',
      params: { layer: 'watch-check-in' },
    });
  });

  it('writes the check-in interval, and ignores a value that is not a positive whole number', async () => {
    const r = mount(<PromptsPage />);
    await flush();
    expect(get(r, 'watch-check-in-minutes').props.value).toBe('60');
    await actAsync(() => get(r, 'watch-check-in-minutes').props.onChangeText('0'));
    await actAsync(() => get(r, 'watch-check-in-minutes').props.onBlur());
    expect(api.setPreferences).not.toHaveBeenCalled();
    await actAsync(() => get(r, 'watch-check-in-minutes').props.onChangeText('15'));
    await actAsync(async () => {
      get(r, 'watch-check-in-minutes').props.onBlur();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ watchCheckInMinutes: 15 });
  });

  it('marks an edited prompt Custom', async () => {
    seedSettings({
      preferences: { ...settingsFixture().preferences, watchCheckInPrompt: 'Mine.' },
    });
    const r = mount(<PromptsPage />);
    await flush();
    expect(textOf(get(r, 'prompt-watch-check-in-state'))).toBe('Custom');
  });
});

describe('the check-in prompt editor', () => {
  it('starts from the default, saves an edit, and Reset writes the default back', async () => {
    const r = mount(<LayerEditor layer="watch-check-in" />);
    expect(get(r, 'layer-editor-text').props.value).toBe(DEFAULT_WATCH_CHECK_IN_PROMPT);
    expect(get(r, 'layer-editor-reset').props.disabled).toBe(true);
    await actAsync(() => get(r, 'layer-editor-text').props.onChangeText('Still alive?'));
    await actAsync(async () => {
      get(r, 'layer-editor-save').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ watchCheckInPrompt: 'Still alive?' });

    seedSettings({
      preferences: { ...settingsFixture().preferences, watchCheckInPrompt: 'Mine.' },
    });
    const r2 = mount(<LayerEditor layer="watch-check-in" />);
    await actAsync(async () => {
      get(r2, 'layer-editor-reset').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({
      watchCheckInPrompt: DEFAULT_WATCH_CHECK_IN_PROMPT,
    });
  });
});
