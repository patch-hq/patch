// Settings → Agent → Link summary (spec/14 § Message links): the prompt the
// Summarise button runs with, edited in the same full-screen editor as the other
// prompts. Account-wide shared setting.

import React from 'react';
import { act } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_LINK_SUMMARY_PROMPT } from '@patch/wire';
import { AgentPage, LayerEditor } from '../src/components/settings/AgentBehaviorSection';
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

const CATALOGUE = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
];

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
  vi.mocked(api.models).mockReset().mockResolvedValue({ models: CATALOGUE });
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

describe('Settings → Agent → Link summary', () => {
  it('says whether the prompt is the built-in one, and opens its editor', async () => {
    const r = mount(<AgentPage />);
    await flush();
    expect(textOf(get(r, 'link-summary-summary'))).toBe('Built-in default');
    await actAsync(() => get(r, 'link-summary-edit').props.onPress());
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/settings/layer',
      params: { layer: 'link-summary' },
    });
  });

  it('shows the first line of a prompt that has been edited', async () => {
    seedSettings({
      preferences: {
        ...settingsFixture().preferences,
        linkSummaryPrompt: 'One line only.\nAlways.',
      },
    });
    const r = mount(<AgentPage />);
    await flush();
    expect(textOf(get(r, 'link-summary-summary'))).toBe('One line only.');
  });
});

describe('the link summary prompt editor', () => {
  it('starts from the saved prompt, saves an edit and returns', async () => {
    const r = mount(<LayerEditor layer="link-summary" />);
    expect(get(r, 'layer-editor-text').props.value).toBe(DEFAULT_LINK_SUMMARY_PROMPT);
    expect(get(r, 'layer-editor-save').props.disabled).toBe(true);
    await actAsync(() => get(r, 'layer-editor-text').props.onChangeText('One line only.'));
    await actAsync(async () => {
      get(r, 'layer-editor-save').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ linkSummaryPrompt: 'One line only.' });
    expect(routerMock.back).toHaveBeenCalled();
  });

  it('Reset is disabled on the default, and with an edited prompt writes the default back', async () => {
    const r1 = mount(<LayerEditor layer="link-summary" />);
    expect(get(r1, 'layer-editor-reset').props.disabled).toBe(true);

    seedSettings({
      preferences: { ...settingsFixture().preferences, linkSummaryPrompt: 'Mine.' },
    });
    const r2 = mount(<LayerEditor layer="link-summary" />);
    await actAsync(async () => {
      get(r2, 'layer-editor-reset').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({
      linkSummaryPrompt: DEFAULT_LINK_SUMMARY_PROMPT,
    });
  });
});
