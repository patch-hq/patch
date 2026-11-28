// lib/voiceCall.ts — pausing a call (spec/07 § Pause): one paused state reached
// from the button, the headphones coming out and the silence timeout; and an
// agent's call opening with its reason. Same harness as voiceCall.test.ts.
// The call's native session is the FakeCallTransport double.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeCallTransport } from './testUtils/fakeCallTransport';
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

type Frame = { type: string; [k: string]: unknown };
const frames = (ws: FakeCallTransport): Frame[] => ws.sent.map((d) => JSON.parse(d) as Frame);

/** Start a call and bring it live (the host's first state). */
async function live(
  opts: Parameters<typeof import('../src/lib/voiceCall').startVoiceCall>[2] = {},
  mode: 'call' | 'hands-free' = 'call',
): Promise<FakeCallTransport> {
  const { startVoiceCall } = await import('../src/lib/voiceCall');
  startVoiceCall('c1', mode, opts);
  await flush();
  const ws = FakeCallTransport.last();
  ws.emitOpen();
  await flush();
  ws.emitMessage(JSON.stringify({ type: 'audio.state', sessionId: 'sess-1', state: 'listening' }));
  return ws;
}

beforeEach(() => {
  prefs.quiet = 0;
  cues.played = [];
  FakeCallTransport.reset();
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
    const before = FakeCallTransport.instances.length;
    pauseVoiceCall();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeCallTransport.instances.length).toBe(before);
    expect(useVoiceStore.getState().callError).toBeNull();
  });

  it('resume opens a new session on the same chat — not a redial — and retakes the audio', async () => {
    await live({}, 'hands-free');
    const { pauseVoiceCall, resumeVoiceCall } = await import('../src/lib/voiceCall');
    pauseVoiceCall();
    startVoiceAudioServiceMock.mockClear();
    resumeVoiceCall();
    await flush();
    const ws = FakeCallTransport.last();
    ws.emitOpen();
    await flush();
    const start = frames(ws).find((f) => f.type === 'audio.session_start')!;
    expect(start).toMatchObject({ chatId: 'c1', mode: 'hands-free' });
    expect(start['resumes']).toBeUndefined();
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
    const before = FakeCallTransport.instances.length;
    serviceActionHandler!('resume');
    await flush();
    expect(FakeCallTransport.instances.length).toBe(before + 1);
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
    const before = FakeCallTransport.instances.length;
    serviceActionHandler!('headset_added');
    await flush();
    expect(FakeCallTransport.instances.length).toBe(before + 1);
    expect(useVoiceStore.getState().callPaused).toBeNull();
  });

  it('a call paused from the button stays paused when headphones go in', async () => {
    await live();
    const { pauseVoiceCall } = await import('../src/lib/voiceCall');
    pauseVoiceCall();
    const before = FakeCallTransport.instances.length;
    serviceActionHandler!('headset_added');
    await flush();
    expect(FakeCallTransport.instances.length).toBe(before);
    expect(useVoiceStore.getState().callPaused).toBe('button');
  });
});

describe('pause when quiet', () => {
  it('pauses a call after the set time with nothing said, and not before', async () => {
    vi.useFakeTimers();
    prefs.quiet = 5;
    await live();
    // The host keeps heartbeating a quiet call: the line stays up for the whole wait.
    let n = 0;
    const quietFor = async (ms: number): Promise<void> => {
      for (let t = 0; t < ms; t += 1_000) {
        FakeCallTransport.last().emitMessage(
          JSON.stringify({ type: 'audio.heartbeat', sessionId: 'sess-1', n: n++ }),
        );
        await vi.advanceTimersByTimeAsync(1_000);
      }
    };
    await quietFor(4 * 60_000);
    FakeCallTransport.last().emitMessage(
      JSON.stringify({ type: 'audio.transcript_partial', sessionId: 'sess-1', text: 'hm' }),
    );
    await quietFor(4 * 60_000);
    expect(useVoiceStore.getState().callPaused).toBeNull();
    await quietFor(60_000);
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
    const again = FakeCallTransport.last();
    expect(again).not.toBe(ws);
    again.emitOpen();
    await flush();
    const start = frames(again).find((f) => f.type === 'audio.session_start')!;
    expect(start['resumes']).toEqual(expect.any(String));
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
