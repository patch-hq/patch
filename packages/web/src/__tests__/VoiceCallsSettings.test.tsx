// Settings → Voice calls (spec/14 § Voice, spec/07 § The voice agent): the
// voice agent revealed one choice at a time, its sound drawn from the engine
// description, the lists read by a host, Agents calling you and Calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import type { WireEvent } from '@patch/wire';
import type { VoiceCatalog } from '@patch/wire/audio';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { setActiveWs, type PatchWs } from '../api/ws.js';
import { reportHost } from './presenceHelpers.js';
import {
  makeFetch,
  preferencesServer,
  renderSettings,
  resetSettingsState,
} from './settingsHarness.js';

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
    speechModels: [
      { id: 'eleven_v3_conversational', label: 'Eleven v3 conversational' },
      { id: 'eleven_flash_v2_5', label: 'Flash v2.5' },
    ],
  },
};

function fakeWs(): WireEvent[] {
  const sent: WireEvent[] = [];
  const push = (e: WireEvent): number => sent.push(e);
  setActiveWs({ send: push, safeSend: push } as unknown as PatchWs);
  usePresenceStore.setState({ connection: 'connected' });
  return sent;
}

function setup() {
  const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
  vi.stubGlobal('fetch', makeFetch({}, server.handler));
  return server;
}

const agentWrite = (w: Record<string, unknown>) =>
  w.voiceAgent as { provider: string; setups: Record<string, Record<string, unknown>> };

beforeEach(() => {
  resetSettingsState();
  usePresenceStore.getState().setHostOnline('d1', true);
  reportHost('d1', {
    hostName: 'hetzner',
    voiceKeys: { gemini: true, openai: false, elevenlabs: true },
    voiceCatalog: CATALOG,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setActiveWs(null);
});

describe('Voice agent', () => {
  it('provider writes only the provider; the old Local choice is gone', async () => {
    const server = setup();
    renderSettings('/settings/voice');
    const pills = await screen.findByTestId('voice-agent-provider');
    expect(
      within(pills)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Gemini', 'OpenAI', 'ElevenLabs']);
    fireEvent.click(screen.getByTestId('voice-agent-provider-elevenlabs'));
    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(agentWrite(server.writes[0]!).provider).toBe('elevenlabs');
    expect(server.writes[0]!.voiceConfig).toBeUndefined();
  });

  it('lists the models a host read, with the count, and reveals Voice then How it sounds', async () => {
    const server = setup();
    renderSettings('/settings/voice');
    expect(await screen.findByTestId('voice-agent-model-status')).toHaveTextContent('2 models');
    // The default setup has a model but no Gemini voice: Voice shows, How it sounds does not.
    expect(screen.getByTestId('voice-agent-voice')).toBeInTheDocument();
    expect(screen.queryByTestId('voice-agent-sound')).toBeNull();
    fireEvent.change(screen.getByTestId('voice-agent-voice'), { target: { value: 'Kore' } });
    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(agentWrite(server.writes[0]!).setups.gemini!.voice).toBe('Kore');
    expect(await screen.findByTestId('voice-agent-sound')).toHaveTextContent('How it sounds');
    expect(screen.getByTestId('voice-agent-tone')).toBeInTheDocument();
    expect(screen.getByTestId('voice-agent-matchTone')).toBeInTheDocument();
    // Only Gemini's own controls.
    expect(screen.queryByTestId('voice-agent-stability')).toBeNull();
    expect(screen.queryByTestId('voice-agent-speed')).toBeNull();
  });

  it('a stored model the provider no longer lists is shown as such, not swapped', async () => {
    setup();
    usePreferencesStore.setState((s) => ({
      preferences: {
        ...s.preferences,
        voiceAgent: {
          provider: 'gemini',
          setups: {
            ...s.preferences.voiceAgent.setups,
            gemini: { model: 'models/gone', sound: {} },
          },
        },
      },
    }));
    renderSettings('/settings/voice');
    const select = (await screen.findByTestId('voice-agent-model')) as HTMLSelectElement;
    expect(select.value).toBe('models/gone');
    expect(select).toHaveTextContent('models/gone (no longer offered)');
  });

  it('ElevenLabs shows its own controls in order, with the calm defaults', async () => {
    setup();
    usePreferencesStore.setState((s) => ({
      preferences: {
        ...s.preferences,
        voiceAgent: {
          provider: 'elevenlabs',
          setups: {
            ...s.preferences.voiceAgent.setups,
            elevenlabs: { model: 'claude-haiku-4-5', voice: 'v-rachel', sound: {} },
          },
        },
      },
    }));
    renderSettings('/settings/voice');
    await screen.findByTestId('voice-agent-sound');
    const group = screen.getByTestId('settings-voice-agent');
    const titles = [...group.querySelectorAll('.set-row-title')].map((t) => t.textContent);
    expect(titles).toEqual([
      'Provider',
      'Model',
      'Voice',
      'Speech model',
      'Tone',
      'Expressive mode',
      'Stability',
      'Similarity',
      'Speed',
      'Reply eagerness',
      'Voice instructions',
    ]);
    expect(screen.getByTestId('voice-agent-stability-value')).toHaveTextContent('0.7');
    expect(screen.getByTestId('voice-agent-speed-value')).toHaveTextContent('0.95×');
    expect(screen.getByTestId('voice-agent-stability-row')).toHaveTextContent('Expressive');
    expect(screen.getByTestId('voice-agent-stability-row')).toHaveTextContent('Steady');
    expect(screen.getByTestId('voice-agent-eagerness-patient')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const speech = screen.getByTestId('voice-agent-speechModel') as HTMLSelectElement;
    expect([...speech.options].map((o) => o.textContent)).toEqual([
      'ElevenLabs default',
      'Eleven v3 conversational',
      'Flash v2.5',
    ]);
  });

  it('a sound control writes into the provider setup', async () => {
    const server = setup();
    usePreferencesStore.setState((s) => ({
      preferences: {
        ...s.preferences,
        voiceAgent: {
          provider: 'elevenlabs',
          setups: {
            ...s.preferences.voiceAgent.setups,
            elevenlabs: { model: 'claude-haiku-4-5', voice: 'v-rachel', sound: {} },
          },
        },
      },
    }));
    renderSettings('/settings/voice');
    fireEvent.click(await screen.findByTestId('voice-agent-eagerness-eager'));
    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect(agentWrite(server.writes[0]!).setups.elevenlabs!.sound).toEqual({ eagerness: 'eager' });
  });

  it('tone is kept per voice and saved when the box loses focus', async () => {
    const server = setup();
    usePreferencesStore.setState((s) => ({
      preferences: {
        ...s.preferences,
        voiceAgent: {
          provider: 'gemini',
          setups: {
            ...s.preferences.voiceAgent.setups,
            gemini: { model: 'models/gemini-3.8-live', voice: 'Kore', sound: {} },
          },
        },
      },
    }));
    renderSettings('/settings/voice');
    const tone = await screen.findByTestId('voice-agent-tone');
    fireEvent.change(tone, { target: { value: 'Calm and sincere. [slow] when explaining.' } });
    expect(server.writes).toHaveLength(0);
    fireEvent.blur(tone);
    await waitFor(() =>
      expect(server.writes).toContainEqual({
        voiceTones: { 'gemini:Kore': 'Calm and sincere. [slow] when explaining.' },
      }),
    );
  });

  it('Refresh asks every online host with the key to read the lists again', async () => {
    setup();
    const sent = fakeWs();
    renderSettings('/settings/voice');
    fireEvent.click(await screen.findByTestId('voice-agent-model-refresh'));
    expect(sent).toContainEqual({
      type: 'host.voice_catalog_refresh',
      hostId: 'd1',
      provider: 'gemini',
    });
  });

  it('says why there is no list: a failed read, or no key anywhere', async () => {
    setup();
    reportHost('d1', {
      hostName: 'hetzner',
      voiceKeys: { gemini: true, openai: false },
      voiceCatalog: { gemini: { at: 1, error: 'Gemini model list failed: HTTP 403' } },
    });
    renderSettings('/settings/voice');
    expect(await screen.findByTestId('voice-agent-model-status')).toHaveTextContent(
      "Could not read Gemini's models: hetzner: Gemini model list failed: HTTP 403",
    );
    fireEvent.click(screen.getByTestId('voice-agent-provider-openai'));
    // The write is not applied by the harness; switch the store to see OpenAI's state.
    usePreferencesStore.setState((s) => ({
      preferences: {
        ...s.preferences,
        voiceAgent: { ...s.preferences.voiceAgent, provider: 'openai' },
      },
    }));
    await waitFor(() =>
      expect(screen.getByTestId('voice-agent-model-status')).toHaveTextContent(
        'Add an API key for OpenAI in Settings → Providers',
      ),
    );
    expect(screen.queryByTestId('voice-agent-model-refresh')).toBeNull();
  });
});

describe('Agents calling you and Calls', () => {
  it('Answer automatically is offered only while agents can call', async () => {
    const server = setup();
    renderSettings('/settings/voice');
    expect(await screen.findByTestId('agent-call-auto-answer-row')).toHaveTextContent(
      'Pauses playback while the agent talks',
    );
    fireEvent.click(screen.getByTestId('agents-can-call'));
    await waitFor(() => expect(server.writes).toContainEqual({ agentsCanCall: false }));
    usePreferencesStore.setState((s) => ({
      preferences: { ...s.preferences, agentsCanCall: false },
    }));
    await waitFor(() => expect(screen.queryByTestId('agent-call-auto-answer-row')).toBeNull());
  });

  it('Pause when quiet for: Off by default, and writes the minutes', async () => {
    const server = setup();
    renderSettings('/settings/voice');
    const pills = await screen.findByTestId('pause-when-quiet');
    expect(
      within(pills)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Off', '2 min', '5 min', '10 min', '30 min']);
    expect(screen.getByTestId('pause-when-quiet-0')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('pause-when-quiet-10'));
    await waitFor(() => expect(server.writes).toContainEqual({ pauseWhenQuietMinutes: 10 }));
  });
});

describe('Voice devices answer with', () => {
  it('Direct shows the host speech rows; Voice agent hands the device to the voice agent', async () => {
    const server = setup();
    renderSettings('/settings/voice');
    expect(await screen.findByTestId('voice-device-answer-direct')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('kokoro-voice')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('voice-device-answer-agent'));
    await waitFor(() => expect(server.writes).toHaveLength(1));
    expect((server.writes[0]!.voiceConfig as { deviceAnswer: string }).deviceAnswer).toBe('agent');
  });
});
