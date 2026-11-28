// spec/07 § Readiness — a voice feature is checked when the user engages with
// it, and a gap is an invitation with a one-step fix, never an error.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_VOICE_AGENT, DEFAULT_VOICE_CONFIG, type VoiceConfig } from '@patch/wire/audio';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __clearAllMmkv } from './stubs/mmkv';
import { reportHost, resetHosts } from './testUtils/settingsFixtures';
import type { SettingsResponse } from '../src/api/rest';

const push = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async (orig) => ({
  ...(await orig<typeof import('expo-router')>()),
  router: { push },
}));

import { voiceGap, ensureVoiceReady, ensureDictationReady } from '../src/lib/voiceReadiness';

function seed(voiceConfig: VoiceConfig): void {
  useSettingsStore.setState({
    data: {
      devices: [],
      preferences: {
        addressWord: 'patch',
        voiceConfig,
        voiceAgent: DEFAULT_VOICE_AGENT,
        experimentalFeatures: true,
      },
    } as unknown as SettingsResponse,
    error: null,
  });
}

beforeEach(() => {
  __clearAllMmkv();
  useUiStore.setState({ errors: [] });
  resetHosts();
  usePresenceStore.setState({ daemon: 'online' });
  push.mockReset();
});

describe('voice readiness on the phone', () => {
  it('Auto-notify with no speech voice on the host is an invitation that opens the fix', () => {
    reportHost('mac', {
      hostName: 'the Mac',
      voiceLocal: { whisper: true, parakeet: true, kokoro: false },
    });
    seed(DEFAULT_VOICE_CONFIG);
    expect(ensureVoiceReady({ feature: 'spoken-alert' })).toBe(false);
    const [toast] = useUiStore.getState().errors;
    expect(toast?.message).toBe('Spoken alerts need a speech voice on the Mac.');
    expect(toast?.invitation?.action?.label).toBe('Set up');
    toast?.invitation?.action?.run();
    expect(push).toHaveBeenCalledWith('/settings/hosts');
  });

  it('a spoken alert needs no speech to text', () => {
    reportHost('mac', {
      voiceKeys: { gemini: true, openai: true, groq: false },
      voiceLocal: { whisper: false, parakeet: false, kokoro: true },
    });
    seed(DEFAULT_VOICE_CONFIG);
    expect(voiceGap({ feature: 'spoken-alert' })).toBeNull();
  });

  it('a call with a missing provider key is refused before dialling, with the same sentence as the host', () => {
    reportHost('mac', {
      hostName: 'the Mac',
      voiceKeys: { gemini: false, openai: false, groq: true },
    });
    seed(DEFAULT_VOICE_CONFIG);
    useChatStore.setState((s) => ({
      chats: { ...s.chats, c1: { ...(s.chats['c1'] ?? {}), hostId: 'mac' } as never },
    }));
    expect(ensureVoiceReady({ feature: 'call', surface: 'call' }, 'mac')).toBe(false);
    expect(useUiStore.getState().errors[0]?.message).toMatch(
      /^Calls need an? (Gemini|OpenAI) key on the Mac\.$/,
    );
  });

  it('dictation on Deepgram without its key invites setup at the press', () => {
    reportHost('mac', {
      hostName: 'the Mac',
      voiceKeys: { gemini: true, openai: true, groq: true, deepgram: false },
    });
    seed({
      ...DEFAULT_VOICE_CONFIG,
      dictation: { phone: 'deepgram', computer: 'whisper', tidy: false },
    });
    useChatStore.setState((s) => ({
      chats: { ...s.chats, c1: { ...(s.chats['c1'] ?? {}), hostId: 'mac' } as never },
    }));
    expect(ensureDictationReady('c1')).toBe(false);
    expect(useUiStore.getState().errors[0]?.message).toBe(
      'Dictation needs a Deepgram key on the Mac.',
    );
  });

  it('nothing known yet is not a gap', () => {
    expect(voiceGap({ feature: 'spoken-alert' })).toBeNull();
  });
});
