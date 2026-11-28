// A call's session outlives its connection (spec/07 § A dropped call comes
// back). When the device's line goes quiet the host keeps the session — its
// provider conversation, open hand-offs and pending pushes — for the resume
// window, and the device's redial puts a new connection back on it. Real
// sockets; the Gemini end is an in-memory fake. Time is faked, the sockets
// are not.

import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import { fakeVoiceAgent } from './helpers/fakeVoiceAgent.js';
import { startAudioServer, type AudioServerHandle } from '../src/audio/server.js';
import { createWhisper } from '../src/audio/whisper.js';
import { createKokoro } from '../src/audio/kokoro.js';
import { MockVad } from '../src/audio/vad.js';
import {
  CALL_RESUME_WINDOW_MS,
  decodeAudio,
  encodeAudio,
  type AudioEvent,
} from '@patch/wire/audio';

const SECRET = 'unit-test-internal-token-aaaaaaaaaa';
const logger = pino({ level: 'silent' });

class FakeGemini extends EventEmitter {
  sent: string[] = [];
  constructor(public readonly url: string) {
    super();
  }
  send(data: string): void {
    this.sent.push(data);
    if ((JSON.parse(data) as { setup?: unknown }).setup) {
      queueMicrotask(() => this.emit('message', JSON.stringify({ setupComplete: {} }), false));
    }
  }
  close(): void {}
  said(text: string): boolean {
    return this.sent.some((s) => s.includes(text));
  }
}

function mintToken(sessionId: string): string {
  const claims = Buffer.from(
    JSON.stringify({
      accountId: 'a',
      surfaceId: 'phone',
      sessionId,
      chatId: 'c1',
      exp: Date.now() + 600_000,
      jti: `jti-${sessionId}`,
    }),
    'utf8',
  ).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(claims).digest().toString('base64url');
  return `${claims}.${sig}`;
}

/** Let real socket I/O run; the fake clock does not move. */
async function io(until: () => boolean = () => false): Promise<void> {
  for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setImmediate(r));
}

interface Device {
  ws: WebSocket;
  frames: AudioEvent[];
  closed: boolean;
}

let server: (AudioServerHandle & { port: number }) | undefined;
let geminis: FakeGemini[] = [];
let announced: Array<{ sessionId: string; active: boolean; resumed?: boolean }> = [];
let ended: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.useRealTimers();
});

async function start(): Promise<void> {
  geminis = [];
  announced = [];
  ended = [];
  const agent = fakeVoiceAgent();
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
    ...agent,
    geminiWsCtor: function (url: string): FakeGemini {
      const g = new FakeGemini(url);
      queueMicrotask(() => g.emit('open'));
      geminis.push(g);
      return g;
    } as unknown as new (url: string) => WsSocket,
    onCallSession: (info) => announced.push(info),
    onCallEnded: (info) => ended.push(info.init.sessionId),
  });
  server = Object.assign(handle, { port: handle.address().port });
}

/** Dial as the phone does; `resumes` names the session a redial wants back. */
async function dial(sessionId: string, resumes?: string): Promise<Device> {
  const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/audio/${sessionId}`);
  const device: Device = { ws, frames: [], closed: false };
  ws.on('message', (data, isBinary) => {
    if (!isBinary) device.frames.push(decodeAudio(data.toString()));
  });
  ws.on('close', () => {
    device.closed = true;
  });
  let open = false;
  ws.once('open', () => {
    open = true;
  });
  await io(() => open);
  ws.send(
    encodeAudio({
      type: 'audio.session_start',
      sessionId,
      accountId: 'a',
      surfaceId: 'phone',
      surfaceKind: 'mobile',
      chatId: 'c1',
      role: 'voice-call',
      token: mintToken(sessionId),
      surfaceHasAec: true,
      mode: 'call',
      ...(resumes !== undefined ? { resumes } : {}),
    }),
  );
  await io(() => device.frames.length > 0);
  return device;
}

/** The device stops answering for `ms`: the host judges the line lost and holds the call. */
async function stall(device: Device, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await io(() => device.closed);
  expect(device.closed).toBe(true);
}

describe('a dropped call is held and resumed', () => {
  test.each([5_000, 20_000])(
    'a %i ms silence keeps the session, and the redial resumes it with the answer owed',
    async (silenceMs) => {
      await start();
      const first = await dial('s1');
      expect(geminis).toHaveLength(1);
      await stall(first, silenceMs);

      // Held, not ended: still the same call, nothing announced as over.
      expect(server!.sessionById('s1')).toBeDefined();
      expect(announced.map((c) => c.active)).toEqual([true]);
      expect(ended).toEqual([]);

      // An answer arrives while the line is down: it waits, it is not said to nobody.
      server!.sessionById('s1')!.pushMessage('Answer from the chat: milk added', {
        handoffSettled: false,
      });
      await io();
      expect(geminis[0]!.said('milk added')).toBe(false);

      const second = await dial('s2', 's1');
      // The same provider conversation: no new Gemini socket, no new start context.
      expect(geminis).toHaveLength(1);
      expect(geminis[0]!.sent.filter((s) => s.includes('"setup"'))).toHaveLength(1);
      // The device is told the line is back by a turn state, and the call was never re-announced.
      expect(second.frames.some((f) => f.type === 'audio.state' && f.sessionId === 's1')).toBe(
        true,
      );
      expect(announced.map((c) => c.active)).toEqual([true]);
      // The answer owed is delivered now the line is back.
      await io(() => geminis[0]!.said('milk added'));
      expect(geminis[0]!.said('milk added')).toBe(true);
      expect(ended).toEqual([]);

      // The resumed connection is the session's line: it is heartbeated and ends the call on session_end.
      second.ws.send(encodeAudio({ type: 'audio.session_end' }));
      await io(() => ended.length > 0);
      expect(ended).toEqual(['s1']);
      expect(server!.sessionById('s1')).toBeUndefined();
    },
  );

  test('the window running out ends the call; a redial after it opens a new session, announced as resumed', async () => {
    await start();
    const first = await dial('s1');
    await stall(first, 5_000);
    await vi.advanceTimersByTimeAsync(CALL_RESUME_WINDOW_MS);
    expect(server!.sessionById('s1')).toBeUndefined();
    expect(ended).toEqual(['s1']);
    expect(announced.map((c) => c.active)).toEqual([true, false]);

    await dial('s2', 's1');
    expect(geminis).toHaveLength(2);
    expect(announced.at(-1)).toMatchObject({ sessionId: 's2', active: true, resumed: true });
  });

  test('the user ending the call ends it at once: it is not held', async () => {
    await start();
    const d = await dial('s1');
    d.ws.send(encodeAudio({ type: 'audio.session_end' }));
    await io(() => ended.length > 0);
    expect(ended).toEqual(['s1']);
    expect(server!.sessionById('s1')).toBeUndefined();
  });

  test('a redial that gets in before the host has judged the old line gone takes the session over', async () => {
    await start();
    const first = await dial('s1');
    const second = await dial('s2', 's1');
    expect(geminis).toHaveLength(1);
    expect(second.frames.some((f) => f.type === 'audio.state' && f.sessionId === 's1')).toBe(true);
    await io(() => first.closed);
    // The old connection closing is not a drop of the session it no longer carries.
    expect(server!.sessionById('s1')).toBeDefined();
    expect(ended).toEqual([]);
  });

  test('a held call is ended by the agent hanging up', async () => {
    await start();
    const first = await dial('s1');
    await stall(first, 5_000);
    server!.endSession('s1');
    expect(ended).toEqual(['s1']);
    expect(server!.sessionById('s1')).toBeUndefined();
  });
});
