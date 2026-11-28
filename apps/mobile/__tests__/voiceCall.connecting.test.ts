// lib/voiceCall.ts — the CONNECTING state is distinct and can fail loudly
// (spec/15 § Voice states): a session that never hears the host's first
// `audio.state` is declared failed after CALL_ACK_TIMEOUT_MS with its
// audio released and a retry offered; a socket the host drops mid-call says
// so; retry reopens the same chat in the same mode; the timer counts from
// connection, not from the tap; the address word the session opened with is
// what the hands-free hint names.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeCallTransport } from './testUtils/fakeCallTransport';
import { __emitAppStateChange } from './stubs/react-native';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useUiStore } from '../src/stores/uiStore';

vi.mock('../src/api/rest', () => ({
  api: {
    me: vi.fn(async () => ({
      account: { accountId: 'acc1', userPublicKey: 'k', createdAt: 0 },
      surface: { surfaceId: 'surf1', surfaceKind: 'mobile', label: 'l', issuedAt: 0 },
    })),
    voiceToken: vi.fn(async () => ({
      token: 'tok1',
      sessionId: 'sess-1',
      audioUrl: '/audio/sess-1',
      expiresAt: 0,
    })),
  },
}));
const { stopVoiceAudioServiceMock, prefs } = vi.hoisted(() => ({
  stopVoiceAudioServiceMock: vi.fn(async () => undefined),
  prefs: { addressWord: 'patch' as string | null, pauseWhenQuietMinutes: 0 },
}));
vi.mock('../src/lib/voiceAudioService', () => ({
  startVoiceAudioService: vi.fn(async () => undefined),
  stopVoiceAudioService: stopVoiceAudioServiceMock,
  updateVoiceAudioService: vi.fn(async () => undefined),
  onVoiceServiceAction: vi.fn(() => () => undefined),
}));
// The call's session and clock are native (callTransport.ts); the fake's clock
// is the JS one, so fake timers drive the line.
vi.mock('../src/lib/callTransport', async () =>
  (await import('./testUtils/fakeCallTransport')).fakeCallTransportModule(),
);
const { playCueMock, loopMock } = vi.hoisted(() => ({
  playCueMock: vi.fn(async (_cue: string) => undefined),
  loopMock: vi.fn((_name: string, _on: boolean) => undefined),
}));
vi.mock('../src/lib/callSounds', () => ({
  playCallSound: playCueMock,
  syncCallSoundLoop: loopMock,
}));
/** Whether the last sync left `name` looping. */
function looping(name: string): boolean {
  const calls = loopMock.mock.calls.filter((c) => c[0] === name);
  return calls.length > 0 && calls[calls.length - 1]![1];
}
vi.mock('../src/lib/preferences', () => ({
  addressWordOrNull: () => prefs.addressWord,
  voiceAgentOrNull: () => null,
  pauseWhenQuietMinutes: () => prefs.pauseWhenQuietMinutes,
}));

import { CALL_ACK_TIMEOUT_MS, CALL_RESUME_DELAYS_MS } from '@patch/wire/call-line';
import { CALL_RESUME_WINDOW_MS } from '@patch/wire/audio';
import {
  endVoiceCall,
  retryVoiceCall,
  setCallMode,
  setCallMuted,
  startVoiceCall,
} from '../src/lib/voiceCall';
import { onVoiceServiceAction, startVoiceAudioService } from '../src/lib/voiceAudioService';

async function flush(n = 16): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function stateFrame(state: string): string {
  return JSON.stringify({ type: 'audio.state', sessionId: 'sess-1', state });
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeCallTransport.reset();
  vi.clearAllMocks();
  prefs.addressWord = 'patch';
  prefs.pauseWhenQuietMinutes = 0;
  useVoiceStore.setState({
    activeSession: null,
    callMuted: false,
    callError: null,
    callPhase: 'connecting',
    callTranscriptPartial: '',
    callMode: 'call',
    callConnectedAt: null,
    callReconnectingSince: null,
    callAddressWord: null,
  });
  useUiStore.setState({ errors: [] });
});

afterEach(async () => {
  await endVoiceCall();
  vi.useRealTimers();
});

describe('connecting → failed after the timeout', () => {
  it('stays "connecting" (no error) until the timeout, then fails loudly and releases audio', async () => {
    startVoiceCall('c1');
    await flush();
    FakeCallTransport.last().emitOpen();
    await flush();
    vi.advanceTimersByTime(CALL_ACK_TIMEOUT_MS - 1);
    expect(useVoiceStore.getState().callPhase).toBe('connecting');
    expect(useVoiceStore.getState().callError).toBeNull();

    vi.advanceTimersByTime(1);
    await flush();
    const st = useVoiceStore.getState();
    // The bar's head already says it could not connect; the reason says why.
    expect(st.callError).toBe('no answer from the host after 15s');
    // The bar stays up (activeSession kept) so the error and Retry show.
    expect(st.activeSession).not.toBeNull();
    expect(FakeCallTransport.last().close).toHaveBeenCalled();
    expect(stopVoiceAudioServiceMock).toHaveBeenCalled();
    expect(useUiStore.getState().errors.map((e) => e.message)).toContain(
      'voice call: no answer from the host after 15s',
    );
  });

  it('the host’s first audio.state disarms the timeout and starts the call clock', async () => {
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    expect(useVoiceStore.getState().callConnectedAt).toBeNull();
    vi.setSystemTime(new Date('2026-09-24T10:00:03Z'));
    sock.emitMessage(stateFrame('listening'));
    expect(useVoiceStore.getState().callPhase).toBe('listening');
    expect(useVoiceStore.getState().callConnectedAt).toBe(
      new Date('2026-09-24T10:00:03Z').getTime(),
    );
    vi.advanceTimersByTime(CALL_ACK_TIMEOUT_MS * 2);
    expect(useVoiceStore.getState().callError).toBeNull();
  });

  it('rings while connecting and stops when the line goes live', async () => {
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    expect(looping('connecting')).toBe(true);
    sock.emitMessage(stateFrame('listening'));
    expect(looping('connecting')).toBe(false);
  });

  it('connecting plays from the tap until the provider is ready, then the connected sound', async () => {
    playCueMock.mockClear();
    startVoiceCall('c1');
    // From the tap, before anything has been minted or dialled.
    expect(looping('connecting')).toBe(true);
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    // The host holds the session in `connecting` while the provider sets up
    // (ElevenLabs takes seconds): still ringing, nothing else played.
    sock.emitMessage(stateFrame('connecting'));
    vi.advanceTimersByTime(7_000);
    sock.emitMessage(stateFrame('connecting'));
    expect(looping('connecting')).toBe(true);
    expect(playCueMock).not.toHaveBeenCalled();
    // The provider is ready: the ring stops and the connected sound plays once.
    sock.emitMessage(stateFrame('listening'));
    expect(looping('connecting')).toBe(false);
    expect(playCueMock.mock.calls).toEqual([['connected']]);
  });

  it('stops ringing when the connect times out', async () => {
    startVoiceCall('c1');
    await flush();
    expect(looping('connecting')).toBe(true);
    vi.advanceTimersByTime(CALL_ACK_TIMEOUT_MS);
    await flush();
    expect(looping('connecting')).toBe(false);
  });

  it('plays the connected sound once, when the line first leaves connecting', async () => {
    playCueMock.mockClear();
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    sock.emitMessage(stateFrame('connecting'));
    expect(playCueMock).not.toHaveBeenCalled();
    sock.emitMessage(stateFrame('listening'));
    sock.emitMessage(stateFrame('thinking'));
    expect(playCueMock.mock.calls).toEqual([['connected']]);
  });

  it('plays the error cue once when the call fails, and the ended cue only for a clean hang-up', async () => {
    playCueMock.mockClear();
    startVoiceCall('c1');
    await flush();
    vi.advanceTimersByTime(CALL_ACK_TIMEOUT_MS);
    await flush();
    expect(playCueMock.mock.calls.map((c) => c[0])).toEqual(['failed']);
    await endVoiceCall();
    expect(playCueMock.mock.calls.map((c) => c[0])).toEqual(['failed']);

    playCueMock.mockClear();
    startVoiceCall('c1');
    await flush();
    FakeCallTransport.last().emitOpen();
    await flush();
    FakeCallTransport.last().emitMessage(stateFrame('listening'));
    await endVoiceCall();
    expect(playCueMock.mock.calls.map((c) => c[0])).toEqual(['connected', 'ended']);
  });

  it('a dropped call that redials does not play the error cue', async () => {
    playCueMock.mockClear();
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    sock.emitMessage(stateFrame('listening'));
    sock.emitClose(1006);
    expect(playCueMock).not.toHaveBeenCalledWith('failed');
  });

  it('a dropped call plays reconnecting (not connecting) while it redials, then reconnected', async () => {
    startVoiceCall('c1');
    await flush();
    FakeCallTransport.last().emitOpen();
    await flush();
    FakeCallTransport.last().emitMessage(stateFrame('listening'));
    const connectedAt = useVoiceStore.getState().callConnectedAt;
    playCueMock.mockClear();
    loopMock.mockClear();
    FakeCallTransport.last().emitClose(1006);
    expect(useVoiceStore.getState().callReconnectingSince).not.toBeNull();
    expect(looping('reconnecting')).toBe(true);
    expect(looping('connecting')).toBe(false);
    vi.advanceTimersByTime(CALL_RESUME_DELAYS_MS[0]);
    await flush();
    // The redial is the same call: its timer still counts from the first connect.
    expect(useVoiceStore.getState().callConnectedAt).toBe(connectedAt);
    expect(looping('reconnecting')).toBe(true);
    FakeCallTransport.last().emitOpen();
    await flush();
    FakeCallTransport.last().emitMessage(stateFrame('listening'));
    expect(useVoiceStore.getState().callReconnectingSince).toBeNull();
    expect(looping('reconnecting')).toBe(false);
    expect(playCueMock.mock.calls).toEqual([['reconnected']]);
  });

  it('an agent calling rings until the call is answered or dismissed', () => {
    loopMock.mockClear();
    useVoiceStore
      .getState()
      .setIncoming({ callId: 'k1', chatId: 'c1', message: undefined, receivedAt: 0 });
    expect(looping('agent-calling')).toBe(true);
    useVoiceStore.getState().setIncoming(null);
    expect(looping('agent-calling')).toBe(false);
  });

  it('a setup failure already on screen is not overwritten by the timeout', async () => {
    const { api } = await import('../src/api/rest');
    vi.mocked(api.voiceToken).mockRejectedValueOnce(new Error('token mint failed'));
    startVoiceCall('c1');
    await flush();
    expect(useVoiceStore.getState().callError).toBe('token mint failed');
    vi.advanceTimersByTime(CALL_ACK_TIMEOUT_MS);
    expect(useVoiceStore.getState().callError).toBe('token mint failed');
  });

  it('an ended call’s stale timeout does nothing', async () => {
    startVoiceCall('c1');
    await flush();
    await endVoiceCall();
    vi.advanceTimersByTime(CALL_ACK_TIMEOUT_MS);
    expect(useVoiceStore.getState().activeSession).toBeNull();
    expect(useVoiceStore.getState().callError).toBeNull();
  });
});

describe('a dropped call says so', () => {
  async function liveCall(): Promise<FakeCallTransport> {
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    sock.emitMessage(stateFrame('listening'));
    return sock;
  }

  it('an unexpected socket close mid-call redials by itself, with no banner', async () => {
    startVoiceCall('c1');
    const sock = await liveCall();
    const before = FakeCallTransport.instances.length;
    sock.emitClose(1006);
    expect(useVoiceStore.getState().callError).toBeNull();
    expect(useVoiceStore.getState().callPhase).toBe('connecting');
    vi.advanceTimersByTime(CALL_RESUME_DELAYS_MS[0]);
    await flush();
    expect(FakeCallTransport.instances.length).toBe(before + 1);
    const again = FakeCallTransport.last();
    again.emitOpen();
    await flush();
    again.emitMessage(stateFrame('listening'));
    expect(useVoiceStore.getState().callPhase).toBe('listening');
    expect(useVoiceStore.getState().callError).toBeNull();
  });

  it('a socket error followed by the close still redials a live call', async () => {
    startVoiceCall('c1');
    const sock = await liveCall();
    const before = FakeCallTransport.instances.length;
    sock.emitClose(1006, '', 'Connection reset');
    expect(useVoiceStore.getState().callError).toBeNull();
    expect(useVoiceStore.getState().callPhase).toBe('connecting');
    vi.advanceTimersByTime(CALL_RESUME_DELAYS_MS[0]);
    await flush();
    expect(FakeCallTransport.instances.length).toBe(before + 1);
  });

  it('a redialled call that stays up gets its full attempts again on the next drop', async () => {
    startVoiceCall('c1');
    let sock = await liveCall();
    for (let i = 0; i < CALL_RESUME_DELAYS_MS.length + 1; i++) {
      sock.emitClose(1006);
      vi.advanceTimersByTime(CALL_RESUME_DELAYS_MS[0]);
      await flush();
      sock = FakeCallTransport.last();
      sock.emitOpen();
      await flush();
      sock.emitMessage(stateFrame('listening'));
      expect(useVoiceStore.getState().callError).toBeNull();
    }
  });

  it('the host going away mid-call redials rather than ending the call', async () => {
    startVoiceCall('c1');
    const sock = await liveCall();
    const before = FakeCallTransport.instances.length;
    sock.emitMessage(
      JSON.stringify({
        type: 'audio.error',
        sessionId: 'sess-1',
        code: 'host_unreachable',
        message: 'h1 went offline mid-session',
      }),
    );
    // The server closes the socket behind the error: one drop, one redial.
    sock.emitClose(1011);
    expect(useVoiceStore.getState().callError).toBeNull();
    expect(useVoiceStore.getState().callPhase).toBe('connecting');
    vi.advanceTimersByTime(CALL_RESUME_DELAYS_MS[0]);
    await flush();
    expect(FakeCallTransport.instances.length).toBe(before + 1);
  });

  it('a redial names the session it was last live on so the host can resume it; a first dial does not', async () => {
    startVoiceCall('c1');
    const sock = await liveCall();
    const first = JSON.parse(String(sock.sent[0])) as { resumes?: string };
    expect(first.resumes).toBeUndefined();
    sock.emitClose(1006);
    vi.advanceTimersByTime(CALL_RESUME_DELAYS_MS[0]);
    await flush();
    const again = FakeCallTransport.last();
    again.emitOpen();
    await flush();
    const start = JSON.parse(String(again.sent[0])) as { type: string; resumes?: string };
    expect(start.type).toBe('audio.session_start');
    expect(start.resumes).toEqual(expect.any(String));
  });

  it('a call whose resume window runs out ends with the ended sound, and never dials a new session', async () => {
    startVoiceCall('c1');
    let sock = await liveCall();
    sock.emitClose(1006);
    // Every attempt fails until the window is gone.
    for (let waited = 0; waited < CALL_RESUME_WINDOW_MS; ) {
      const delay = CALL_RESUME_DELAYS_MS[0]!;
      vi.advanceTimersByTime(delay);
      waited += delay;
      await flush();
      sock = FakeCallTransport.last();
      sock.emitClose(1006);
    }
    vi.advanceTimersByTime(CALL_RESUME_WINDOW_MS);
    await flush();
    expect(useVoiceStore.getState().activeSession).toBeNull();
    expect(playCueMock).toHaveBeenCalledWith('ended');
    const before = FakeCallTransport.instances.length;
    vi.advanceTimersByTime(10 * CALL_RESUME_WINDOW_MS);
    await flush();
    expect(FakeCallTransport.instances.length).toBe(before);
    // Every dial after the first named the session to resume, never a fresh one.
    const starts = FakeCallTransport.instances
      .map((t) => t.sent[0])
      .filter((f) => f !== undefined)
      .map((f) => JSON.parse(String(f)) as { resumes?: string });
    expect(starts.slice(1).every((x) => typeof x.resumes === 'string')).toBe(true);
  });

  it('opening the app does not dial: only the resume schedule does', async () => {
    startVoiceCall('c1');
    const sock = await liveCall();
    sock.emitClose(1006);
    const before = FakeCallTransport.instances.length;
    __emitAppStateChange('active');
    await flush();
    expect(FakeCallTransport.instances.length).toBe(before);
  });

  it('ending the call while waiting to redial cancels the redial', async () => {
    startVoiceCall('c1');
    const sock = await liveCall();
    sock.emitClose(1006);
    const before = FakeCallTransport.instances.length;
    await endVoiceCall();
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(FakeCallTransport.instances.length).toBe(before);
    expect(useVoiceStore.getState().activeSession).toBeNull();
  });

  it('a call that never went live still fails straight away on close', async () => {
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    sock.emitClose(1006);
    expect(useVoiceStore.getState().callError).toBe('Call dropped — the audio connection closed');
  });

  it('a close after an error the host reported keeps the real reason, and does not redial', async () => {
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    sock.emitMessage(stateFrame('listening'));
    sock.emitMessage(
      JSON.stringify({
        type: 'audio.error',
        code: 'kokoro_unavailable',
        message: 'kokoro missing',
      }),
    );
    const reason = useVoiceStore.getState().callError;
    expect(reason).toContain('kokoro missing');
    const before = FakeCallTransport.instances.length;
    sock.emitClose(1011);
    vi.advanceTimersByTime(CALL_RESUME_DELAYS_MS[0]!);
    await flush();
    // The host ends the call behind an error it reported: no redial, same reason.
    expect(useVoiceStore.getState().callError).toBe(reason);
    expect(FakeCallTransport.instances.length).toBe(before);
  });

  it('hanging up is not a drop — no error', async () => {
    startVoiceCall('c1');
    await flush();
    FakeCallTransport.last().emitOpen();
    await flush();
    await endVoiceCall();
    expect(useVoiceStore.getState().activeSession).toBeNull();
    expect(useVoiceStore.getState().callError).toBeNull();
  });
});

describe('retryVoiceCall', () => {
  it('reopens the same chat in the same mode, back in a clean connecting state', async () => {
    startVoiceCall('c7', 'hands-free');
    await flush();
    vi.advanceTimersByTime(CALL_ACK_TIMEOUT_MS);
    await flush();
    expect(useVoiceStore.getState().callError).not.toBeNull();
    const before = FakeCallTransport.instances.length;

    await retryVoiceCall();
    const st = useVoiceStore.getState();
    expect(st.activeSession?.chatId).toBe('c7');
    expect(st.callMode).toBe('hands-free');
    expect(st.callError).toBeNull();
    expect(st.callPhase).toBe('connecting');
    await flush();
    expect(FakeCallTransport.instances.length).toBe(before + 1);
  });

  it('with no call open it does nothing', async () => {
    await retryVoiceCall();
    expect(useVoiceStore.getState().activeSession).toBeNull();
  });
});

describe('address word', () => {
  it('records the address word the session opened with', () => {
    startVoiceCall('c1', 'hands-free');
    expect(useVoiceStore.getState().callAddressWord).toBe('patch');
  });

  it('records null when the preferences have not loaded', () => {
    prefs.addressWord = null;
    startVoiceCall('c1', 'hands-free');
    expect(useVoiceStore.getState().callAddressWord).toBeNull();
  });
});

describe('a setup superseded while its audio service starts', () => {
  it('lets go of the notification-button listener it had just taken', async () => {
    const unsubscribe = vi.fn();
    vi.mocked(onVoiceServiceAction).mockReturnValueOnce(unsubscribe);
    let finishService!: () => void;
    vi.mocked(startVoiceAudioService).mockImplementationOnce(
      () =>
        new Promise<void>((res) => {
          finishService = res;
        }),
    );
    startVoiceCall('c1');
    await flush();
    // The connect watchdog (or the user ending the call) ends this attempt
    // while the foreground service is still coming up.
    vi.advanceTimersByTime(CALL_ACK_TIMEOUT_MS);
    await flush();
    finishService();
    await flush(20);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('ending a call whose audio service will not stop', () => {
  it('still ends it — the bar goes — and says what did not stop', async () => {
    startVoiceCall('c1');
    await flush();
    FakeCallTransport.last().emitOpen();
    await flush();
    stopVoiceAudioServiceMock.mockRejectedValueOnce(new Error('service not running'));

    await endVoiceCall();

    expect(useVoiceStore.getState().activeSession).toBeNull();
    expect(useUiStore.getState().errors.map((e) => e.message)).toContain(
      'voice call: audio service did not stop: service not running',
    );
  });
});

describe('switching mode while the call is still connecting', () => {
  it('opens the session in the mode now showing, and starts the audio service in it', async () => {
    startVoiceCall('c1', 'call');
    // The bar is up at once, so the user can flip to hands-free before the socket opens.
    setCallMode('hands-free');
    expect(useVoiceStore.getState().callMode).toBe('hands-free');
    await flush();
    FakeCallTransport.last().emitOpen();
    await flush();

    const start = JSON.parse(String(FakeCallTransport.last().sent[0])) as { mode: string };
    expect(start.mode).toBe('hands-free');
    expect(startVoiceAudioService).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ mode: 'hands-free' }),
    );
  });
});

describe('a call that timed out while still minting its token', () => {
  it('stays failed when the token finally arrives: no socket, no audio service, no mic', async () => {
    const { api } = await import('../src/api/rest');
    let resolveToken!: (v: Awaited<ReturnType<typeof api.voiceToken>>) => void;
    vi.mocked(api.voiceToken).mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveToken = res;
        }),
    );
    startVoiceCall('c1');
    await flush();
    vi.advanceTimersByTime(CALL_ACK_TIMEOUT_MS);
    await flush();
    expect(useVoiceStore.getState().callError).toMatch(/no answer from the host/);

    resolveToken({ token: 'tok1', sessionId: 'sess-1', audioUrl: '/audio/sess-1', expiresAt: 0 });
    await flush(20);

    expect(FakeCallTransport.instances).toHaveLength(0);
    expect(startVoiceAudioService).not.toHaveBeenCalled();
    // Still failed, with its error showing for Retry.
    expect(useVoiceStore.getState().callError).toMatch(/no answer from the host/);
    expect(useVoiceStore.getState().activeSession).not.toBeNull();
  });
});

describe('muting while the call is still connecting', () => {
  it('stays muted once the session goes live, and the audio service is told so', async () => {
    startVoiceCall('c1');
    // The bar is up at once; the user mutes while the token mints and the mic warms.
    setCallMuted(true);
    expect(useVoiceStore.getState().callMuted).toBe(true);
    await flush();
    FakeCallTransport.last().emitOpen();
    await flush();

    expect(useVoiceStore.getState().activeSession?.sessionId).toBe('sess-1');
    expect(useVoiceStore.getState().callMuted).toBe(true);
    expect(startVoiceAudioService).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ muted: true }),
    );
  });
});

describe('the line under a call (heartbeat and call log)', () => {
  function heartbeat(n: number, rttMs?: number): string {
    return JSON.stringify({
      type: 'audio.heartbeat',
      sessionId: 'sess-1',
      n,
      ...(rttMs !== undefined ? { rttMs } : {}),
    });
  }
  function sentFrames(sock: FakeCallTransport): Array<Record<string, unknown>> {
    return sock.sent.map((d) => JSON.parse(d) as Record<string, unknown>);
  }
  async function liveCall(): Promise<FakeCallTransport> {
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    sock.emitMessage(stateFrame('listening'));
    return sock;
  }

  it('three seconds without a heartbeat is a drop that redials (the echo is native)', async () => {
    const sock = await liveCall();
    sock.emitMessage(heartbeat(0));
    // CallTransport.kt answers the heartbeat; JS sends nothing for it.
    expect(sentFrames(sock).filter((f) => f.type === 'audio.heartbeat')).toEqual([]);
    const before = FakeCallTransport.instances.length;
    vi.advanceTimersByTime(3_000);
    expect(sock.close).toHaveBeenCalled();
    expect(useVoiceStore.getState().callReconnectingSince).not.toBeNull();
    expect(useVoiceStore.getState().callError).toBeNull();
    vi.advanceTimersByTime(CALL_RESUME_DELAYS_MS[0]!);
    await flush();
    expect(FakeCallTransport.instances.length).toBe(before + 1);
  });

  it('a live line that hears nothing for three seconds after the host answered is dropped too', async () => {
    const sock = await liveCall();
    vi.advanceTimersByTime(2_999);
    expect(sock.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sock.close).toHaveBeenCalled();
    expect(useVoiceStore.getState().callReconnectingSince).not.toBeNull();
  });

  it('sends the log of the drop once the line is back, and the rest when the call ends', async () => {
    const sock = await liveCall();
    sock.emitMessage(heartbeat(0, 42));
    // The phone's own audio events go into the log.
    sock.emitAudioStopped('audio_focus_taken', 'AUDIOFOCUS_LOSS_TRANSIENT');
    // A turn's steps are timed from the frames.
    sock.emitMessage(stateFrame('transcribing'));
    vi.advanceTimersByTime(200);
    sock.emitMessage(
      JSON.stringify({ type: 'audio.transcript_final', sessionId: 'sess-1', text: 'hi' }),
    );
    vi.advanceTimersByTime(500);
    sock.emitReplyAudio(4);
    vi.advanceTimersByTime(800);
    sock.emitMessage(JSON.stringify({ type: 'audio.tts_end', sessionId: 'sess-1' }));
    sock.emitMessage(heartbeat(1, 40));
    sock.emitClose(1006);
    vi.advanceTimersByTime(CALL_RESUME_DELAYS_MS[0]!);
    await flush();
    const again = FakeCallTransport.last();
    again.emitOpen();
    await flush();
    // The log of the drop goes as soon as the host answers the redial.
    again.emitMessage(stateFrame('listening'));
    const [log] = sentFrames(again).filter((f) => f.type === 'audio.call_log');
    const entries = log?.entries as Array<Record<string, unknown>>;
    expect(entries.map((e) => [e.kind, e.reason])).toEqual([
      ['audio_stopped', 'audio_focus_taken'],
      ['turn', undefined],
      ['audio_stopped', 'connection_closed'],
      ['quality', undefined],
      ['reconnected', undefined],
    ]);
    expect(entries[1]).toMatchObject({ speechToTextMs: 200, modelMs: 500, voiceMs: 800 });
    expect(entries[3]).toMatchObject({ heartbeats: 2, rttMs: { min: 40, avg: 41, max: 42 } });
    await endVoiceCall();
    const frames = sentFrames(again);
    const endLog = frames.filter((f) => f.type === 'audio.call_log').at(-1);
    expect((endLog?.entries as Array<{ kind: string }>).map((e) => e.kind)).toEqual(['quality']);
    // The log goes before the session is ended.
    expect(frames.at(-1)?.type).toBe('audio.session_end');
  });
});

describe('errors the host ends the call on', () => {
  it('a silent microphone fails the call with what to do about it, and is not redialled', async () => {
    startVoiceCall('c1');
    await flush();
    const sock = FakeCallTransport.last();
    sock.emitOpen();
    await flush();
    sock.emitMessage(stateFrame('listening'));
    sock.emitMessage(
      JSON.stringify({ type: 'audio.error', code: 'mic_silent', message: 'no audio for 5s' }),
    );
    expect(useVoiceStore.getState().callError).toBe('no audio for 5s');
    await flush(40);
    expect(useVoiceStore.getState().callError).not.toBeNull();
    const before = FakeCallTransport.instances.length;
    sock.emitClose(1011);
    vi.advanceTimersByTime(CALL_RESUME_DELAYS_MS[0]!);
    await flush();
    expect(FakeCallTransport.instances.length).toBe(before);
  });
});
