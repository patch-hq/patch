// A call moving between devices (spec/07 § A call can move between devices):
// the host announces each live `call` session, and a session opened with
// `takeOver` closes the chat's other call sessions first.

import { describe, test, expect, afterEach } from 'vitest';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { startAudioServer, type AudioServerHandle } from '../src/audio/server.js';
import { createWhisper } from '../src/audio/whisper.js';
import { createKokoro } from '../src/audio/kokoro.js';
import { encodeAudio } from '@patch/wire/audio';
import { MockVad } from '../src/audio/vad.js';

const SECRET = 'unit-test-internal-token-aaaaaaaaaa';
const logger = pino({ level: 'silent' });
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

interface CallInfo {
  sessionId: string;
  surfaceId: string;
  surfaceKind: string;
  chatId: string;
  active: boolean;
}

let server: (AudioServerHandle & { port: number }) | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(calls: CallInfo[]): Promise<AudioServerHandle & { port: number }> {
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
    onCallSession: (info) => calls.push(info),
  });
  server = Object.assign(handle, { port: handle.address().port });
  return server;
}

async function openCall(
  port: number,
  o: {
    sessionId: string;
    surfaceId: string;
    chatId: string;
    takeOver?: boolean;
    kind?: 'web' | 'mobile';
  },
): Promise<{ ws: WebSocket; closed: Promise<string> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${o.sessionId}`);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  const closed = new Promise<string>((res) =>
    ws.once('close', (_c, reason) => res(reason.toString())),
  );
  ws.send(
    encodeAudio({
      type: 'audio.session_start',
      sessionId: o.sessionId,
      accountId: 'a',
      surfaceId: o.surfaceId,
      surfaceKind: o.kind ?? 'web',
      chatId: o.chatId,
      role: 'voice-call',
      token: mintToken(o),
      surfaceHasAec: true,
      mode: 'call',
      ...(o.takeOver ? { takeOver: true } : {}),
    }),
  );
  return { ws, closed };
}

describe('call handoff', () => {
  test('announces a call opening and closing', async () => {
    const calls: CallInfo[] = [];
    const s = await start(calls);
    const a = await openCall(s.port, {
      sessionId: 's1',
      surfaceId: 'phone',
      chatId: 'c1',
      kind: 'mobile',
    });
    await wait(60);
    expect(calls).toMatchObject([
      { sessionId: 's1', surfaceId: 'phone', surfaceKind: 'mobile', chatId: 'c1', active: true },
    ]);
    a.ws.close();
    await wait(60);
    expect(calls.map((c) => c.active)).toEqual([true, false]);
  });

  test("takeOver closes the chat's other call as transferred, and only that one", async () => {
    const calls: CallInfo[] = [];
    const s = await start(calls);
    const phone = await openCall(s.port, {
      sessionId: 's1',
      surfaceId: 'phone',
      chatId: 'c1',
      kind: 'mobile',
    });
    const other = await openCall(s.port, { sessionId: 's3', surfaceId: 'tablet', chatId: 'c2' });
    await wait(60);
    const web = await openCall(s.port, {
      sessionId: 's2',
      surfaceId: 'web',
      chatId: 'c1',
      takeOver: true,
    });
    expect(await phone.closed).toBe('transferred');
    await wait(60);
    expect(other.ws.readyState).toBe(WebSocket.OPEN);
    expect(web.ws.readyState).toBe(WebSocket.OPEN);
    expect(calls.filter((c) => c.chatId === 'c1').map((c) => `${c.surfaceId}:${c.active}`)).toEqual(
      ['phone:true', 'phone:false', 'web:true'],
    );
  });

  test('without takeOver a second call on the chat leaves the first alone', async () => {
    const calls: CallInfo[] = [];
    const s = await start(calls);
    const phone = await openCall(s.port, {
      sessionId: 's1',
      surfaceId: 'phone',
      chatId: 'c1',
      kind: 'mobile',
    });
    await wait(60);
    await openCall(s.port, { sessionId: 's2', surfaceId: 'web', chatId: 'c1' });
    await wait(60);
    expect(phone.ws.readyState).toBe(WebSocket.OPEN);
  });
});
