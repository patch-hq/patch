// Direct calls on the server (spec/07 § Direct calls; spec/05 § Speech engines):
// the cloud speech routes carry one utterance or one reply piece to the chat's
// host and back, the turn route lands the words as a voice turn, and each
// surface's engine report is kept for Settings.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';
import { SpeechEngineStore } from '../src/speech-engines.js';

class FakeDirectHost extends InProcessHostLink {
  sent: WireEvent[] = [];
  answer: 'ok' | 'key_missing' | 'silent' = 'ok';

  override send(surfaceId: string, event: WireEvent): void {
    super.send(surfaceId, event);
    this.sent.push(event);
    if (this.answer === 'silent') return;
    if (event.type === 'patch.voice.direct_transcribe_request') {
      this.emit(
        this.answer === 'ok'
          ? {
              type: 'patch.voice.direct_transcribe_response',
              requestId: event.requestId,
              ok: true,
              transcript: 'what is left',
            }
          : {
              type: 'patch.voice.direct_transcribe_response',
              requestId: event.requestId,
              ok: false,
              error: { code: 'key_missing', message: 'no Groq key is set on this host' },
            },
      );
    }
    if (event.type === 'patch.voice.direct_speak_request') {
      this.emit(
        this.answer === 'ok'
          ? {
              type: 'patch.voice.direct_speak_response',
              requestId: event.requestId,
              ok: true,
              pcmBase64: 'AAEC',
            }
          : {
              type: 'patch.voice.direct_speak_response',
              requestId: event.requestId,
              ok: false,
              error: { code: 'engine_failed', message: 'HTTP 429' },
            },
      );
    }
  }
}

describe('direct call routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-voice-direct-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp(kind: 'desktop' | 'terminal' = 'desktop') {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(43));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-1', surfaceKind: kind, label: 'mac', issuedAt: 1 });
    const hostLink = new FakeDirectHost();
    const built = await buildAll({
      logger: false,
      registry,
      hostLink,
      directSpeechTimeoutMs: 200,
    });
    hostLink.emit({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '/tmp/c1' });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-1',
      surfaceKind: kind,
      label: 'mac',
    });
    return { built, hostLink, auth: { authorization: `Bearer ${jwt}` } };
  }

  it('transcribe relays the clip to the chat’s host on the chosen engine and model', async () => {
    const { built, hostLink, auth } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/direct/transcribe',
        headers: auth,
        payload: {
          chatId: 'c1',
          engine: 'groq',
          model: 'whisper-large-v3',
          audioBase64: 'UklGRg==',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, transcript: 'what is left' });
      const req = hostLink.sent.find((e) => e.type === 'patch.voice.direct_transcribe_request');
      expect(req).toMatchObject({ chatId: 'c1', engine: 'groq', model: 'whisper-large-v3' });
    } finally {
      await built.app.close();
    }
  });

  it('a host refusal names the engine; an unknown engine or chat is refused', async () => {
    const { built, hostLink, auth } = await makeApp();
    try {
      hostLink.answer = 'key_missing';
      const post = (payload: object) =>
        built.app.inject({
          method: 'POST',
          url: '/api/voice/direct/transcribe',
          headers: auth,
          payload,
        });
      const res = await post({ chatId: 'c1', engine: 'groq', audioBase64: 'UklGRg==' });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/no Groq key/);
      expect(
        (await post({ chatId: 'c1', engine: 'parakeet', audioBase64: 'AA==' })).statusCode,
      ).toBe(400);
      expect((await post({ chatId: 'nope', engine: 'groq', audioBase64: 'AA==' })).statusCode).toBe(
        404,
      );
    } finally {
      await built.app.close();
    }
  });

  it('speak returns 24 kHz PCM from the host, and a silent host times out loudly', async () => {
    const { built, hostLink, auth } = await makeApp();
    const body = {
      chatId: 'c1',
      engine: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
      sound: { speed: 1 },
      text: 'All done.',
    };
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/direct/speak',
        headers: auth,
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, pcmBase64: 'AAEC', sampleRate: 24000 });
      hostLink.answer = 'key_missing';
      const failed = await built.app.inject({
        method: 'POST',
        url: '/api/voice/direct/speak',
        headers: auth,
        payload: body,
      });
      expect(failed.statusCode).toBe(502);
      expect(failed.json()).toEqual({ error: 'engine_failed', message: 'HTTP 429' });
      hostLink.answer = 'silent';
      const timeout = await built.app.inject({
        method: 'POST',
        url: '/api/voice/direct/speak',
        headers: auth,
        payload: body,
      });
      expect(timeout.statusCode).toBe(504);
    } finally {
      await built.app.close();
    }
  });

  it('turn injects the words as a voice turn of the caller’s own kind', async () => {
    const { built, hostLink, auth } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/direct/turn',
        headers: auth,
        payload: { chatId: 'c1', text: '  ship it  ' },
      });
      expect(res.statusCode).toBe(200);
      const input = hostLink.sent.find((e) => e.type === 'chat.input');
      expect(input).toMatchObject({
        chatId: 'c1',
        message: 'ship it',
        source: { kind: 'voice-app', surfaceKind: 'desktop' },
      });
    } finally {
      await built.app.close();
    }
  });

  it('end tells the chat’s host the call ended, with what the device counted, stamped with its kind', async () => {
    const { built, hostLink, auth } = await makeApp();
    try {
      const usage = {
        stt: { engine: 'groq', model: 'whisper-large-v3-turbo', utteranceSeconds: [2.5] },
        tts: { engine: 'kokoro', model: 'kokoro-82m', requests: 0, characters: 0 },
      };
      const before = Date.now();
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/direct/end',
        headers: auth,
        payload: { chatId: 'c1', startedAt: before - 52_000, usage },
      });
      expect(res.statusCode).toBe(200);
      const end = hostLink.sent.find((e) => e.type === 'patch.voice.direct_call_end');
      expect(end).toMatchObject({
        chatId: 'c1',
        surfaceKind: 'desktop',
        startedAt: before - 52_000,
        usage,
      });
      expect((end as { endedAt: number }).endedAt).toBeGreaterThanOrEqual(before);
      expect((end as { callId: string }).callId).toMatch(/.+/);
    } finally {
      await built.app.close();
    }
  });

  it('end refuses a usage the wire does not describe', async () => {
    const { built, hostLink, auth } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/direct/end',
        headers: auth,
        payload: { chatId: 'c1', startedAt: 1, usage: { stt: { engine: 'groq' } } },
      });
      expect(res.statusCode).toBe(400);
      expect(hostLink.sent.some((e) => e.type === 'patch.voice.direct_call_end')).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('a terminal cannot make a direct call', async () => {
    const { built, auth } = await makeApp('terminal');
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/direct/turn',
        headers: auth,
        payload: { chatId: 'c1', text: 'hi' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });
});

describe('SpeechEngineStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-speech-engines-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps each surface’s last report across a restart', () => {
    const a = new SpeechEngineStore({ dataDir: dir, nowMs: () => 5 });
    a.set('s1', { stt: [{ engine: 'parakeet', where: 'device', models: ['p'] }], tts: [] });
    const b = new SpeechEngineStore({ dataDir: dir });
    expect(b.get('s1')).toEqual({
      stt: [{ engine: 'parakeet', where: 'device', models: ['p'] }],
      tts: [],
      reportedAt: 5,
    });
    expect(JSON.parse(readFileSync(join(dir, 'speech-engines.json'), 'utf8')).s1).toBeDefined();
  });

  it('a corrupt file is logged and read as empty, never thrown', () => {
    writeFileSync(join(dir, 'speech-engines.json'), '{nope');
    const warns: string[] = [];
    const s = new SpeechEngineStore({
      dataDir: dir,
      logger: { warn: (_o: unknown, m?: string) => void warns.push(m ?? '') },
    });
    expect(s.get('s1')).toBeUndefined();
    expect(warns[0]).toMatch(/unreadable/);
  });
});
