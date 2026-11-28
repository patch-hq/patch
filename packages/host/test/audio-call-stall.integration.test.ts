// A 4 second stall on a real audio socket (spec/07 § A dropped call comes
// back): the call line on the device side, the real audio server on the host
// side, a real WebSocket between them that stops being read for 4 seconds.
// The line plays "reconnecting" at 3 s, redials, and lands back on the same
// host session, with the same provider conversation. Real time.

import { test, expect, afterEach } from 'vitest';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import { CallLine, type CallLinePhase } from '@patch/wire/call-line';
import { decodeAudio, encodeAudio } from '@patch/wire/audio';
import { fakeVoiceAgent } from './helpers/fakeVoiceAgent.js';
import { startAudioServer, type AudioServerHandle } from '../src/audio/server.js';
import { createWhisper } from '../src/audio/whisper.js';
import { createKokoro } from '../src/audio/kokoro.js';
import { MockVad } from '../src/audio/vad.js';

const SECRET = 'unit-test-internal-token-aaaaaaaaaa';
const logger = pino({ level: 'silent' });

function mintToken(sessionId: string): string {
  const claims = Buffer.from(
    JSON.stringify({
      accountId: 'a',
      surfaceId: 'phone',
      sessionId,
      chatId: 'c1',
      exp: Date.now() + 60_000,
      jti: `jti-${sessionId}`,
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

test('a 4 s stall on the socket is reconnected into the same session, not a new call', async () => {
  let providerSockets = 0;
  const agent = fakeVoiceAgent();
  const calls: Array<{ sessionId: string; active: boolean }> = [];
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
    geminiWsCtor: function (url: string) {
      providerSockets += 1;
      return new (agent.geminiWsCtor as unknown as new (u: string) => WsSocket)(url);
    } as unknown as new (url: string) => WsSocket,
    onCallSession: (info) => calls.push(info),
  });
  server = Object.assign(handle, { port: handle.address().port });

  const phases: CallLinePhase[] = [];
  const sockets = new Map<number, WebSocket>();
  const bus = new EventEmitter();
  const dialled: Array<string | null> = [];
  const line: CallLine = new CallLine({
    dial: (attempt, resumes) => {
      dialled.push(resumes);
      const sessionId = `s${attempt}`;
      const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/audio/${sessionId}`);
      sockets.set(attempt, ws);
      ws.on('open', () =>
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
            ...(resumes !== null ? { resumes } : {}),
          }),
        ),
      );
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const frame = decodeAudio(data.toString());
        if (frame.type === 'audio.heartbeat') {
          line.heartbeat(attempt, frame);
          ws.send(encodeAudio({ type: 'audio.heartbeat', sessionId, n: frame.n }));
        } else if (frame.type === 'audio.state' && frame.state !== 'connecting') {
          line.acked(attempt, sessionId);
        }
      });
      ws.on('close', () => line.lost(attempt, 'connection_closed', 'closed'));
    },
    hangUp: (attempt) => sockets.get(attempt)?.close(),
    send: (attempt, frame) => {
      const ws = sockets.get(attempt);
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(encodeAudio(frame));
      return true;
    },
    phase: (next) => {
      phases.push(next);
      bus.emit('phase', next);
    },
    stillTrying: () => undefined,
  });
  const reached = (target: CallLinePhase, from: number): Promise<void> =>
    new Promise((res) => {
      if (phases.slice(from).includes(target)) return res();
      const on = (p: CallLinePhase): void => {
        if (p === target) {
          bus.off('phase', on);
          res();
        }
      };
      bus.on('phase', on);
    });

  line.start();
  await reached('live', 0);
  expect(providerSockets).toBe(1);

  // The network stalls: nothing is read from the socket, so no heartbeat
  // arrives and none is answered.
  const stalledAt = Date.now();
  (sockets.get(1) as unknown as { _socket: { pause(): void } })._socket.pause();
  const mark = phases.length;
  await reached('reconnecting', mark);
  await new Promise((r) => setTimeout(r, Math.max(0, 4_000 - (Date.now() - stalledAt))));
  await reached('live', mark);

  expect(phases.slice(mark)).toEqual(['reconnecting', 'live']);
  expect(dialled).toEqual([null, 's1']);
  expect(providerSockets).toBe(1);
  expect(calls.map((c) => c.active)).toEqual([true]);
  expect(server.sessionById('s1')).toBeDefined();
  line.end();
  for (const ws of sockets.values()) ws.terminate();
}, 20_000);
