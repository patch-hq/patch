// lib/speakInterrupt.ts — an `auto-notify` interrupt spoken with no session
// open. One at a time: a second replaces the first, and neither the replaced
// one's socket nor a finished one can end a session that is not theirs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeWebSocket, restoreWebSocket, FakeWebSocket } from './testUtils/fakeWebSocket';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useUiStore } from '../src/stores/uiStore';

const { meMock, voiceTokenMock } = vi.hoisted(() => ({
  meMock: vi.fn(),
  voiceTokenMock: vi.fn(),
}));
vi.mock('../src/api/rest', () => ({ api: { me: meMock, voiceToken: voiceTokenMock } }));

const { startTtsMock, stopTtsMock, writeTtsMock } = vi.hoisted(() => ({
  startTtsMock: vi.fn(async () => undefined),
  stopTtsMock: vi.fn(async () => undefined),
  writeTtsMock: vi.fn(),
}));
vi.mock('../src/lib/voiceTts', () => ({
  startTtsPlayback: startTtsMock,
  stopTtsPlayback: stopTtsMock,
  writeTtsPcm: writeTtsMock,
}));

import { speakInterrupt } from '../src/lib/speakInterrupt';

async function flush(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

let tokenSeq = 0;
beforeEach(() => {
  installFakeWebSocket();
  vi.clearAllMocks();
  tokenSeq = 0;
  meMock.mockResolvedValue({
    account: { accountId: 'acc1', userPublicKey: 'k', createdAt: 0 },
    surface: { surfaceId: 'surf1', surfaceKind: 'mobile', label: 'l', issuedAt: 0 },
  });
  voiceTokenMock.mockImplementation(async () => {
    tokenSeq += 1;
    return {
      token: `t${tokenSeq}`,
      sessionId: `s${tokenSeq}`,
      audioUrl: `/audio/s${tokenSeq}`,
      expiresAt: 0,
    };
  });
  useVoiceStore.setState({ activeSession: null });
  useUiStore.setState({ errors: [] });
});

afterEach(() => {
  restoreWebSocket();
});

describe('speakInterrupt', () => {
  it('speaks the message on its own session', async () => {
    speakInterrupt('c1', 'the bus is late');
    await flush();
    const ws = FakeWebSocket.last();
    ws.emitOpen();
    const sent = ws.sent.map((s) => JSON.parse(String(s)) as { type: string; text?: string });
    expect(sent.map((f) => f.type)).toEqual(['audio.session_start', 'audio.speak']);
    expect(sent[1]!.text).toBe('the bus is late');
  });

  it('does nothing while a call is open (the host speaks into it)', async () => {
    useVoiceStore.setState({
      activeSession: { sessionId: 's', chatId: 'c1', audioUrl: '/a', startedAt: 0 },
    });
    speakInterrupt('c1', 'x');
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('a second interrupt replaces the first: the first socket closing does not end the second', async () => {
    speakInterrupt('c1', 'first');
    await flush();
    const first = FakeWebSocket.last();
    first.emitOpen();

    speakInterrupt('c1', 'second');
    await flush();
    const second = FakeWebSocket.last();
    expect(second).not.toBe(first);
    second.emitOpen();
    expect(first.close).toHaveBeenCalled();

    // The replaced session's socket reports its close AFTER the new one is up.
    first.emitClose();
    await flush();
    expect(second.close).not.toHaveBeenCalled();
  });

  it('two interrupts started together leave one live socket', async () => {
    speakInterrupt('c1', 'a');
    speakInterrupt('c1', 'b');
    await flush(30);
    const live = FakeWebSocket.instances.filter((w) => w.readyState !== FakeWebSocket.CLOSED);
    expect(live).toHaveLength(1);
  });

  it('a finished interrupt does not stop the sink or audio mode of a call that has since started', async () => {
    speakInterrupt('c1', 'x');
    await flush();
    const ws = FakeWebSocket.last();
    ws.emitOpen();
    // A call comes up while the interrupt is still speaking.
    useVoiceStore.setState({
      activeSession: { sessionId: 'call', chatId: 'c1', audioUrl: '/a', startedAt: 0 },
    });
    stopTtsMock.mockClear();

    ws.emitMessage(JSON.stringify({ type: 'audio.tts_end', sessionId: 's1' }));
    await flush();

    expect(stopTtsMock).not.toHaveBeenCalled();
  });

  it('an interrupt still minting its token when a call starts gives way: no socket, no sink, no audio mode', async () => {
    let resolveToken!: (v: Awaited<ReturnType<typeof voiceTokenMock>>) => void;
    voiceTokenMock.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveToken = res;
        }),
    );
    speakInterrupt('c1', 'x');
    await flush();
    // The user starts a call meanwhile.
    useVoiceStore.setState({
      activeSession: { sessionId: 'call', chatId: 'c1', audioUrl: '/a', startedAt: 0 },
    });
    resolveToken({ token: 't', sessionId: 's', audioUrl: '/audio/s', expiresAt: 0 });
    await flush(30);

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(startTtsMock).not.toHaveBeenCalled();
  });
});
