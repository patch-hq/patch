// Settings → Manager and Settings → Voice (design/settings-redesign), plus the
// account-preferences store behind them (GET/PATCH /api/settings, spec/14 §
// `/settings` details). Account-wide rows write a partial PATCH through
// `api.setPreferences` exactly as web does and report a failed write rather
// than swallowing it. Voice's Speaking group is per host (the one picked in
// the switcher) and writes that host with `host.settings`.

import { ExperimentalPage } from '../src/components/settings/ExperimentalSection';
import { usePresenceStore } from '../src/stores/presenceStore';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-test-renderer';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import {
  ManagerPage,
  DictationPage,
  MeetingsPage,
  VoicePage,
  writePreferences,
} from '../src/components/settings/PreferenceSections';
import { KOKORO_VOICES } from '../src/components/settings/VoiceDeviceAnswer';
import { snap } from '../src/components/settings/VoiceAgentSection';
import { DEFAULT_VOICE_AGENT, VOICE_AGENT_ENGINES, type VoiceCatalog } from '@patch/wire/audio';
import {
  renderRN as renderBase,
  findHost,
  queryHost,
  byTestId,
  byLabel,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { useSettingsStore } from '../src/stores/settingsStore';
import { addressWordOrNull } from '../src/lib/preferences';
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
    managerHome: vi.fn(),
    managerHomeDraft: vi.fn(),
    setManagerHome: vi.fn(),
    getChatSession: vi.fn(),
    rotateChat: vi.fn(),
    managerFinished: vi.fn(),
  },
}));

const CATALOGUE = [
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
];

beforeEach(() => {
  vi.mocked(api.settings).mockReset().mockResolvedValue(settingsFixture());
  vi.mocked(api.setPreferences)
    .mockReset()
    .mockImplementation(async (patch) => ({
      preferences: { ...settingsFixture().preferences, ...patch },
    }));
  vi.mocked(api.models).mockReset().mockResolvedValue({ models: CATALOGUE });
  vi.mocked(api.managerHome).mockReset().mockResolvedValue({ hostId: 'home' });
  vi.mocked(api.getChatSession).mockReset().mockResolvedValue({ session: null });
  vi.mocked(api.rotateChat).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(api.managerFinished)
    .mockReset()
    .mockResolvedValue({ waiting: 0, sending: 0, lastSent: null });
  vi.mocked(api.managerHomeDraft).mockReset().mockResolvedValue({ message: 'user: hello' });
  vi.mocked(api.setManagerHome)
    .mockReset()
    .mockImplementation(async (hostId) => ({ hostId }));
  send.mockReset();
  __clearLastAlert();
  useSettingsStore.getState()._reset();
  resetHosts();
  reportHost('home', { hostName: 'laptop', runsManager: true });
});

// Every tree is unmounted after its test, so a page left mounted cannot react
// to (and fetch for) the next test's store writes.
const mounted: ReturnType<typeof renderBase>[] = [];
function renderRN(el: React.ReactElement): ReturnType<typeof renderBase> {
  const r = renderBase(el);
  mounted.push(r);
  return r;
}

afterEach(() => {
  for (const r of mounted.splice(0)) {
    try {
      act(() => r.unmount());
    } catch {
      // already unmounted by the test
    }
  }
});

async function pick(r: ReturnType<typeof renderRN>, picker: string, id: string): Promise<void> {
  await actAsync(() => findHost(r.root, byTestId(picker)).props.onPress());
  await actAsync(async () => {
    findHost(r.root, byTestId(`${picker}-option-${id}`)).props.onPress();
    await flush();
  });
}

describe('settings store', () => {
  it('load() keeps the response; a failure lands in `error`, never a stand-in', async () => {
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().data?.preferences.addressWord).toBe('patch');
    vi.mocked(api.settings).mockRejectedValueOnce(new Error('HTTP 500'));
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().error).toBe('HTTP 500');
    // The last good read stays; the failure is reported alongside it.
    expect(useSettingsStore.getState().data).not.toBeNull();
  });

  it('a response with no preferences is an error, not an empty account', async () => {
    vi.mocked(api.settings).mockResolvedValueOnce({
      ...settingsFixture(),
      preferences: undefined,
    } as never);
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().error).toBe('server returned no account preferences');
    expect(useSettingsStore.getState().data).toBeNull();
  });

  it('the address word a quiet call uses follows a Settings edit', async () => {
    seedSettings();
    await useSettingsStore.getState().updatePreferences({ addressWord: 'otto' });
    expect(addressWordOrNull()).toBe('otto');
  });
});

describe('sections before the settings have loaded', () => {
  it('draw a loading affordance, then the failure with a working Retry', async () => {
    const r = renderRN(<ManagerPage />);
    expect(findHost(r.root, byTestId('manager-loading'))).toBeTruthy();
    await actAsync(() => useSettingsStore.setState({ error: 'HTTP 502' }));
    expect(textOf(findHost(r.root, byTestId('manager-error')))).toBe(
      'Couldn’t load settings: HTTP 502',
    );
    await actAsync(async () => {
      findHost(r.root, byLabel('Retry')).props.onPress();
      await flush();
    });
    expect(api.settings).toHaveBeenCalled();
    expect(findHost(r.root, byTestId('manager-wake-mode-off'))).toBeTruthy();
  });
});

const DEVICES = [
  {
    surfaceId: 'phone-1',
    surfaceKind: 'mobile',
    label: 'Pixel',
    issuedAt: 1,
    status: 'online',
    lastHeartbeat: 1,
    isCurrent: true,
  },
  {
    surfaceId: 'mac-1',
    surfaceKind: 'desktop',
    label: 'MacBook',
    issuedAt: 2,
    status: 'online',
    lastHeartbeat: 1,
    isCurrent: false,
  },
  {
    surfaceId: 'web-1',
    surfaceKind: 'web',
    label: 'Chrome',
    issuedAt: 3,
    status: 'online',
    lastHeartbeat: 1,
    isCurrent: false,
  },
] as never;

const CATALOG: VoiceCatalog = {
  gemini: {
    at: 1,
    models: [
      {
        id: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
        label: 'Gemini 2.5 Flash Native Audio',
      },
      { id: 'models/gemini-3.8-live', label: 'Gemini 3.8 Live' },
    ],
    voices: [
      { id: 'Puck', label: 'Puck' },
      { id: 'Kore', label: 'Kore' },
    ],
  },
  elevenlabs: {
    at: 1,
    models: [{ id: 'claude-haiku-4-5', label: 'claude-haiku-4-5' }],
    voices: [{ id: 'v-rachel', label: 'Rachel' }],
    speechModels: [{ id: 'eleven_v3_conversational', label: 'Eleven v3 conversational' }],
  },
};

function withAgent(agent: typeof DEFAULT_VOICE_AGENT): void {
  seedSettings({ preferences: { ...settingsFixture().preferences, voiceAgent: agent } });
}

describe('Voice calls: the voice agent', () => {
  beforeEach(() => {
    reportHost('home', {
      hostName: 'laptop',
      runsManager: true,
      voiceKeys: { gemini: true, openai: false, elevenlabs: true },
      voiceCatalog: CATALOG,
    });
  });

  it('offers the three providers, no Local, and writes only the provider', async () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    expect(queryHost(r.root, byTestId('voice-agent-provider-local'))).toBeNull();
    expect(
      findHost(r.root, byTestId('voice-agent-provider-gemini')).props.accessibilityState.selected,
    ).toBe(true);
    await actAsync(async () => {
      findHost(r.root, byTestId('voice-agent-provider-elevenlabs')).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({
      voiceAgent: { ...DEFAULT_VOICE_AGENT, provider: 'elevenlabs' },
    });
  });

  it('lists the models a host read and reveals Voice, then How it sounds', async () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    expect(textOf(findHost(r.root, byTestId('voice-agent-model-status')))).toBe('2 models');
    expect(queryHost(r.root, byTestId('voice-agent-sound'))).toBeNull();
    await pick(r, 'voice-agent-voice', 'Kore');
    expect(api.setPreferences).toHaveBeenLastCalledWith({
      voiceAgent: {
        ...DEFAULT_VOICE_AGENT,
        setups: {
          ...DEFAULT_VOICE_AGENT.setups,
          gemini: { ...DEFAULT_VOICE_AGENT.setups.gemini, voice: 'Kore' },
        },
      },
    });
  });

  it('draws only the provider’s own controls, from its description, with the calm defaults', () => {
    withAgent({
      provider: 'elevenlabs',
      setups: {
        ...DEFAULT_VOICE_AGENT.setups,
        elevenlabs: { model: 'claude-haiku-4-5', voice: 'v-rachel', sound: {} },
      },
    });
    const r = renderRN(<VoicePage />);
    expect(findHost(r.root, byTestId('voice-agent-sound'))).toBeTruthy();
    for (const c of VOICE_AGENT_ENGINES.elevenlabs.controls) {
      expect(
        queryHost(
          r.root,
          byTestId(
            c.kind === 'slider' || c.kind === 'choice' || c.kind === 'list'
              ? `voice-agent-${c.key}-row`
              : c.kind === 'tone'
                ? 'voice-agent-tone-row'
                : `voice-agent-${c.key}`,
          ),
        ),
      ).not.toBeNull();
    }
    expect(queryHost(r.root, byTestId('voice-agent-matchTone'))).toBeNull();
    expect(textOf(findHost(r.root, byTestId('voice-agent-stability-value')))).toBe('0.7');
    expect(textOf(findHost(r.root, byTestId('voice-agent-speed-value')))).toBe('0.95×');
    expect(
      findHost(r.root, byTestId('voice-agent-eagerness-patient')).props.accessibilityState.selected,
    ).toBe(true);
  });

  it('a slider step writes the snapped value into the provider setup', async () => {
    withAgent({
      provider: 'elevenlabs',
      setups: {
        ...DEFAULT_VOICE_AGENT.setups,
        elevenlabs: { model: 'claude-haiku-4-5', voice: 'v-rachel', sound: {} },
      },
    });
    const r = renderRN(<VoicePage />);
    await actAsync(async () => {
      findHost(r.root, byTestId('voice-agent-stability')).props.onAccessibilityAction({
        nativeEvent: { actionName: 'increment' },
      });
      await flush();
    });
    expect(api.setPreferences).toHaveBeenLastCalledWith({
      voiceAgent: expect.objectContaining({
        setups: expect.objectContaining({
          elevenlabs: { model: 'claude-haiku-4-5', voice: 'v-rachel', sound: { stability: 0.75 } },
        }),
      }),
    });
  });

  it('snap keeps a slider on its steps and inside its bounds', () => {
    const speed = VOICE_AGENT_ENGINES.openai.controls.find((c) => c.key === 'speed');
    if (speed?.kind !== 'slider') throw new Error('openai speed is a slider');
    expect(snap(speed, 0.97)).toBe(0.95);
    expect(snap(speed, 9)).toBe(1.5);
    expect(snap(speed, 0)).toBe(0.25);
  });

  it('tone is kept per voice and saved when the field loses focus', async () => {
    withAgent({
      provider: 'gemini',
      setups: {
        ...DEFAULT_VOICE_AGENT.setups,
        gemini: { model: 'models/gemini-3.8-live', voice: 'Kore', sound: {} },
      },
    });
    const r = renderRN(<VoicePage />);
    const tone = findHost(r.root, byTestId('voice-agent-tone'));
    await actAsync(async () => tone.props.onChangeText('Calm. [slow] when explaining.'));
    expect(api.setPreferences).not.toHaveBeenCalled();
    await actAsync(async () => {
      findHost(r.root, byTestId('voice-agent-tone')).props.onBlur();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenLastCalledWith({
      voiceTones: { 'gemini:Kore': 'Calm. [slow] when explaining.' },
    });
  });

  it('Refresh asks each online host with the key to read again', async () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    await actAsync(async () =>
      findHost(r.root, byTestId('voice-agent-model-refresh')).props.onPress(),
    );
    expect(send).toHaveBeenCalledWith({
      type: 'host.voice_catalog_refresh',
      hostId: 'home',
      provider: 'gemini',
    });
  });

  it('a failed write is reported', async () => {
    vi.mocked(api.setPreferences).mockRejectedValue(new Error('nope'));
    seedSettings();
    const r = renderRN(<VoicePage />);
    await actAsync(async () => {
      findHost(r.root, byTestId('voice-agent-provider-openai')).props.onPress();
      await flush();
    });
    expect(__getLastAlert()?.message).toContain('nope');
  });
});

describe('Voice calls: agents calling you and calls', () => {
  it('Answer automatically shows only while agents can call; both write', async () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    expect(findHost(r.root, byTestId('agent-call-auto-answer'))).toBeTruthy();
    await actAsync(async () => {
      findHost(r.root, byTestId('agents-can-call')).props.onValueChange(false);
      await flush();
    });
    expect(api.setPreferences).toHaveBeenLastCalledWith({ agentsCanCall: false });
    seedSettings({ preferences: { ...settingsFixture().preferences, agentsCanCall: false } });
    const off = renderRN(<VoicePage />);
    expect(queryHost(off.root, byTestId('agent-call-auto-answer'))).toBeNull();
  });

  it('Pause when quiet for: Off by default, writes minutes', async () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    expect(findHost(r.root, byTestId('pause-when-quiet-0')).props.accessibilityState.selected).toBe(
      true,
    );
    await actAsync(async () => {
      findHost(r.root, byTestId('pause-when-quiet-5')).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenLastCalledWith({ pauseWhenQuietMinutes: 5 });
  });
});

describe('Voice calls: key status', () => {
  it('a hosted provider and a device’s dictation name each host with no key for it', () => {
    reportHost('hetzner', {
      hostName: 'hetzner',
      voiceKeys: { gemini: false, openai: false, deepgram: false },
    });
    reportHost('home', {
      hostName: 'laptop',
      runsManager: true,
      voiceKeys: { gemini: true, openai: false, deepgram: true },
    });
    const base = settingsFixture().preferences;
    seedSettings({
      devices: DEVICES,
      preferences: {
        ...base,
        voiceConfig: {
          ...base.voiceConfig,
          dictation: { phone: 'deepgram', computer: 'whisper', tidy: false },
        },
        voiceAgent: { ...DEFAULT_VOICE_AGENT, provider: 'openai' },
      },
    });
    const r = renderRN(
      <>
        <DictationPage />
        <VoicePage />
      </>,
    );
    expect(textOf(findHost(r.root, byTestId('dictation-phone-1-keys')))).toBe(
      'Needs a Deepgram key on hetzner.',
    );
    expect(queryHost(r.root, byTestId('dictation-mac-1-keys'))).toBeNull();
    expect(textOf(findHost(r.root, byTestId('voice-keys')))).toBe(
      'Needs an OpenAI key on laptop, hetzner.',
    );
  });

  it('clears the line live when the host reports the key has been set', async () => {
    reportHost('hetzner', {
      hostName: 'hetzner',
      voiceKeys: { gemini: false, openai: false, deepgram: false },
    });
    const base = settingsFixture().preferences;
    seedSettings({
      devices: DEVICES,
      preferences: {
        ...base,
        voiceConfig: {
          ...base.voiceConfig,
          dictation: { phone: 'whisper', computer: 'deepgram', tidy: false },
        },
      },
    });
    const r = renderRN(<DictationPage />);
    expect(queryHost(r.root, byTestId('dictation-mac-1-keys'))).not.toBeNull();
    await actAsync(() =>
      reportHost('hetzner', {
        hostName: 'hetzner',
        voiceKeys: { gemini: false, openai: false, deepgram: true },
      }),
    );
    expect(queryHost(r.root, byTestId('dictation-mac-1-keys'))).toBeNull();
  });

  it('shows usage in tokens and credits, summed across hosts, with the plan', () => {
    reportHost('home', {
      hostName: 'laptop',
      runsManager: true,
      voiceUsage: {
        monthUsd: 1,
        monthCalls: 2,
        allUsd: 2,
        allCalls: 5,
        monthTokens: 1000,
        monthCredits: 2000,
        elevenLabsPlan: { used: 41304, limit: 185575 },
      },
    });
    reportHost('hetzner', {
      hostName: 'hetzner',
      voiceUsage: { monthUsd: 0, monthCalls: 1, allUsd: 0, allCalls: 1, monthTokens: 500 },
    });
    seedSettings();
    const r = renderRN(<VoicePage />);
    expect(textOf(findHost(r.root, byTestId('voice-usage-month')))).toContain(
      '3 calls · 1,500 tokens · 2,000 ElevenLabs credits',
    );
    expect(textOf(findHost(r.root, byTestId('voice-usage-plan')))).toContain(
      '41,304 of 185,575 credits used',
    );
  });
});

describe('Manager page', () => {
  it('draws its two groups in order, with the redesign’s labels', () => {
    seedSettings();
    const r = renderRN(<ManagerPage />);
    expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe('Manager');
    const manager = findHost(r.root, byTestId('settings-manager'));
    expect(textOf(manager)).not.toContain('Enabled');
    expect(textOf(manager)).toContain('Quiet hours');
    expect(textOf(manager)).toContain('Address word');
    const threads = findHost(r.root, byTestId('settings-special-threads'));
    expect(textOf(threads)).toContain('Start a fresh session daily');
    // No host switcher: nothing here belongs to one host.
    reportHost('other', { hostName: 'mac' });
    expect(queryHost(renderRN(<ManagerPage />).root, byTestId('host-switcher'))).toBeNull();
  });

  // spec/06 § Changing home: the user chooses, and sees the handover first.
  it('Home: choosing a host shows the drafted handover; Move sends what was approved', async () => {
    reportHost('mac', { hostName: 'mac', runsManager: false });
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('manager-home')))).toBe('laptop');
    await pick(r, 'manager-home', 'mac');
    expect(api.managerHomeDraft).toHaveBeenCalledWith('mac');
    expect(api.setManagerHome).not.toHaveBeenCalled();
    expect(textOf(findHost(r.root, byTestId('manager-home-handover')))).toContain(
      'Move from laptop to mac',
    );
    const message = (): ReturnType<typeof findHost> =>
      findHost(r.root, byTestId('manager-home-message'));
    expect(message().props.value).toBe('user: hello');
    await actAsync(() => message().props.onChangeText('carry on'));
    await actAsync(async () => {
      findHost(r.root, byTestId('manager-home-move')).props.onPress();
      await flush();
    });
    expect(api.setManagerHome).toHaveBeenCalledWith('mac', 'carry on');
    expect(queryHost(r.root, byTestId('manager-home-handover'))).toBeNull();
    expect(textOf(findHost(r.root, byTestId('manager-home')))).toBe('mac');
  });

  it('Home: Cancel moves nothing, and a refused move is said', async () => {
    reportHost('mac', { hostName: 'mac', runsManager: false });
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await flush();
    await pick(r, 'manager-home', 'mac');
    await actAsync(() => findHost(r.root, byTestId('manager-home-cancel')).props.onPress());
    expect(queryHost(r.root, byTestId('manager-home-handover'))).toBeNull();
    expect(api.setManagerHome).not.toHaveBeenCalled();

    vi.mocked(api.setManagerHome).mockRejectedValue(new Error('unknown_host: no host mac'));
    await pick(r, 'manager-home', 'mac');
    await actAsync(async () => {
      findHost(r.root, byTestId('manager-home-move')).props.onPress();
      await flush();
    });
    expect(__getLastAlert()).toMatchObject({
      title: 'Move failed',
      message: 'unknown_host: no host mac',
    });
    expect(findHost(r.root, byTestId('manager-home-handover'))).toBeTruthy();
  });

  const selected = (r: ReturnType<typeof renderRN>, id: string): boolean =>
    (findHost(r.root, byTestId(id)).props.accessibilityState as { selected: boolean }).selected;

  it('Finished chats: off by default; Batched writes managerWake and offers Every', async () => {
    seedSettings();
    const r = renderRN(<ManagerPage />);
    expect(selected(r, 'manager-wake-mode-off')).toBe(true);
    expect(queryHost(r.root, byTestId('manager-wake-interval'))).toBeNull();
    await actAsync(async () => {
      findHost(r.root, byTestId('manager-wake-mode-batched')).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ managerWake: 'batched' });
    expect(selected(r, 'manager-wake-interval-30')).toBe(true);
    await actAsync(async () => {
      findHost(r.root, byTestId('manager-wake-interval-60')).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ managerWakeIntervalMinutes: 60 });
  });

  it('a failed write is reported and the choice keeps what the server holds', async () => {
    vi.mocked(api.setPreferences).mockRejectedValue(new Error('HTTP 503'));
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await actAsync(async () => {
      findHost(r.root, byTestId('manager-wake-mode-each')).props.onPress();
      await flush();
    });
    expect(__getLastAlert()).toEqual({
      title: 'Settings failed',
      message: 'HTTP 503',
      buttons: undefined,
    });
    expect(selected(r, 'manager-wake-mode-off')).toBe(true);
  });

  it('Context: This session from the server, Clear with nothing carried, and the window', async () => {
    vi.mocked(api.getChatSession).mockResolvedValue({
      session: { messages: 34, startedAt: Date.now() },
    });
    vi.mocked(api.rotateChat).mockResolvedValue({ ok: true });
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('manager-session')))).toContain('34 messages');
    await actAsync(async () => {
      findHost(r.root, byTestId('manager-clear')).props.onPress();
      await flush();
    });
    expect(api.rotateChat).toHaveBeenCalledWith('thread_manager', { carry: false });
    expect(textOf(findHost(r.root, byTestId('manager-context-window-row')))).toContain(
      'messages, keeping the last 40',
    );
  });

  it('Home → Folder: the default, Change and Save through the server', async () => {
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('manager-folder-path')))).toBe(
      '~/.patch/threads/manager',
    );
    await actAsync(() => findHost(r.root, byTestId('manager-folder-change')).props.onPress());
    await actAsync(() =>
      findHost(r.root, byTestId('manager-folder-input')).props.onChangeText(' /srv/work '),
    );
    await actAsync(async () => {
      findHost(r.root, byTestId('manager-folder-save')).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ managerFolder: '/srv/work' });
    expect(queryHost(r.root, byTestId('manager-folder-input'))).toBeNull();
    expect(textOf(findHost(r.root, byTestId('manager-folder-path')))).toBe('/srv/work');
  });

  it('Home → Folder: a refusal keeps the field open and shows why', async () => {
    vi.mocked(api.setPreferences).mockRejectedValue(
      new Error('/srv/nope is not a folder on laptop'),
    );
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await flush();
    await actAsync(() => findHost(r.root, byTestId('manager-folder-change')).props.onPress());
    await actAsync(() =>
      findHost(r.root, byTestId('manager-folder-input')).props.onChangeText('/srv/nope'),
    );
    await actAsync(async () => {
      findHost(r.root, byTestId('manager-folder-save')).props.onPress();
      await flush();
    });
    expect(textOf(findHost(r.root, byTestId('manager-folder-error')))).toContain(
      '/srv/nope is not a folder on laptop',
    );
    expect(findHost(r.root, byTestId('manager-folder-input'))).toBeDefined();
  });

  it('Finished chats shows what is waiting and when the last delivery went', async () => {
    vi.mocked(api.managerFinished).mockResolvedValue({
      waiting: 2,
      sending: 0,
      lastSent: { at: new Date().setHours(14, 30, 0, 0), chats: 1 },
    });
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('manager-finished-status')))).toBe(
      '2 waiting · last sent 14:30',
    );
  });

  it('a status the server could not give is said, not hidden', async () => {
    vi.mocked(api.managerFinished).mockRejectedValue(new Error('HTTP 502'));
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('manager-finished-status')))).toBe(
      'Could not read finished chats: HTTP 502',
    );
  });

  it('Finished chats has a title and no explainer', async () => {
    seedSettings();
    const r = renderRN(<ManagerPage />);
    expect(textOf(findHost(r.root, byTestId('manager-wake')))).not.toContain('left out');
  });

  it('Clear refused while the Manager is working shows the server’s reason', async () => {
    const message =
      'Cannot clear the Manager while it is working. Try again when the turn has finished.';
    vi.mocked(api.getChatSession).mockResolvedValue({
      session: { messages: 34, startedAt: Date.now() },
    });
    vi.mocked(api.rotateChat).mockRejectedValue(new Error(message));
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await flush();
    await actAsync(async () => {
      findHost(r.root, byTestId('manager-clear')).props.onPress();
      await flush();
    });
    expect(__getLastAlert()).toMatchObject({ title: 'Could not clear the session', message });
  });

  it('quiet hours commit a valid HH:MM on blur, and refuse anything else', async () => {
    seedSettings();
    const r = renderRN(<ManagerPage />);
    const start = (): ReturnType<typeof findHost> =>
      findHost(r.root, byTestId('manager-quiet-start'));
    expect(start().props.value).toBe('23:00');
    await actAsync(() => start().props.onChangeText('22:30'));
    await actAsync(async () => {
      start().props.onBlur();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ quietHoursStart: '22:30' });
    vi.mocked(api.setPreferences).mockClear();
    const end = (): ReturnType<typeof findHost> => findHost(r.root, byTestId('manager-quiet-end'));
    for (const bad of ['25:00', '7:30', '07:60', 'noon']) {
      __clearLastAlert();
      await actAsync(() => end().props.onChangeText(bad));
      await actAsync(() => end().props.onBlur());
      expect(__getLastAlert()).toEqual({
        title: 'Invalid time',
        message: 'Quiet hours end must be a 24-hour time like 07:30.',
        buttons: undefined,
      });
      expect(end().props.value).toBe('07:00');
    }
    // An unchanged value is not re-sent.
    await actAsync(() => end().props.onBlur());
    expect(api.setPreferences).not.toHaveBeenCalled();
  });

  it('address word saves a new word, and an emptied field returns to the saved one', async () => {
    seedSettings();
    const r = renderRN(<ManagerPage />);
    const field = (): ReturnType<typeof findHost> =>
      findHost(r.root, byTestId('manager-address-word'));
    await actAsync(() => field().props.onChangeText('  '));
    await actAsync(() => field().props.onBlur());
    expect(api.setPreferences).not.toHaveBeenCalled();
    expect(field().props.value).toBe('patch');
    await actAsync(() => field().props.onChangeText(' otto '));
    await actAsync(async () => {
      field().props.onBlur();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ addressWord: 'otto' });
  });

  it('offers the special threads’ model from the default host’s catalogue', async () => {
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await flush();
    expect(api.models).toHaveBeenCalledWith('home');
    expect(textOf(findHost(r.root, byTestId('special-thread-model')))).toBe('Sonnet 5');
    await pick(r, 'special-thread-model', 'claude-opus-5');
    expect(api.setPreferences).toHaveBeenCalledWith({ specialThreadModel: 'claude-opus-5' });
    expect(textOf(findHost(r.root, byTestId('special-thread-model')))).toBe('Opus 5');
  });

  it('special threads’ model: no attached host, and a catalogue failure, are each said', async () => {
    resetHosts();
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await flush();
    expect(api.models).not.toHaveBeenCalled();
    expect(findHost(r.root, byTestId('special-thread-model-no-host'))).toBeTruthy();
    r.unmount();
    reportHost('a', { runsManager: true });
    usePresenceStore.getState().setHostOnline('b', false);
    vi.mocked(api.models).mockRejectedValue(new Error('host offline'));
    const r2 = renderRN(<ManagerPage />);
    await flush();
    expect(textOf(findHost(r2.root, byTestId('special-thread-model-error')))).toBe(
      'Couldn’t load the model list: host offline',
    );
  });

  it('Experimental features is off by default and its switch writes the account setting', async () => {
    seedSettings({ preferences: { ...DEFAULT_SHARED_SETTINGS } });
    const r = renderRN(<ExperimentalPage />);
    const toggle = findHost(r.root, byTestId('experimental-features'));
    expect(toggle.props.value).toBe(false);
    await actAsync(async () => {
      toggle.props.onValueChange(true);
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ experimentalFeatures: true });
  });

  it('rotation switch and time write through; an invalid time is refused', async () => {
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await actAsync(async () => {
      findHost(r.root, byTestId('rotation-enabled')).props.onValueChange(false);
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ rotationEnabled: false });
    await actAsync(() => findHost(r.root, byTestId('rotation-time')).props.onChangeText('03:15'));
    await actAsync(async () => {
      findHost(r.root, byTestId('rotation-time')).props.onBlur();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ rotationTime: '03:15' });
    vi.mocked(api.setPreferences).mockClear();
    await actAsync(() => findHost(r.root, byTestId('rotation-time')).props.onChangeText('3pm'));
    await actAsync(() => findHost(r.root, byTestId('rotation-time')).props.onBlur());
    expect(api.setPreferences).not.toHaveBeenCalled();
    expect(__getLastAlert()?.message).toBe('Fresh session at must be a 24-hour time like 07:30.');
    expect(findHost(r.root, byTestId('rotation-time')).props.value).toBe('03:15');
  });

  it('writePreferences reports a failure by name', async () => {
    seedSettings();
    vi.mocked(api.setPreferences).mockRejectedValue(new Error('HTTP 401'));
    writePreferences({ reach: 'notify' });
    await flush();
    expect(__getLastAlert()).toEqual({
      title: 'Settings failed',
      message: 'HTTP 401',
      buttons: undefined,
    });
  });
});

describe('Voice devices answering directly (speech on the host)', () => {
  it('a Kokoro voice writes the shared setting, and there is no chat title setting', async () => {
    seedSettings({
      preferences: { ...settingsFixture().preferences, kokoroVoice: 'af_heart' },
    });
    const r = renderRN(<VoicePage />);
    expect(textOf(findHost(r.root, byTestId('kokoro-voice')))).toBe(KOKORO_VOICES[0]!.label);
    await pick(r, 'kokoro-voice', 'bm_george');
    expect(api.setPreferences).toHaveBeenLastCalledWith({ kokoroVoice: 'bm_george' });
    expect(queryHost(r.root, byTestId('chat-name-interval'))).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('says each host uses its own default until a voice is chosen', () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    expect(textOf(findHost(r.root, byTestId('voice-settings')))).toContain(
      'Each host’s Kokoro default',
    );
  });

  it('draws the controls with no host at all — they are the server’s', () => {
    resetHosts();
    seedSettings();
    const r = renderRN(<VoicePage />);
    expect(findHost(r.root, byTestId('kokoro-voice'))).toBeTruthy();
  });
});

describe('Dictation page: when to send (shared)', () => {
  it('shows the current pause and writes the chosen one', async () => {
    seedSettings();
    const r = renderRN(<DictationPage />);
    expect(findHost(r.root, byTestId('dictation-pause-10')).props.accessibilityState).toMatchObject(
      {
        selected: true,
      },
    );
    await actAsync(async () => {
      findHost(r.root, byTestId('dictation-pause-5')).props.onPress();
    });
    expect(api.setPreferences).toHaveBeenLastCalledWith({ dictationPauseSeconds: 5 });
  });

  it('turn detection is on by default and can be turned off', async () => {
    seedSettings();
    const r = renderRN(<DictationPage />);
    const section = findHost(r.root, byTestId('settings-voice-dictation'));
    expect(textOf(section)).toContain('Send anyway after a pause of');
    const toggle = findHost(r.root, byTestId('dictation-turn-detection'));
    expect(toggle.props.value).toBe(true);
    await actAsync(async () => {
      toggle.props.onValueChange(false);
    });
    expect(api.setPreferences).toHaveBeenLastCalledWith({ dictationTurnDetection: false });
  });
});

describe('Dictation page: one engine per device', () => {
  it('lists every device at once, each with only the engines it can run', () => {
    seedSettings({ devices: DEVICES });
    const r = renderRN(<DictationPage />);
    expect(textOf(findHost(r.root, byTestId('dictation-device-phone-1')))).toMatch(
      /Pixel.*This device.*Built-in/,
    );
    expect(
      findHost(r.root, byTestId('dictation-device-phone-1-device')).props.accessibilityState
        .selected,
    ).toBe(true);
    // Parakeet only in the desktop app; the phone recogniser only on a phone.
    expect(findHost(r.root, byTestId('dictation-device-mac-1-local'))).toBeTruthy();
    expect(queryHost(r.root, byTestId('dictation-device-web-1-local'))).toBeNull();
    expect(queryHost(r.root, byTestId('dictation-device-mac-1-device'))).toBeNull();
  });

  it('a change writes that device’s own engine', async () => {
    seedSettings({ devices: DEVICES });
    const r = renderRN(<DictationPage />);
    await actAsync(async () => {
      findHost(r.root, byTestId('dictation-device-mac-1-local')).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenLastCalledWith({
      deviceDictation: { 'mac-1': 'local' },
    });
  });

  it('speech to text: the account picks the engine and the tidy-up row names it', async () => {
    seedSettings();
    const r = renderRN(<DictationPage />);
    expect(textOf(findHost(r.root, byTestId('stt-row')))).toMatch(
      /Speech to text.*Groq Whisper.*Whisper on host.*Parakeet on host.*ElevenLabs Scribe/,
    );
    await actAsync(async () => {
      findHost(r.root, byTestId('stt-engine-elevenlabs')).props.onPress();
    });
    expect(api.setPreferences).toHaveBeenLastCalledWith({
      voiceConfig: expect.objectContaining({ speechToText: 'elevenlabs' }),
    });
  });

  it('tidy-up is one switch for every device', async () => {
    seedSettings();
    const r = renderRN(<DictationPage />);
    const tidy = findHost(r.root, byTestId('dictation-tidy'));
    expect(tidy.props.value).toBe(false);
    await actAsync(async () => {
      tidy.props.onValueChange(true);
    });
    expect(api.setPreferences).toHaveBeenLastCalledWith({
      voiceConfig: expect.objectContaining({
        dictation: { phone: 'device', computer: 'whisper', tidy: true },
      }),
    });
  });
});

describe('Voice page: frame', () => {
  it('draws the conversation config, usage and voice devices — no Speaking, no Dictation', () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe('Voice');
    expect(findHost(r.root, byTestId('settings-voice-agent'))).toBeTruthy();
    expect(findHost(r.root, byTestId('settings-agents-calling'))).toBeTruthy();
    expect(findHost(r.root, byTestId('settings-calls'))).toBeTruthy();
    expect(queryHost(r.root, byTestId('settings-voice-speaking'))).toBeNull();
    expect(findHost(r.root, byTestId('settings-voice-devices'))).toBeTruthy();
    expect(queryHost(r.root, byTestId('settings-voice-dictation'))).toBeNull();
    expect(queryHost(r.root, byTestId('settings-voice-meeting'))).toBeNull();
  });

  it('Dictation is its own page: engines and when to send; Meetings has its own', () => {
    seedSettings();
    const r = renderRN(<DictationPage />);
    expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe('Dictation');
    expect(findHost(r.root, byTestId('settings-voice-dictation-engines'))).toBeTruthy();
    expect(findHost(r.root, byTestId('settings-voice-dictation'))).toBeTruthy();
    expect(queryHost(r.root, byTestId('settings-voice-meeting'))).toBeNull();
    const m = renderRN(<MeetingsPage />);
    expect(textOf(findHost(m.root, byTestId('settings-page-title')))).toBe('Meetings');
    expect(findHost(m.root, byTestId('meeting-engine'))).toBeTruthy();
  });

  it('lists voice devices once settings have loaded', () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    expect(findHost(r.root, byTestId('settings-voice-devices'))).toBeTruthy();
  });

  it('the voice agent waits for settings to load', () => {
    const r = renderRN(<VoicePage />);
    expect(findHost(r.root, byTestId('voice-agent-loading'))).toBeTruthy();
    expect(queryHost(r.root, byTestId('voice-dictation-backend-local'))).toBeNull();
  });
});
