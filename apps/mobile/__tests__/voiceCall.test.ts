// lib/voiceCall.ts — the sustained voice-CALL session (spec/07 § End-to-end
// voice transport). voiceGestures.test.ts already pins the SYNCHRONOUS
// overlay-mount guarantee; this file drives the full async setup (token mint →
// mic permission → audio service → the native session, which sends
// session_start on open) and the host-frame dispatch table, using the
// FakeCallTransport double for the native session (its microphone, heartbeat
// echo and playback are native: CallTransport.kt, CallFramesTest.kt).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { micNeedsPrompt } from './testUtils/permissionPrompt';
import {
  FakeCallTransport,
  flushCallPlaybackMock,
  openCallTransportMock,
} from './testUtils/fakeCallTransport';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useUiStore } from '../src/stores/uiStore';

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
let serviceActionHandler: ((action: 'mute' | 'mode' | 'stop') => void) | undefined;
const onVoiceServiceActionMock = vi.fn((h: (action: 'mute' | 'mode' | 'stop') => void) => {
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

const playCallSoundMock = vi.fn(async () => undefined);
vi.mock('../src/lib/callSounds', () => ({
  playCallSound: playCallSoundMock,
  syncCallSoundLoop: vi.fn(),
}));
vi.mock('../src/lib/callTransport', async () =>
  (await import('./testUtils/fakeCallTransport')).fakeCallTransportModule(),
);

async function flush(n = 14): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(() => {
  FakeCallTransport.reset();
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
  FakeCallTransport.reset();
});

describe('startVoiceCall — happy path', () => {
  it('mints a token, opens the native session, which sends session_start on open', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    expect(voiceTokenMock).toHaveBeenCalledWith('c1', 'voice-call');
    expect(useVoiceStore.getState().activeSession).toMatchObject({
      sessionId: 'sess-1',
      audioUrl: '/audio/sess-1',
    });
    // The notification names the mode it is running in (spec/15 § Voice tab).
    expect(startVoiceAudioServiceMock).toHaveBeenCalledWith('c1', {
      mode: 'call',
      muted: false,
      transientFocus: false,
    });

    const sock = FakeCallTransport.last();
    expect(sock.url).toContain('/audio/sess-1');
    sock.emitOpen();
    await flush();
    const start = JSON.parse(sock.sent[0]!);
    expect(start).toMatchObject({
      type: 'audio.session_start',
      sessionId: 'sess-1',
      accountId: 'acc1',
      surfaceId: 'surf1',
      chatId: 'c1',
      role: 'voice-call',
      token: 'tok1',
    });
  });

  it('takeOver goes on session_start only when the call is a switch from another device', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1', 'call', { takeOver: true });
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    expect(JSON.parse(sock.sent[0]!).takeOver).toBe(true);
  });

  it('a close with reason "transferred" ends the call quietly instead of reporting it dropped', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    sock.emitClose(1000, 'transferred');
    await flush();
    expect(useVoiceStore.getState().activeSession).toBeNull();
    expect(useVoiceStore.getState().callError).toBeNull();
  });

  it('a close with no reason is still reported as a dropped call', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    sock.emitClose(1000, '');
    expect(useVoiceStore.getState().callError).toMatch(/Call dropped/);
  });

  it('a plain call carries no takeOver', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    expect('takeOver' in JSON.parse(sock.sent[0]!)).toBe(false);
  });

  it('a microphone failure reported by the native session fails the call, loudly', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    sock.emitMessage({ type: 'audio.state', sessionId: 'sess-1', state: 'listening' });
    sock.emitMicError('AudioRecord.read returned -3');
    expect(useVoiceStore.getState().callError).toMatch(/mic failed: AudioRecord.read returned -3/);
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('AudioRecord.read returned -3')),
    ).toBe(true);
  });

  it("muting is the service's: the notification is updated and the native session reads it", async () => {
    const { startVoiceCall, setCallMuted } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    FakeCallTransport.last().emitOpen();
    setCallMuted(true);
    expect(updateVoiceAudioServiceMock).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ muted: true }),
    );
  });

  it('the first audio of a reply is a turn mark; nothing else of it reaches JS', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    expect(() => sock.emitReplyAudio(9600)).not.toThrow();
  });
});

describe('startVoiceCall — mounts synchronously in CONNECTING state', () => {
  it('activeSession is set before any await resolves', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    const s = useVoiceStore.getState().activeSession;
    expect(s).not.toBeNull();
    expect(s?.sessionId).toBe('');
    await flush();
  });
});

describe('startVoiceCall — setup failures (NO FALLBACK, overlay stays up with an error)', () => {
  it('an empty audioUrl surfaces an error', async () => {
    voiceTokenMock.mockResolvedValueOnce({
      token: 't',
      sessionId: 's',
      audioUrl: '',
      expiresAt: 0,
    });
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    // More microtask hops than a fixed flush() count reliably covers, so poll.
    await vi.waitFor(() => expect(useVoiceStore.getState().callError).toMatch(/empty audioUrl/));
    expect(useUiStore.getState().errors.some((e) => e.message.includes('voice call:'))).toBe(true);
  });

  it('a denied mic permission surfaces an error and tears down the audio service', async () => {
    const { Audio } = await import('expo-av');
    micNeedsPrompt();
    vi.spyOn(Audio, 'requestPermissionsAsync').mockResolvedValueOnce({ granted: false });
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await vi.waitFor(() =>
      expect(useVoiceStore.getState().callError).toMatch(/mic permission denied/),
    );
    expect(stopVoiceAudioServiceMock).toHaveBeenCalled();
  });

  it('a native session that cannot start (no playback device) fails the call naming why', async () => {
    openCallTransportMock.mockRejectedValueOnce(new Error('AudioTrack failed to initialise'));
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await vi.waitFor(() =>
      expect(useVoiceStore.getState().callError).toMatch(
        /failed to open the call's audio session: AudioTrack failed to initialise/,
      ),
    );
  });

  it('a call ended (gen bump) during token mint bails without opening a WS', async () => {
    let resolveToken!: (v: {
      token: string;
      sessionId: string;
      audioUrl: string;
      expiresAt: number;
    }) => void;
    voiceTokenMock.mockReturnValueOnce(
      new Promise((r) => {
        resolveToken = r;
      }),
    );
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await endVoiceCall(); // bumps _callGen before the token mint resolves
    resolveToken({ token: 't', sessionId: 's', audioUrl: '/audio/s', expiresAt: 0 });
    await flush();
    expect(FakeCallTransport.instances.length).toBe(0);
  });

  it('a call ended during the mic-permission wait bails before touching audio setup', async () => {
    let resolvePerm!: (p: { granted: boolean }) => void;
    const { Audio } = await import('expo-av');
    micNeedsPrompt();
    vi.spyOn(Audio, 'requestPermissionsAsync').mockReturnValueOnce(
      new Promise((r) => {
        resolvePerm = r;
      }),
    );
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    // Wait until we're KNOWN to be blocked on the (still-pending) permission
    // prompt — polling avoids guessing a fixed microtask-tick count, which
    // is fragile given the number of awaits ahead of this point.
    await vi.waitFor(() => expect(Audio.requestPermissionsAsync).toHaveBeenCalled());
    await endVoiceCall(); // bumps _callGen while the permission prompt is still open
    resolvePerm({ granted: true });
    await flush();
    expect(FakeCallTransport.instances.length).toBe(0);
  });

  it('a call ended during the audio-mode setup bails before opening the session', async () => {
    let resolveMode!: () => void;
    const { Audio } = await import('expo-av');
    vi.spyOn(Audio, 'setAudioModeAsync').mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveMode = r;
      }),
    );
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await vi.waitFor(() => expect(Audio.setAudioModeAsync).toHaveBeenCalled());
    await endVoiceCall();
    resolveMode();
    await flush();
    expect(FakeCallTransport.instances.length).toBe(0);
  });

  it('a setup failure from an already-superseded call is silently dropped (outer catch gen-check)', async () => {
    // The token mint rejects, but only AFTER this call has already been
    // superseded by endVoiceCall() — the outer catch's own gen-check must
    // stop it from tearing down / erroring over the CURRENT (different) call.
    let rejectToken!: (e: Error) => void;
    voiceTokenMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectToken = reject;
      }),
    );
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await vi.waitFor(() => expect(voiceTokenMock).toHaveBeenCalled());
    await endVoiceCall();
    useUiStore.setState({ errors: [] }); // clear whatever endVoiceCall itself may have logged
    rejectToken(new Error('mint failed, but too late to matter'));
    await flush();
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('an event from a session that has been ended changes nothing', async () => {
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await endVoiceCall();
    expect(sock.close).toHaveBeenCalled();
    expect(() => sock.emitMicError('late')).not.toThrow();
    expect(useVoiceStore.getState().callError).toBeNull();
  });

  it('a call ended while its session opened closes the session it was given', async () => {
    let resolveOpen!: () => void;
    openCallTransportMock.mockImplementationOnce(async (url, start, handlers) => {
      const t = new FakeCallTransport(url, start, handlers);
      await new Promise<void>((r) => {
        resolveOpen = r;
      });
      return { send: t.send, close: t.close };
    });
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await vi.waitFor(() => expect(openCallTransportMock).toHaveBeenCalled());
    await endVoiceCall();
    resolveOpen();
    await flush();
    expect(FakeCallTransport.last().close).toHaveBeenCalled();
  });

  it('a call ended during the audio-service start tears the service down', async () => {
    let resolveSvc!: () => void;
    startVoiceAudioServiceMock.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveSvc = r;
      }),
    );
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await vi.waitFor(() => expect(startVoiceAudioServiceMock).toHaveBeenCalled());
    await endVoiceCall();
    resolveSvc();
    await flush();
    expect(stopVoiceAudioServiceMock).toHaveBeenCalled();
    expect(FakeCallTransport.instances.length).toBe(0);
  });

  it('the overlay timer keeps running off the original startedAt if activeSession vanished mid-setup (?? Date.now() fallback)', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    // Between the synchronous mount and the async continuation reaching the
    // "upgrade to live session" step, something else clears activeSession
    // (e.g. a store reset) without bumping _callGen — the upgrade must still
    // produce a usable startedAt rather than crash on `undefined.startedAt`.
    useVoiceStore.setState({ activeSession: null });
    await flush();
    expect(useVoiceStore.getState().activeSession?.startedAt).toEqual(expect.any(Number));
  });
});

describe('audio WS message dispatch', () => {
  async function openCall(): Promise<FakeCallTransport> {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    return sock;
  }

  it('audio.state updates the call phase', async () => {
    const sock = await openCall();
    sock.emitMessage(
      JSON.stringify({ type: 'audio.state', sessionId: 'sess-1', state: 'thinking' }),
    );
    expect(useVoiceStore.getState().callPhase).toBe('thinking');
  });

  it('audio.transcript_partial sets phase=transcribing + the partial text', async () => {
    const sock = await openCall();
    sock.emitMessage(
      JSON.stringify({ type: 'audio.transcript_partial', sessionId: 'sess-1', text: 'hel' }),
    );
    expect(useVoiceStore.getState().callPhase).toBe('transcribing');
    expect(useVoiceStore.getState().callTranscriptPartial).toBe('hel');
  });

  it('audio.transcript_final sets phase=thinking + clears the partial', async () => {
    const sock = await openCall();
    useVoiceStore.getState().setCallTranscriptPartial('hel');
    sock.emitMessage(
      JSON.stringify({ type: 'audio.transcript_final', sessionId: 'sess-1', text: 'hello' }),
    );
    expect(useVoiceStore.getState().callPhase).toBe('thinking');
    expect(useVoiceStore.getState().callTranscriptPartial).toBe('');
  });

  it('audio.tts_end (no bargedIn) sets phase=listening', async () => {
    const sock = await openCall();
    sock.emitMessage(JSON.stringify({ type: 'audio.tts_end', sessionId: 'sess-1' }));
    expect(useVoiceStore.getState().callPhase).toBe('listening');
  });

  it('audio.tts_end (bargedIn=true) also sets phase=listening', async () => {
    const sock = await openCall();
    sock.emitMessage(
      JSON.stringify({ type: 'audio.tts_end', sessionId: 'sess-1', bargedIn: true }),
    );
    expect(useVoiceStore.getState().callPhase).toBe('listening');
  });

  it('audio.barge_in sets phase=listening (the native session has cut playback itself)', async () => {
    const sock = await openCall();
    sock.emitMessage(JSON.stringify({ type: 'audio.barge_in', sessionId: 'sess-1', at: 0 }));
    expect(useVoiceStore.getState().callPhase).toBe('listening');
    expect(flushCallPlaybackMock).not.toHaveBeenCalled();
  });

  it('user speech after tts_end flushes the TTS audio still queued on the phone', async () => {
    const sock = await openCall();
    sock.emitMessage(JSON.stringify({ type: 'audio.tts_end', sessionId: 'sess-1' }));
    flushCallPlaybackMock.mockClear();
    sock.emitMessage(
      JSON.stringify({ type: 'audio.transcript_partial', sessionId: 'sess-1', text: 'no wait' }),
    );
    expect(flushCallPlaybackMock).toHaveBeenCalledTimes(1);
    expect(useVoiceStore.getState().callPhase).toBe('transcribing');
  });

  it('a trailing partial while the reply is speaking does not flush it', async () => {
    const sock = await openCall();
    sock.emitMessage(
      JSON.stringify({ type: 'audio.state', sessionId: 'sess-1', state: 'speaking' }),
    );
    flushCallPlaybackMock.mockClear();
    sock.emitMessage(
      JSON.stringify({ type: 'audio.transcript_partial', sessionId: 'sess-1', text: 'late' }),
    );
    expect(flushCallPlaybackMock).not.toHaveBeenCalled();
  });

  it('audio.error sets a call error and pushes a UI error', async () => {
    const sock = await openCall();
    sock.emitMessage(
      JSON.stringify({
        type: 'audio.error',
        code: 'sdk_error',
        message: 'boom',
        sessionId: 'sess-1',
      }),
    );
    expect(useVoiceStore.getState().callError).toBe('sdk_error: boom');
    expect(useUiStore.getState().errors.some((e) => e.message.includes('sdk_error: boom'))).toBe(
      true,
    );
  });

  it('a failed catch-up is said, but the call carries on: no call error', async () => {
    const sock = await openCall();
    sock.emitMessage(
      JSON.stringify({
        type: 'audio.error',
        code: 'catch_up_failed',
        message: 'the catch-up could not be written',
        sessionId: 'sess-1',
      }),
    );
    expect(useVoiceStore.getState().callError).toBeNull();
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('catch-up could not be written')),
    ).toBe(true);
  });

  it('audio.passed_to_agent plays the passed to agent sound', async () => {
    const sock = await openCall();
    playCallSoundMock.mockClear();
    sock.emitMessage(JSON.stringify({ type: 'audio.passed_to_agent', sessionId: 'sess-1' }));
    expect(playCallSoundMock).toHaveBeenCalledWith('passed-to-agent');
  });

  it('audio.chat_switched moves the call, and its notification, to the new chat', async () => {
    const sock = await openCall();
    sock.emitMessage(
      JSON.stringify({ type: 'audio.chat_switched', sessionId: 'sess-1', chatId: 'c2' }),
    );
    expect(useVoiceStore.getState().activeSession?.chatId).toBe('c2');
    expect(updateVoiceAudioServiceMock).toHaveBeenCalledWith(
      'c2',
      expect.objectContaining({ mode: 'call' }),
    );
  });

  it('a malformed JSON frame surfaces a UI error, does not throw', async () => {
    const sock = await openCall();
    expect(() => sock.emitMessage('not json{{')).not.toThrow();
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('malformed audio frame')),
    ).toBe(true);
  });

  it('a session_start echo frame (default branch) is a no-op', async () => {
    const sock = await openCall();
    expect(() =>
      sock.emitMessage(
        JSON.stringify({
          type: 'audio.session_start',
          sessionId: 'sess-1',
          accountId: 'a',
          surfaceId: 's',
          surfaceKind: 'mobile',
          chatId: 'c1',
          role: 'voice-call',
          token: 't',
          surfaceHasAec: true,
        }),
      ),
    ).not.toThrow();
  });

  it('a socket that fails names the error in the dropped call', async () => {
    const sock = await openCall();
    sock.emitClose(1006, '', 'Connection reset');
    expect(useVoiceStore.getState().callError).toMatch(
      /Call dropped — audio connection error: Connection reset/,
    );
  });
});

describe('endVoiceCall', () => {
  it('sends session_end with the sessionId, closes the session and the audio service, clears the store', async () => {
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    sock.sent.length = 0;

    await endVoiceCall();
    const end = JSON.parse(sock.sent[0]!);
    expect(end).toMatchObject({ type: 'audio.session_end', sessionId: 'sess-1' });
    expect(sock.close).toHaveBeenCalled();
    expect(stopVoiceAudioServiceMock).toHaveBeenCalled();
    expect(useVoiceStore.getState().activeSession).toBeNull();
  });

  it('a session that never opened is closed without a session_end', async () => {
    const { startVoiceCall, endVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    await expect(endVoiceCall()).resolves.toBeUndefined();
    expect(sock.sent).toHaveLength(0);
    expect(sock.close).toHaveBeenCalled();
  });

  it('with no active session at all, endVoiceCall is a harmless no-op', async () => {
    const { endVoiceCall } = await import('../src/lib/voiceCall');
    await expect(endVoiceCall()).resolves.toBeUndefined();
  });
});

describe('session modes + the notification as a control surface', () => {
  it('opens in `call` by default and carries the mode into session_start', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    FakeCallTransport.last().emitOpen();
    await flush();
    const start = JSON.parse(FakeCallTransport.last().sent[0] as string);
    expect(start.mode).toBe('call');
    expect(useVoiceStore.getState().callMode).toBe('call');
  });

  it('opens hands-free when asked, and tells the notification which mode it is in', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1', 'hands-free');
    await flush();
    expect(startVoiceAudioServiceMock).toHaveBeenCalledWith('c1', {
      mode: 'hands-free',
      muted: false,
      transientFocus: false,
    });
    FakeCallTransport.last().emitOpen();
    await flush();
    expect(JSON.parse(FakeCallTransport.last().sent[0] as string).mode).toBe('hands-free');
  });

  it('switching mode reaches the open session and re-renders the notification', async () => {
    const { startVoiceCall, setCallMode } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    sock.sent.length = 0;
    setCallMode('hands-free');
    expect(useVoiceStore.getState().callMode).toBe('hands-free');
    expect(JSON.parse(sock.sent[0]!)).toMatchObject({
      type: 'audio.mode',
      mode: 'hands-free',
    });
    expect(updateVoiceAudioServiceMock).toHaveBeenCalledWith('c1', {
      mode: 'hands-free',
      muted: false,
      paused: false,
      transientFocus: false,
    });
    // Flipping to what it already is does nothing at all.
    sock.sent.length = 0;
    setCallMode('hands-free');
    expect(sock.sent.length).toBe(0);
  });

  it('an unaddressed utterance is shown as heard and never treated as a turn', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1', 'hands-free');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    sock.emitMessage(
      JSON.stringify({
        type: 'audio.transcript_final',
        sessionId: 'sess-1',
        text: 'render the whole wall first',
        addressed: false,
      }),
    );
    expect(useVoiceStore.getState().callUnaddressed).toBe('render the whole wall first');
    // No turn is coming, so it goes straight back to listening rather than
    // sitting on 'thinking' forever.
    expect(useVoiceStore.getState().callPhase).toBe('listening');
  });

  it('the notification buttons drive the same state the overlay does', async () => {
    const { startVoiceCall } = await import('../src/lib/voiceCall');
    startVoiceCall('c1');
    await flush();
    FakeCallTransport.last().emitOpen();
    await flush();
    expect(serviceActionHandler).toBeDefined();

    serviceActionHandler!('mute');
    expect(useVoiceStore.getState().callMuted).toBe(true);
    expect(updateVoiceAudioServiceMock).toHaveBeenCalledWith('c1', {
      mode: 'call',
      muted: true,
      paused: false,
      transientFocus: false,
    });

    serviceActionHandler!('mode');
    expect(useVoiceStore.getState().callMode).toBe('hands-free');

    serviceActionHandler!('stop');
    await flush();
    expect(useVoiceStore.getState().activeSession).toBeNull();
  });
});
