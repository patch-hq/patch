// The line under an app call (spec/07 § A dropped call comes back, § Call logs):
// the host's heartbeat, the round trip it measures from the surface's echo,
// and the surface's call log kept in the host's own log.

import { describe, test, expect, afterEach } from 'vitest';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { DEFAULT_VOICE_INSTRUCTIONS } from '@patch/wire';
import { fakeVoiceAgentLink } from './helpers/fakeVoiceAgentLink.js';
import { startAudioServer, type AudioServerHandle } from '../src/audio/server.js';
import { startCallHeartbeat } from '../src/audio/call-heartbeat.js';
import { createWhisper } from '../src/audio/whisper.js';
import { createKokoro } from '../src/audio/kokoro.js';
import { decodeAudio, encodeAudio, type AudioEvent } from '@patch/wire/audio';
import { MockVad } from '../src/audio/vad.js';

const SECRET = 'unit-test-internal-token-aaaaaaaaaa';
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function mintToken(c: { surfaceId: string; sessionId: string; chatId: string }): string {
  const claims = Buffer.from(
    JSON.stringify({
      accountId: 'a',
      surfaceId: c.surfaceId,
      sessionId: c.sessionId,
      chatId: c.chatId,
      exp: Date.now() + 60_000,
      jti: `jti-${c.sessionId}`,
    }),
    'utf8',
  ).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(claims).digest().toString('base64url');
  return `${claims}.${sig}`;
}

let server: (AudioServerHandle & { port: number }) | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(): Promise<{ port: number; logs: Array<Record<string, unknown>> }> {
  const logs: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: 'info' },
    { write: (s: string) => logs.push(JSON.parse(s) as Record<string, unknown>) },
  );
  const handle = await startAudioServer({
    host: '127.0.0.1',
    port: 0,
    logger,
    internalToken: SECRET,
    whisper: createWhisper({ backend: 'mock', logger }),
    kokoro: createKokoro({ backend: 'mock', logger }),
    makeVad: () => new MockVad(),
    submitUserTurn: async () => 'ok',
    chatExists: () => true,
    // A call is a voice agent call (spec/07 § Two kinds of call): an in-memory
    // Gemini Live stands in for the provider.
    geminiApiKey: 'g-key',
    voiceAgentLink: fakeVoiceAgentLink().link,
    getVoiceInstructions: () => DEFAULT_VOICE_INSTRUCTIONS,
    makeTimeline: () => ({
      userSaid() {},
      beginReply: () => ({ append() {}, finish() {}, text: () => '' }),
    }),
    geminiWsCtor: function () {
      const inst = Object.assign(new EventEmitter(), {
        send(data: string): void {
          if ((JSON.parse(data) as { setup?: unknown }).setup) {
            queueMicrotask(() =>
              inst.emit('message', JSON.stringify({ setupComplete: {} }), false),
            );
          }
        },
        close(): void {},
      });
      queueMicrotask(() => inst.emit('open'));
      return inst;
    } as never,
    heartbeatIntervalMs: 20,
  });
  server = Object.assign(handle, { port: handle.address().port });
  return { port: server.port, logs };
}

async function open(
  port: number,
  role: 'voice-call' | 'voice-note',
): Promise<{ ws: WebSocket; frames: AudioEvent[] }> {
  const sessionId = role === 'voice-call' ? 's1' : 'n1';
  const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${sessionId}`);
  const frames: AudioEvent[] = [];
  ws.on('message', (data, isBinary) => {
    if (!isBinary) frames.push(decodeAudio(data.toString()));
  });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  ws.send(
    encodeAudio({
      type: 'audio.session_start',
      sessionId,
      accountId: 'a',
      surfaceId: 'phone',
      surfaceKind: 'mobile',
      chatId: 'c1',
      role,
      token: mintToken({ surfaceId: 'phone', sessionId, chatId: 'c1' }),
      surfaceHasAec: true,
      ...(role === 'voice-call' ? { mode: 'call' as const } : {}),
    }),
  );
  return { ws, frames };
}

const beats = (frames: AudioEvent[]): Extract<AudioEvent, { type: 'audio.heartbeat' }>[] =>
  frames.filter((f) => f.type === 'audio.heartbeat');

describe('call heartbeat', () => {
  test('an app call hears a numbered heartbeat, and the echo comes back as the round trip', async () => {
    const { port, logs } = await start();
    const { ws, frames } = await open(port, 'voice-call');
    await wait(70);
    const first = beats(frames);
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(first.map((b) => b.n)).toEqual(first.map((_, i) => i));
    expect(first[0]).toEqual({ type: 'audio.heartbeat', sessionId: 's1', n: 0 });
    for (const b of first)
      ws.send(encodeAudio({ type: 'audio.heartbeat', sessionId: 's1', n: b.n }));
    await wait(60);
    expect(beats(frames).at(-1)?.rttMs).toEqual(expect.any(Number));
    ws.close();
    await wait(60);
    const ended = logs.find((l) => l.msg === 'audio: session ended');
    expect(ended?.heartbeat).toMatchObject({
      sent: expect.any(Number),
      echoed: first.length,
      rttMs: { min: expect.any(Number), avg: expect.any(Number), max: expect.any(Number) },
    });
  });

  test('a voice note gets no heartbeat', async () => {
    const { port } = await start();
    const { ws, frames } = await open(port, 'voice-note');
    await wait(70);
    expect(beats(frames)).toEqual([]);
    // A stray echo on a session with no heartbeat changes nothing.
    ws.send(encodeAudio({ type: 'audio.heartbeat', sessionId: 'n1', n: 0 }));
    await wait(30);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("the surface's call log goes into the host's log, and into the session's closing log", async () => {
    const { port, logs } = await start();
    const { ws } = await open(port, 'voice-call');
    await wait(30);
    const entries = [
      {
        kind: 'audio_stopped' as const,
        at: 1,
        sessionId: 's0',
        reason: 'audio_focus_taken' as const,
        detail: 'AUDIOFOCUS_LOSS',
      },
      { kind: 'reconnected' as const, at: 2, sessionId: 's1', downMs: 4000, attempts: 2 },
    ];
    ws.send(encodeAudio({ type: 'audio.call_log', sessionId: 's1', entries, dropped: 3 }));
    await wait(30);
    expect(logs.find((l) => l.msg === 'audio: call log')).toMatchObject({
      sessionId: 's1',
      surfaceKind: 'mobile',
      entries,
      dropped: 3,
    });
    ws.send(encodeAudio({ type: 'audio.call_log', sessionId: 's1', entries: [entries[1]!] }));
    ws.close();
    await wait(60);
    const ended = logs.find((l) => l.msg === 'audio: session ended');
    expect(ended?.callLog).toEqual([...entries, entries[1]]);
  });
});

describe('startCallHeartbeat', () => {
  test('an echo for a heartbeat it never sent, or one long forgotten, is ignored', () => {
    let t = 0;
    const sent: number[] = [];
    const hb = startCallHeartbeat(
      's',
      (f) => sent.push(f.n),
      60_000,
      () => t,
    );
    t = 25;
    hb.echoed(7);
    expect(hb.stats()).toEqual({ sent: 1, echoed: 0 });
    hb.echoed(0);
    hb.echoed(0);
    expect(hb.stats()).toEqual({ sent: 1, echoed: 1, rttMs: { min: 25, avg: 25, max: 25 } });
    hb.stop();
  });

  test('only the last few unanswered heartbeats wait for an echo', async () => {
    const hb = startCallHeartbeat('s', () => undefined, 1);
    await wait(80);
    hb.stop();
    expect(hb.stats().sent).toBeGreaterThan(31);
    hb.echoed(0);
    expect(hb.stats().echoed).toBe(0);
    hb.echoed(hb.stats().sent - 1);
    expect(hb.stats().echoed).toBe(1);
  });
});
