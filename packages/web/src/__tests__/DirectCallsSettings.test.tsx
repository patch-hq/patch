// Settings → Voice calls → Direct calls (spec/07 § Direct calls, spec/14 §
// Voice): every linked device with its setup in one line, opening to its
// steps, offering only the engines it reported.

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

const MAC_SETUP = {
  stt: { engine: 'parakeet' as const, model: 'parakeet-tdt-0.6b-v3' },
  tts: { engine: 'kokoro' as const, model: 'kokoro-82m', voice: 'af_heart' },
};

function setup(saved: Record<string, unknown> = { 'mac-1': MAC_SETUP }) {
  usePreferencesStore.setState((st) => ({
    preferences: { ...st.preferences, deviceDirectCall: saved as never },
  }));
  const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
  vi.stubGlobal('fetch', makeFetch({ devices: DEVICES }, server.handler));
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
  it('lists every linked device with its setup in one line, No speech engine, or not reported', async () => {
    setup();
    renderSettings('/settings/voice');
    expect(await screen.findByTestId('direct-mac-1-summary')).toHaveTextContent(
      'Parakeet → Kokoro',
    );
    expect(screen.getByTestId('direct-mac-1-row')).toHaveTextContent('Desktop app · this device');
    expect(screen.getByTestId('direct-linux-1-summary')).toHaveTextContent('No speech engine');
    expect(screen.getByTestId('direct-linux-1-row')).toHaveTextContent('seen 1h ago');
    expect(screen.getByTestId('direct-old-1-summary')).toHaveTextContent('Not reported yet');
    // Nothing saved: it runs on its own engines, so there is nothing to set up.
    expect(screen.getByTestId('direct-mac-2-summary')).toHaveTextContent('Parakeet → Kokoro');
    // Only cloud engines and nothing picked: that is left to the user.
    expect(screen.getByTestId('direct-web-2-summary')).toHaveTextContent('Set up');
  });

  it('opens to its steps, offering only what the device reported, labelled On device / Cloud', async () => {
    setup();
    renderSettings('/settings/voice');
    fireEvent.click(within(await screen.findByTestId('direct-mac-1-row')).getByRole('button'));
    const stt = screen.getByTestId('direct-mac-1-stt');
    expect(
      within(stt)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Parakeet · On device', 'Groq Whisper · Cloud']);
    expect(screen.getByTestId('direct-mac-1-stt-parakeet')).toHaveAttribute('aria-pressed', 'true');
    expect((screen.getByTestId('direct-mac-1-stt-model') as HTMLSelectElement).value).toBe(
      'parakeet-tdt-0.6b-v3',
    );
    expect(screen.getByTestId('direct-mac-1-tts-kokoro')).toHaveAttribute('aria-pressed', 'true');
    expect((screen.getByTestId('direct-mac-1-voice') as HTMLSelectElement).value).toBe('af_heart');
    // Kokoro's only control is speed.
    expect(screen.getByTestId('direct-mac-1-sound')).toHaveTextContent('How it sounds');
    expect(screen.getByTestId('direct-mac-1-speed-value')).toHaveTextContent('1×');
    expect(screen.queryByTestId('direct-mac-1-tone')).toBeNull();
  });

  it('a device with nothing saved shows its own engines as chosen, and a pick is written', async () => {
    const server = setup();
    renderSettings('/settings/voice');
    fireEvent.click(within(await screen.findByTestId('direct-mac-2-row')).getByRole('button'));
    expect(screen.getByTestId('direct-mac-2-stt-parakeet')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('direct-mac-2-tts-kokoro')).toHaveAttribute('aria-pressed', 'true');
    expect((screen.getByTestId('direct-mac-2-voice') as HTMLSelectElement).value).toBe('af_heart');
    fireEvent.click(screen.getByTestId('direct-mac-2-stt-groq'));
    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(server.writes[0]).toEqual({
      deviceDirectCall: { 'mac-1': MAC_SETUP, 'mac-2': { stt: { engine: 'groq' } } },
    });
  });

  it('this device’s row is open on arrival when it still has a step to pick', async () => {
    setup();
    usePresenceStore.setState({ surfaceId: 'web-2' });
    renderSettings('/settings/voice');
    expect(await screen.findByTestId('direct-web-2-stt-groq')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('a new text to speech engine starts its own steps over', async () => {
    const server = setup();
    renderSettings('/settings/voice');
    fireEvent.click(within(await screen.findByTestId('direct-mac-1-row')).getByRole('button'));
    fireEvent.click(screen.getByTestId('direct-mac-1-tts-elevenlabs'));
    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(server.writes[0]).toEqual({
      deviceDirectCall: { 'mac-1': { stt: MAC_SETUP.stt, tts: { engine: 'elevenlabs' } } },
    });
  });

  it('ElevenLabs shows tone, stability, similarity, style and speed', async () => {
    setup({
      'mac-1': {
        stt: { engine: 'groq', model: 'whisper-large-v3-turbo' },
        tts: { engine: 'elevenlabs', model: 'eleven_flash_v2_5', voice: 'v-rachel' },
      },
    });
    renderSettings('/settings/voice');
    expect(await screen.findByTestId('direct-mac-1-summary')).toHaveTextContent(
      'Groq Whisper → ElevenLabs',
    );
    fireEvent.click(within(screen.getByTestId('direct-mac-1-row')).getByRole('button'));
    for (const c of ['tone', 'stability', 'similarity', 'style', 'speed']) {
      expect(screen.getByTestId(`direct-mac-1-${c}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('direct-mac-1-stability-value')).toHaveTextContent('0.7');
  });

  it('a cloud engine’s models are the provider’s list: a failed read says why, with Refresh', async () => {
    setup({ 'mac-2': { stt: { engine: 'groq', model: 'whisper-large-v3-turbo' } } });
    reportHost('d1', {
      hostName: 'box',
      voiceKeys: { gemini: false, openai: false, groq: true },
      voiceCatalog: { groq: { error: 'Groq model list failed: HTTP 401', at: 1 } },
    });
    renderSettings('/settings/voice');
    fireEvent.click(within(await screen.findByTestId('direct-mac-2-row')).getByRole('button'));
    expect(screen.getByTestId('direct-mac-2-stt-model-status')).toHaveTextContent(
      "Could not read Groq's models: box: Groq model list failed: HTTP 401",
    );
    expect(screen.getByTestId('direct-mac-2-stt-model-refresh')).toBeInTheDocument();
  });

  it('a device that never reported says so instead of offering anything', async () => {
    setup();
    renderSettings('/settings/voice');
    fireEvent.click(within(await screen.findByTestId('direct-old-1-row')).getByRole('button'));
    expect(screen.getByTestId('direct-old-1-unreported')).toHaveTextContent(
      'This device has not reported its speech engines yet.',
    );
  });
});
