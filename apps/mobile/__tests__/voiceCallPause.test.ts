// lib/voiceCall.ts — pausing a call (spec/07 § Pause): one paused state reached
// from the button, the headphones coming out and the silence timeout; and an
// agent's call opening with its reason. Same harness as voiceCall.test.ts.
//
// (Harness notes from voiceCall.test.ts follow.) voiceGestures.test.ts already pins the SYNCHRONOUS
// overlay-mount guarantee; this file drives the full async setup (token
// mint → mic permission → TTS sink → audio WS → session_start → mic uplink)
// and the WS message dispatch table, using the FakeWebSocket test double and
// mocked native-bridge modules (voiceMic/voiceTts/voiceAudioService — their
// OWN NativeModules-branch tests live in voiceMic.test.ts / voiceTts.test.ts
// / voiceAudioService.test.ts; here we only care that voiceCall wires them
// correctly).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useUiStore } from '../src/stores/uiStore';
import type { VoiceServiceAction } from '../src/lib/voiceAudioService';

const prefs = vi.hoisted(() => ({ quiet: 0 }));
vi.mock('../src/lib/preferences', () => ({
  addressWordOrNull: () => 'patch',
  voiceAgentOrNull: () => null,
  pauseWhenQuietMinutes: () => prefs.quiet,
}));
const cues = vi.hoisted(() => ({ played: [] as string[] }));
vi.mock('../src/lib/callSounds', () => ({
  playCallSound: async (c: string) => {
    cues.played.push(c);
  },
  syncCallSoundLoop: () => undefined,
}));

const meMock = vi.fn(async () => ({
  account: { accountId: 'acc1', userPublicKey: 'k', createdAt: 0 },
  surface: { surfaceId: 'surf1', surfaceKind: 'mobile', label: 'l', issuedAt: 0 },
}));
const voiceTokenMock = vi.fn(async () => ({
  token: 'tok1',
  sessionId: 'sess-1',
  audioUrl: '/audio/sess-1',
  expiresAt: 0,
}));
vi.mock('../src/api/rest', () => ({ api: { me: meMock, voiceToken: voiceTokenMock } }));

const startVoiceAudioServiceMock = vi.fn(async () => undefined);
const stopVoiceAudioServiceMock = vi.fn(async () => undefined);
const updateVoiceAudioServiceMock = vi.fn(async () => undefined);
// The notification's buttons come back through this; capture the handler so a
// test can press them (spec/15 § Voice tab — the notification is the control
// surface for a phone the user is not looking at).
let serviceActionHandler: ((action: VoiceServiceAction) => void) | undefined;
const onVoiceServiceActionMock = vi.fn((h: (action: VoiceServiceAction) => void) => {
  serviceActionHandler = h;
  return () => {
    serviceActionHandler = undefined;
  };
});
vi.mock('../src/lib/voiceAudioService', () => ({
  startVoiceAudioService: startVoiceAudioServiceMock,
  stopVoiceAudioService: stopVoiceAudioServiceMock,
  updateVoiceAudioService: updateVoiceAudioServiceMock,
  onVoiceServiceAction: onVoiceServiceActionMock,
}));

const startMicCaptureMock = vi.fn(async () => undefined);
const stopMicCaptureMock = vi.fn(async () => undefined);
vi.mock('../src/lib/voiceMic', () => ({
  startMicCapture: startMicCaptureMock,
  stopMicCapture: stopMicCaptureMock,
}));

const startTtsPlaybackMock = vi.fn(async () => undefined);
const writeTtsPcmMock = vi.fn();
const flushTtsPlaybackMock = vi.fn(async () => undefined);
const stopTtsPlaybackMock = vi.fn(async () => undefined);
vi.mock('../src/lib/voiceTts', () => ({
  startTtsPlayback: startTtsPlaybackMock,
  writeTtsPcm: writeTtsPcmMock,
  flushTtsPlayback: flushTtsPlaybackMock,
  stopTtsPlayback: stopTtsPlaybackMock,
}));

async function flush(n = 14): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(() => {
  installFakeWebSocket();
  vi.clearAllMocks();
  meMock.mockResolvedValue({
    account: { accountId: 'acc1', userPublicKey: 'k', createdAt: 0 },
    surface: { surfaceId: 'surf1', surfaceKind: 'mobile', label: 'l', issuedAt: 0 },
  });
  voiceTokenMock.mockResolvedValue({
    token: 'tok1',
    sessionId: 'sess-1',
    audioUrl: '/audio/sess-1',
    expiresAt: 0,
  });
  useVoiceStore.setState({
    activeSession: null,
    callMuted: false,
    callError: null,
    callPhase: 'connecting',
    callTranscriptPartial: null as unknown as string,
  });
  useUiStore.setState({ errors: [] });
});

afterEach(() => {
  restoreWebSocket();
});

type Frame = { type: string; [k: string]: unknown };
const frames = (ws: FakeWebSocket): Frame[] =>
  ws.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d) as Frame);

/** Start a call and bring it live (the host's first state). */
async function live(
  opts: Parameters<typeof import('../src/lib/voiceCall').startVoiceCall>[2] = {},
  mode: 'call' | 'hands-free' = 'call',
): Promise<FakeWebSocket> {
  const { startVoiceCall } = await import('../src/lib/voiceCall');
  startVoiceCall('c1', mode, opts);
  await flush();
  const ws = FakeWebSocket.last();
  ws.emitOpen();
  await flush();
  ws.emitMessage(JSON.stringify({ type: 'audio.state', sessionId: 'sess-1', state: 'listening' }));
  return ws;
}

beforeEach(() => {
  prefs.quiet = 0;
  cues.played = [];
  FakeWebSocket.reset();
  useVoiceStore.setState({ callPaused: null, callMode: 'call' });
});

afterEach(async () => {
  const { endVoiceCall } = await import('../src/lib/voiceCall');
  await endVoiceCall();
  vi.useRealTimers();
});

describe('pause', () => {
  it('closes the session but keeps the call and its service, releasing the audio', async () => {
    const ws = await live();
    const { pauseVoiceCall } = await import('../src/lib/voiceCall');
    pauseVoiceCall();
    const st = useVoiceStore.getState();
    expect(st.callPaused).toBe('button');
    expect(st.activeSession?.chatId).toBe('c1');
    expect(frames(ws).at(-1)).toMatchObject({ type: 'audio.session_end', reason: 'paused' });
    expect(ws.close).toHaveBeenCalled();
    expect(stopMicCaptureMock).toHaveBeenCalled();
    expect(stopVoiceAudioServiceMock).not.toHaveBeenCalled();
    expect(updateVoiceAudioServiceMock).toHaveBeenLastCalledWith(
      'c1',
      expect.objectContaining({ paused: true }),
    );
    expect(cues.played.at(-1)).toBe('paused');
  });

  it('the paused session closing is not a drop: nothing redials', async () => {
    vi.useFakeTimers();
    await live();
    const { pauseVoiceCall } = await import('../src/lib/voiceCall');
    const before = FakeWebSocket.instances.length;
    pauseVoiceCall();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.instances.length).toBe(before);
    expect(useVoiceStore.getState().callError).toBeNull();
  });

  it('resume opens a new session on the same chat — not a redial — and retakes the audio', async () => {
    await live({}, 'hands-free');
    const { pauseVoiceCall, resumeVoiceCall } = await import('../src/lib/voiceCall');
    pauseVoiceCall();
    startVoiceAudioServiceMock.mockClear();
    resumeVoiceCall();
    await flush();
    const ws = FakeWebSocket.last();
    ws.emitOpen();
    await flush();
    const start = frames(ws).find((f) => f.type === 'audio.session_start')!;
    expect(start).toMatchObject({ chatId: 'c1', mode: 'hands-free' });
    expect(start['resumed']).toBeUndefined();
    // The service never went away: it is told to take the audio back, not started again.
    expect(startVoiceAudioServiceMock).not.toHaveBeenCalled();
    expect(updateVoiceAudioServiceMock).toHaveBeenLastCalledWith(
      'c1',
      expect.objectContaining({ paused: false }),
    );
    expect(useVoiceStore.getState().callPaused).toBeNull();
    ws.emitMessage(
      JSON.stringify({ type: 'audio.state', sessionId: 'sess-1', state: 'listening' }),
    );
    expect(cues.played.at(-1)).toBe('connected');
  });

  it('resume from the notification', async () => {
    await live();
    const { pauseVoiceCall } = await import('../src/lib/voiceCall');
    pauseVoiceCall();
    const before = FakeWebSocket.instances.length;
    serviceActionHandler!('resume');
    await flush();
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it('ending a paused call stops the service with the ended cue', async () => {
    await live();
    const { pauseVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    pauseVoiceCall();
    await endVoiceCall();
    expect(useVoiceStore.getState().activeSession).toBeNull();
    expect(stopVoiceAudioServiceMock).toHaveBeenCalled();
    expect(cues.played.at(-1)).toBe('ended');
  });
});

describe('headphones', () => {
  it('out pauses the call; back in resumes it', async () => {
    await live();
    serviceActionHandler!('headset_removed');
    expect(useVoiceStore.getState().callPaused).toBe('headphones');
    const before = FakeWebSocket.instances.length;
    serviceActionHandler!('headset_added');
    await flush();
    expect(FakeWebSocket.instances.length).toBe(before + 1);
    expect(useVoiceStore.getState().callPaused).toBeNull();
  });

  it('a call paused from the button stays paused when headphones go in', async () => {
    await live();
    const { pauseVoiceCall } = await import('../src/lib/voiceCall');
    pauseVoiceCall();
    const before = FakeWebSocket.instances.length;
    serviceActionHandler!('headset_added');
    await flush();
    expect(FakeWebSocket.instances.length).toBe(before);
    expect(useVoiceStore.getState().callPaused).toBe('button');
  });
});

describe('pause when quiet', () => {
  it('pauses a call after the set time with nothing said, and not before', async () => {
    vi.useFakeTimers();
    prefs.quiet = 5;
    await live();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    FakeWebSocket.last().emitMessage(
      JSON.stringify({ type: 'audio.transcript_partial', sessionId: 'sess-1', text: 'hm' }),
    );
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(useVoiceStore.getState().callPaused).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(useVoiceStore.getState().callPaused).toBe('quiet');
  });

  it('is off at 0, and leaves hands-free alone', async () => {
    vi.useFakeTimers();
    prefs.quiet = 0;
    await live();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(useVoiceStore.getState().callPaused).toBeNull();
    const { endVoiceCall } = await import('../src/lib/voiceCall');
    await endVoiceCall();
    prefs.quiet = 2;
    await live({}, 'hands-free');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(useVoiceStore.getState().callPaused).toBeNull();
  });
});

describe("an agent's call", () => {
  it('opens with the reason it rang, and a redial does not say it again', async () => {
    vi.useFakeTimers();
    const ws = await live({ callReason: 'The build is red; roll back?' });
    expect(frames(ws).find((f) => f.type === 'audio.session_start')).toMatchObject({
      callReason: 'The build is red; roll back?',
    });
    ws.emitClose();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    const again = FakeWebSocket.last();
    expect(again).not.toBe(ws);
    again.emitOpen();
    await flush();
    const start = frames(again).find((f) => f.type === 'audio.session_start')!;
    expect(start['resumed']).toBe(true);
    expect(start['callReason']).toBeUndefined();
  });

  it('answered on its own, it holds transient focus for the whole call — across a pause', async () => {
    await live({ transientFocus: true }, 'hands-free');
    expect(startVoiceAudioServiceMock).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ transientFocus: true, mode: 'hands-free' }),
    );
    const { pauseVoiceCall, resumeVoiceCall } = await import('../src/lib/voiceCall');
    pauseVoiceCall();
    resumeVoiceCall();
    await flush();
    expect(updateVoiceAudioServiceMock).toHaveBeenLastCalledWith(
      'c1',
      expect.objectContaining({ transientFocus: true, paused: false }),
    );
  });
});
