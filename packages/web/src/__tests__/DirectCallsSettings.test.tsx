// Settings → Voice calls → Direct calls (spec/07 § Direct calls, spec/14 §
// Voice): one setup for every device, On device or a cloud engine at each
// step, checked against the device Settings is open on.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import type { SpeechEngineReport } from '@patch/wire/direct-call';
import { usePresenceStore } from '../stores/presenceStore.js';
import { reportHost } from './presenceHelpers.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import {
  makeFetch,
  preferencesServer,
  renderSettings,
  resetSettingsState,
} from './settingsHarness.js';

const MAC: SpeechEngineReport = {
  stt: [
    { engine: 'parakeet', where: 'device', models: ['parakeet-tdt-0.6b-v3'] },
    { engine: 'groq', where: 'cloud', models: ['whisper-large-v3-turbo'] },
  ],
  tts: [
    {
      engine: 'kokoro',
      where: 'device',
      models: ['kokoro-82m'],
      voices: ['af_heart', 'bm_george'],
    },
    { engine: 'elevenlabs', where: 'cloud', models: ['eleven_flash_v2_5'], voices: ['v-rachel'] },
  ],
};

const DEVICES = [
  {
    surfaceId: 'mac-1',
    surfaceKind: 'desktop',
    label: 'MacBook Pro',
    issuedAt: 1,
    status: 'online',
    lastHeartbeat: 1,
    isCurrent: true,
    speechEngines: MAC,
  },
  {
    surfaceId: 'linux-1',
    surfaceKind: 'web',
    label: 'Linux laptop',
    issuedAt: 2,
    status: 'offline',
    lastHeartbeat: Date.now() - 3_600_000,
    isCurrent: false,
    speechEngines: { stt: [], tts: [] },
  },
  {
    surfaceId: 'mac-2',
    surfaceKind: 'desktop',
    label: 'Work Mac',
    issuedAt: 4,
    status: 'online',
    lastHeartbeat: 1,
    isCurrent: false,
    speechEngines: MAC,
  },
  {
    surfaceId: 'web-2',
    surfaceKind: 'web',
    label: 'Browser',
    issuedAt: 5,
    status: 'online',
    lastHeartbeat: 1,
    isCurrent: false,
    speechEngines: { stt: [MAC.stt[1]], tts: [MAC.tts[1]] },
  },
  {
    surfaceId: 'old-1',
    surfaceKind: 'web',
    label: 'Old browser',
    issuedAt: 3,
    status: 'offline',
    lastHeartbeat: null,
    isCurrent: false,
  },
];

const CLOUD = {
  stt: { engine: 'groq' as const, model: 'whisper-large-v3-turbo' },
  tts: { engine: 'elevenlabs' as const, model: 'eleven_flash_v2_5', voice: 'v-rachel' },
};

/** `current`: the device Settings is open on. */
function setup(saved?: unknown, current = 'mac-1') {
  usePreferencesStore.setState((st) => ({
    preferences: { ...st.preferences, directCall: saved as never },
  }));
  const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
  const devices = DEVICES.map((d) => ({ ...d, isCurrent: d.surfaceId === current }));
  vi.stubGlobal('fetch', makeFetch({ devices }, server.handler));
  return server;
}

beforeEach(() => {
  resetSettingsState();
  usePresenceStore.getState().setHostOnline('d1', true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Direct calls', () => {
  it('one setup, nothing chosen until picked: On device or each cloud engine with a key', async () => {
    setup();
    renderSettings('/settings/voice');
    const stt = await screen.findByTestId('direct-stt');
    expect(
      within(stt)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['On device', 'Groq Whisper']);
    expect(screen.getByTestId('direct-stt-device')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('direct-tts')).toBeNull();
    // No list of devices: the setting is the account's.
    expect(screen.queryByTestId('direct-mac-2-row')).toBeNull();
  });

  it('On device needs no model or voice; this device says what it runs', async () => {
    setup({ stt: { engine: 'device' }, tts: { engine: 'device' } });
    renderSettings('/settings/voice');
    expect(await screen.findByTestId('direct-summary')).toHaveTextContent('Parakeet → Kokoro');
    expect(screen.queryByTestId('direct-stt-model')).toBeNull();
    expect(screen.queryByTestId('direct-voice')).toBeNull();
  });

  it('each pick is written to the one setup', async () => {
    const server = setup();
    renderSettings('/settings/voice');
    fireEvent.click(await screen.findByTestId('direct-stt-device'));
    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(server.writes[0]).toEqual({ directCall: { stt: { engine: 'device' } } });
  });

  it('a cloud engine: its model, voice and sound — ElevenLabs shows tone, stability, similarity, style and speed', async () => {
    setup(CLOUD);
    renderSettings('/settings/voice');
    expect(await screen.findByTestId('direct-summary')).toHaveTextContent(
      'Groq Whisper → ElevenLabs',
    );
    expect((screen.getByTestId('direct-voice') as HTMLSelectElement).value).toBe('v-rachel');
    for (const c of ['tone', 'stability', 'similarity', 'style', 'speed']) {
      expect(screen.getByTestId(`direct-${c}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('direct-stability-value')).toHaveTextContent('0.7');
  });

  it('a setup this device cannot run says why', async () => {
    setup({ stt: { engine: 'device' }, tts: { engine: 'device' } }, 'web-2');
    renderSettings('/settings/voice');
    expect(await screen.findByTestId('direct-problem')).toHaveTextContent(
      /this device has no speech to text of its own/,
    );
  });

  it('a cloud engine’s models are the provider’s list: a failed read says why, with Refresh', async () => {
    setup({ stt: { engine: 'groq', model: 'whisper-large-v3-turbo' } });
    reportHost('d1', {
      hostName: 'box',
      voiceKeys: { gemini: false, openai: false, groq: true },
      voiceCatalog: { groq: { error: 'Groq model list failed: HTTP 401', at: 1 } },
    });
    renderSettings('/settings/voice');
    expect(await screen.findByTestId('direct-stt-model-status')).toHaveTextContent(
      "Could not read Groq's models: box: Groq model list failed: HTTP 401",
    );
    expect(screen.getByTestId('direct-stt-model-refresh')).toBeInTheDocument();
  });

  it('a device that never reported says so instead of offering anything', async () => {
    setup(undefined, 'old-1');
    renderSettings('/settings/voice');
    expect(await screen.findByTestId('direct-unreported')).toHaveTextContent(
      'This device has not reported its speech engines yet.',
    );
  });
});
