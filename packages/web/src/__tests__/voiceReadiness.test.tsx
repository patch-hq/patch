// spec/07 § Readiness — a voice feature is checked when the user engages with
// it. A gap is an invitation with a one-step fix, never a red failure.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ReachSwitch } from '../components/ReachSwitch.js';
import { startVoiceCall, __setAudioOpenerForTests } from '../lib/voiceController.js';
import { __setSpeakOpenerForTests, speakInterrupt } from '../lib/speakInterrupt.js';
import { setAppNavigate } from '../lib/appNavigate.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { clearHosts, reportHost } from './presenceHelpers.js';
import { usePresenceStore } from '../stores/presenceStore.js';

const READY_KEYS = { gemini: true, openai: true, groq: true, elevenlabs: true, deepgram: true };

function host(over: Parameters<typeof reportHost>[1] = {}): void {
  reportHost('h1', { hostName: 'the Mac', ...over });
  usePresenceStore.getState().setHostOnline('h1', true);
}

describe('voice readiness is checked when the user engages', () => {
  beforeEach(() => {
    clearHosts();
    useUiStore.setState({ errors: [] });
    useVoiceStore.getState().endCall?.();
    usePreferencesStore.setState({ loaded: true });
  });

  it('turning on Auto-notify with no usable speech voice invites setup, not an error', () => {
    host({ voiceLocal: { whisper: true, parakeet: true, kokoro: false } });
    const update = vi.fn().mockResolvedValue(undefined);
    usePreferencesStore.setState({ update } as never);
    const navigate = vi.fn();
    setAppNavigate(navigate);
    render(
      <MemoryRouter>
        <ReachSwitch />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('reach-switch'));
    const [toast] = useUiStore.getState().errors;
    expect(toast).toMatchObject({
      level: 'info',
      message: 'Spoken alerts need a speech voice on the Mac.',
    });
    expect(toast!.action?.label).toBe('Set up');
    toast!.action!.run();
    expect(navigate).toHaveBeenCalledWith('/settings/hosts');
    expect(update).not.toHaveBeenCalled();
  });

  it('turning on Auto-notify needs no speech to text', () => {
    host({
      voiceKeys: { ...READY_KEYS, groq: false },
      voiceLocal: { whisper: false, parakeet: false, kokoro: true },
    });
    const update = vi.fn().mockResolvedValue(undefined);
    usePreferencesStore.setState({ update } as never);
    render(
      <MemoryRouter>
        <ReachSwitch />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('reach-switch'));
    expect(useUiStore.getState().errors).toEqual([]);
    expect(update).toHaveBeenCalledWith({ reach: 'auto-notify' });
  });

  it('starting a call with a missing provider key invites setup before dialling', async () => {
    host({ voiceKeys: { ...READY_KEYS, gemini: false, openai: false } });
    useChatStore.setState((s) => ({
      chats: { ...s.chats, c1: { ...(s.chats['c1'] ?? {}), hostId: 'h1' } as never },
    }));
    const opener = vi.fn();
    __setAudioOpenerForTests(opener as never);
    await startVoiceCall('c1');
    expect(opener).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().call).toBeNull();
    const [toast] = useUiStore.getState().errors;
    expect(toast).toMatchObject({ level: 'info' });
    expect(toast!.message).toMatch(/^Calls need an? (Gemini|OpenAI) key on the Mac\.$/);
    expect(toast!.action?.label).toBe('Set up');
  });

  it('a spoken alert that cannot be spoken is an invitation, not "failed, try again"', async () => {
    host({ voiceLocal: { whisper: true, parakeet: true, kokoro: false } });
    const opener = vi.fn();
    __setSpeakOpenerForTests(opener as never);
    await speakInterrupt('c1', 'The build finished.');
    expect(opener).not.toHaveBeenCalled();
    const errors = useUiStore.getState().errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ level: 'info' });
    expect(errors[0]!.message).not.toMatch(/failed|try again/i);
    __setSpeakOpenerForTests(null);
  });
});
