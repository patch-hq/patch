// The voice component is optional on an installed host (voiceComponent.ts).
// A voice session that needs VAD while it is missing is refused BY NAME — the
// session never runs without detection and never falls back to a mock.

import { describe, test, expect, afterEach } from 'vitest';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { startAudioServer, type AudioServerHandle } from '../src/audio/server.js';
import { createWhisper } from '../src/audio/whisper.js';
import { createKokoro } from '../src/audio/kokoro.js';
import { VoiceComponentMissingError } from '../src/voiceComponent.js';
import { encodeAudio, decodeAudio, type AudioEvent } from '@patch/wire/audio';

const SECRET = 'unit-test-internal-token-aaaaaaaaaa';
const logger = pino({ level: 'silent' });

function mintToken(claims: {
  accountId: string;
  surfaceId: string;
  sessionId: string;
  chatId?: string;
}): string {
  const obj = {
    accountId: claims.accountId,
    surfaceId: claims.surfaceId,
    sessionId: claims.sessionId,
    chatId: claims.chatId ?? 'c',
    exp: Date.now() + 60_000,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
  };
  const claimsB64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const sig = createHmac('sha256', SECRET).update(claimsB64).digest().toString('base64url');
  return `${claimsB64}.${sig}`;
}

async function recvOne(ws: WebSocket): Promise<AudioEvent> {
  return new Promise<AudioEvent>((resolve, reject) => {
    ws.once('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        reject(new Error('expected json frame, got binary'));
        return;
      }
      try {
        resolve(decodeAudio(data as string | Buffer));
      } catch (e) {
        reject(e as Error);
      }
    });
    ws.once('error', reject);
  });
}

async function openSocket(port: number, sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${sessionId}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

describe('audio server — voice component missing', () => {
  let server: (AudioServerHandle & { port: number }) | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  test('a voice device answering directly is refused with voice_component_missing, naming the component', async () => {
    const handle = await startAudioServer({
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => {
        throw new VoiceComponentMissingError();
      },
      submitUserTurn: async () => 'mock reply',
      chatExists: () => true,
    });
    server = Object.assign(handle, { port: handle.address().port });
    const sessionId = 's-no-voice';
    const ws = await openSocket(server.port, sessionId);
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId,
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'device',
        deviceId: 'surf',
        chatId: 'c1',
        role: 'voice-device-conv',
        token: mintToken({ accountId: 'a', surfaceId: 'surf', sessionId, chatId: 'c1' }),
        surfaceHasAec: true,
      }),
    );
    expect(await recvOne(ws)).toMatchObject({
      type: 'audio.error',
      code: 'voice_component_missing',
      message: expect.stringContaining('voice component is not installed'),
    });
    ws.close();
  });
});
