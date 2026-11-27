// Every prompt Patch sends lives once, on the page for the feature it drives,
// each Default or Custom, opening the shared full-screen editor.

import React from 'react';
import { act } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_WATCH_CHECK_IN_PROMPT } from '@patch/wire';
import { AgentPage, LayerEditor } from '../src/components/settings/AgentBehaviorSection';
import { GoalsPage } from '../src/components/settings/GoalsSection';
import {
  ManagerPage,
  MeetingsPage,
  VoicePage,
} from '../src/components/settings/PreferenceSections';
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
  api: {
    settings: vi.fn(),
    setPreferences: vi.fn(),
    models: vi.fn(),
    managerHome: vi.fn(async () => ({ hostId: null })),
    voiceUsage: vi.fn(async () => null),
    devices: vi.fn(async () => ({ devices: [] })),
  },
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

describe('Settings prompts', () => {
  it('has no Prompts page of its own any more', () => {
    expect(SETTINGS_PAGES.find((p) => p.id === 'prompts')).toBeUndefined();
  });

  it('every prompt sits on its own page as Default, and opens its editor', async () => {
    const pages: Array<[React.ReactElement, string[]]> = [
      [<AgentPage key="a" />, ['question-expired', 'watch-check-in', 'job-autonomy']],
      [<ManagerPage key="m" />, ['manager-voice', 'sweep']],
      [<VoicePage key="v" />, ['voice-instructions', 'voice-device']],
      [<MeetingsPage key="me" />, ['meeting-now', 'meeting-notes', 'meeting-actions']],
    ];
    for (const [el, layers] of pages) {
      const r = mount(el);
      await flush();
      for (const layer of layers) expect(textOf(get(r, `prompt-${layer}-state`))).toBe('Default');
    }
    const r = mount(<AgentPage />);
    await flush();
    await actAsync(() => get(r, 'prompt-watch-check-in-edit').props.onPress());
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/settings/layer',
      params: { layer: 'watch-check-in' },
    });
    // The goal judge keeps its own row on Goals.
    const g = mount(<GoalsPage />);
    await flush();
    expect(get(g, 'goal-judge-edit')).toBeTruthy();
  });

  it('writes the check-in interval, and ignores a value that is not a positive whole number', async () => {
    const r = mount(<AgentPage />);
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
    const r = mount(<AgentPage />);
    await flush();
    expect(textOf(get(r, 'prompt-watch-check-in-state'))).toBe('Custom');
  });
});

describe('Settings → Meetings models and timing', () => {
  it('shows the default meeting models and writes the interval, with no transcription model field', async () => {
    const r = mount(<MeetingsPage />);
    await flush();
    expect(get(r, 'meeting-analysis-model')).toBeTruthy();
    expect(get(r, 'meeting-cleanup-model')).toBeTruthy();
    expect(get(r, 'meeting-analyse-seconds').props.value).toBe('45');

    expect(r.root.findAll((n) => n.props.testID === 'meeting-transcription-model')).toHaveLength(0);

    await actAsync(() => get(r, 'meeting-analyse-seconds').props.onChangeText('2'));
    await actAsync(() => get(r, 'meeting-analyse-seconds').props.onBlur());
    expect(api.setPreferences).not.toHaveBeenCalledWith({ meetingAnalyseSeconds: 2 });
    expect(get(r, 'meeting-analyse-seconds').props.value).toBe('45');

    await actAsync(() => get(r, 'meeting-analyse-seconds').props.onChangeText('30'));
    await actAsync(async () => {
      get(r, 'meeting-analyse-seconds').props.onBlur();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ meetingAnalyseSeconds: 30 });
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
