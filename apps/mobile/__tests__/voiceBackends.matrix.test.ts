// The phone on every voice agent provider × every surface it opens (spec/07 §
// The voice agent): call and hands-free on Gemini, OpenAI and ElevenLabs, and
// dictation. The phone never talks to a provider — the host relays the voice
// agent over the same audio WSS — so what this pins is that:
//   - every backend opens the SAME session (same token route, same
//     session_start, same PCM up and down) — nothing on the phone is local-only
//     and no provider key or token is ever asked for;
//   - the call bar names the provider and model, and a provider's failure
//     lands on it loudly, naming the engine;
//   - a mode switch is always in place: both modes run on the one voice agent;
//   - dictation uploads to the one transcribe route whatever the backend, and a
//     hosted backend's refusal reaches the user.
// No provider is reached: a call's native session is FakeCallTransport, dictation's
// audio WSS is FakeWebSocket, and the REST API is mocked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';
import { FakeCallTransport } from './testUtils/fakeCallTransport';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useUiStore } from '../src/stores/uiStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import {
  DEFAULT_VOICE_AGENT,
  DEFAULT_VOICE_CONFIG,
  voiceKeyMissingMessage,
  type AudioSessionMode,
  type VoiceAgentProvider,
  type VoiceConfig,
} from '@patch/wire/audio';
import type { SettingsResponse } from '../src/api/rest';

const { meMock, voiceTokenMock, voiceTranscribeMock, seq } = vi.hoisted(() => {
  const seq = { n: 0 };
  return {
    seq,
    meMock: vi.fn(async () => ({
      account: { accountId: 'acc1', userPublicKey: 'k', createdAt: 0 },
      surface: { surfaceId: 'surf1', surfaceKind: 'mobile', label: 'l', issuedAt: 0 },
    })),
    voiceTokenMock: vi.fn(async () => {
      seq.n += 1;
      return {
        token: `tok${seq.n}`,
        sessionId: `sess-${seq.n}`,
        audioUrl: `/audio/sess-${seq.n}`,
        expiresAt: 0,
      };
    }),
    voiceTranscribeMock: vi.fn(async () => ({ ok: true as const, transcript: 'hello world' })),
  };
});
vi.mock('../src/api/rest', () => ({
  api: { me: meMock, voiceToken: voiceTokenMock, voiceTranscribe: voiceTranscribeMock },
}));

vi.mock('../src/lib/voiceAudioService', () => ({
  startVoiceAudioService: vi.fn(async () => undefined),
  stopVoiceAudioService: vi.fn(async () => undefined),
  updateVoiceAudioService: vi.fn(async () => undefined),
  onVoiceServiceAction: vi.fn(() => () => undefined),
}));

let micOnFrame: ((pcm: Int16Array) => void) | undefined;
const startMicCaptureMock = vi.fn(async (onFrame: (pcm: Int16Array) => void) => {
  micOnFrame = onFrame;
});
const stopMicCaptureMock = vi.fn(async () => undefined);
vi.mock('../src/lib/voiceMic', () => ({
  startMicCapture: startMicCaptureMock,
  stopMicCapture: stopMicCaptureMock,
}));

vi.mock('../src/lib/callTransport', async () =>
  (await import('./testUtils/fakeCallTransport')).fakeCallTransportModule(),
);

async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function seedConfig(
  voiceConfig: VoiceConfig,
  provider: VoiceAgentProvider = DEFAULT_VOICE_AGENT.provider,
): void {
  useSettingsStore.setState({
    data: {
      devices: [],
      push: { tokenCount: 0 },
      google: { configured: false, connected: false, scope: null },
      preferences: {
        addressWord: 'patch',
        voiceConfig,
        voiceAgent: { ...DEFAULT_VOICE_AGENT, provider },
      },
    } as unknown as SettingsResponse,
    error: null,
  });
}

async function openCall(chatId: string, mode: AudioSessionMode): Promise<FakeCallTransport> {
  const { startVoiceCall } = await import('../src/lib/voiceCall');
  startVoiceCall(chatId, mode);
  await flush();
  const sock = FakeCallTransport.last();
  sock.emitOpen();
  await flush();
  return sock;
}

beforeEach(() => {
  installFakeWebSocket();
  FakeWebSocket.reset();
  FakeCallTransport.reset();
  vi.clearAllMocks();
  seq.n = 0;
  useVoiceStore.setState({
    activeSession: null,
    callMuted: false,
    callError: null,
    callPhase: 'connecting',
    callTranscriptPartial: '',
    callMode: 'call',
    callEngine: null,
  });
  useUiStore.setState({ errors: [] });
  useSettingsStore.setState({ data: null, error: null });
});

afterEach(async () => {
  const { endVoiceCall } = await import('../src/lib/voiceCall');
  await endVoiceCall();
  restoreWebSocket();
});

const ENGINE_LABEL: Record<VoiceAgentProvider, string> = {
  gemini: 'Gemini · gemini-2.5-flash-native-audio-preview-12-2025',
  openai: 'OpenAI · gpt-realtime-2.1-mini',
  elevenlabs: 'ElevenLabs · claude-haiku-4-5',
};

const FAILURE: Partial<Record<VoiceAgentProvider, { code: string; engine: string }>> = {
  gemini: { code: 'gemini_unavailable', engine: 'Gemini Live' },
  openai: { code: 'openai_unavailable', engine: 'OpenAI Realtime' },
};

for (const mode of ['call', 'hands-free'] as const) {
  for (const backend of ['gemini', 'openai', 'elevenlabs'] as const) {
    {
      describe(`${mode} on ${backend}`, () => {
        it('opens the same host session as every other backend and plays its audio', async () => {
          seedConfig(DEFAULT_VOICE_CONFIG, backend);
          const sock = await openCall('c1', mode);
          expect(voiceTokenMock).toHaveBeenCalledWith('c1', 'voice-call');
          expect(sock.url).toContain('/audio/sess-1');
          const start = JSON.parse(sock.sent[0] as string) as Record<string, unknown>;
          // Backend-agnostic: the phone names no engine and carries no provider credential.
          expect(Object.keys(start).sort()).toEqual(
            [
              'accountId',
              'addressWord',
              'chatId',
              'mode',
              'role',
              'sessionId',
              'surfaceHasAec',
              'surfaceId',
              'surfaceKind',
              'token',
              'type',
            ].sort(),
          );
          expect(start).toMatchObject({ role: 'voice-call', mode, token: 'tok1' });
          // The same native session carries the mic up and plays the reply on
          // every backend (CallTransport.kt); JS hears the reply has started.
          expect(sock.url).toContain('/audio/sess-1');
          sock.emitMessage(
            JSON.stringify({ type: 'audio.state', sessionId: 'sess-1', state: 'listening' }),
          );
          sock.emitReplyAudio(960);
          expect(useVoiceStore.getState().callPhase).toBe('listening');
        });

        it('names the provider and model on the call bar', async () => {
          seedConfig(DEFAULT_VOICE_CONFIG, backend);
          await openCall('c1', mode);
          expect(useVoiceStore.getState().callEngine).toBe(ENGINE_LABEL[backend]);
        });

        {
          it('no key for it on the host: the call bar says exactly which key and where to switch', async () => {
            seedConfig(DEFAULT_VOICE_CONFIG, backend);
            const sock = await openCall('c1', mode);
            const message = voiceKeyMissingMessage(mode, backend);
            sock.emitMessage(
              JSON.stringify({ type: 'audio.error', code: 'voice_key_missing', message }),
            );
            sock.emitClose(4400, 'refused');
            await flush();
            expect(useVoiceStore.getState().callError).toBe(message);
            expect(useUiStore.getState().errors.at(-1)?.message).toBe(`voice call: ${message}`);
            // Nothing reopened a session on another engine.
            expect(voiceTokenMock).toHaveBeenCalledTimes(1);
            expect(FakeCallTransport.instances).toHaveLength(1);
          });

          const failure = FAILURE[backend];
          if (failure)
            it('a provider failure lands on the call bar naming the engine', async () => {
              seedConfig(DEFAULT_VOICE_CONFIG, backend);
              const sock = await openCall('c1', mode);
              const { code, engine } = failure;
              sock.emitMessage(
                JSON.stringify({
                  type: 'audio.error',
                  code,
                  message: 'closed the session (code 1011)',
                  sessionId: 'sess-1',
                }),
              );
              // The host ends the session behind a fatal engine failure.
              sock.emitClose(4400, 'closed');
              await flush();
              const st = useVoiceStore.getState();
              expect(st.callError).toBe(`${engine} failed — closed the session (code 1011)`);
              expect(
                useUiStore.getState().errors.at(-1)?.message ?? useUiStore.getState().errors.at(-1),
              ).toEqual(expect.stringContaining(`${engine} failed`));
              // Audio released; nothing reopened a session on another engine.
              expect(sock.close).toHaveBeenCalled();
              expect(voiceTokenMock).toHaveBeenCalledTimes(1);
              expect(FakeCallTransport.instances).toHaveLength(1);
            });
        }
      });
    }
  }
}

describe('switching mode', () => {
  it('flips in place — both modes run on the one voice agent', async () => {
    seedConfig(DEFAULT_VOICE_CONFIG, 'openai');
    const sock = await openCall('c1', 'call');
    const { setCallMode } = await import('../src/lib/voiceCall');
    setCallMode('hands-free');
    await flush();
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({
      type: 'audio.mode',
      sessionId: 'sess-1',
      mode: 'hands-free',
    });
    expect(voiceTokenMock).toHaveBeenCalledTimes(1);
  });

  it('flips in place with the setup not loaded yet', async () => {
    const sock = await openCall('c1', 'call');
    expect(useVoiceStore.getState().callEngine).toBeNull();
    const { setCallMode } = await import('../src/lib/voiceCall');
    setCallMode('hands-free');
    expect(JSON.parse(sock.sent.at(-1)!).type).toBe('audio.mode');
    expect(voiceTokenMock).toHaveBeenCalledTimes(1);
  });
});

describe('dictation on each phone engine', () => {
  it('Whisper: records locally and uploads to the one transcribe route', async () => {
    seedConfig({
      ...DEFAULT_VOICE_CONFIG,
      dictation: { phone: 'whisper', computer: 'whisper', tidy: false },
    });
    const { startDictation, __resetDictationAudio } = await import('../src/lib/dictation');
    __resetDictationAudio();
    const onError = vi.fn();
    const handle = startDictation('c1', vi.fn(), onError, vi.fn(), { engine: 'whisper' });
    await flush();
    for (let i = 0; i < 10; i++) micOnFrame!(new Int16Array(640));
    expect(await handle.finish(true)).toEqual({ kind: 'text', text: 'hello world' });
    expect(voiceTranscribeMock).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('Deepgram: a host with no key for it refuses at the press — mic stopped, nothing uploaded', async () => {
    seedConfig({
      ...DEFAULT_VOICE_CONFIG,
      dictation: { phone: 'deepgram', computer: 'whisper', tidy: false },
    });
    const message = voiceKeyMissingMessage('dictation', 'deepgram');
    const { startDictation, __resetDictationAudio } = await import('../src/lib/dictation');
    __resetDictationAudio();
    const onError = vi.fn();
    const handle = startDictation('c1', vi.fn(), onError, vi.fn(), { engine: 'stream' });
    await flush();
    const sock = FakeWebSocket.last();
    sock.emitOpen();
    micOnFrame!(new Int16Array(640));
    // The host refuses the session the moment it starts.
    sock.emitMessage(JSON.stringify({ type: 'audio.error', code: 'voice_key_missing', message }));
    await flush();
    expect(onError).toHaveBeenCalledWith(message);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(stopMicCaptureMock).toHaveBeenCalled();
    expect(await handle.finish(true)).toEqual({ kind: 'discarded' });
    expect(voiceTranscribeMock).not.toHaveBeenCalled();
  });
});
