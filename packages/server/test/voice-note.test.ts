// spec/07 § End-to-end voice transport — POST /api/voice/note (mobile
// voice-note upload).
//
// The server does not own Whisper — the host does. This route parses the
// multipart upload (chatId + audio m4a), round-trips the clip to the host
// over the host link (`patch.voice_note.transcribe_*`, requestId-correlated),
// and on success injects the transcript as the chat's next user turn via a
// `chat.input` tagged `source: { kind: 'voice-app', surfaceKind: 'mobile' }`.
//
// These tests assert: multipart accepted; the host received the clip
// (correct base64 + format); the returned transcript; the injected chat.input
// with the voice-app source; the auth gate; unknown-chat 404; and the host's
// typed error mapping (unsupported_format → 400, other → 502).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

// A fake host transcriber: answers `patch.voice_note.transcribe_request` with
// a canned transcript (or a typed error), recording the request so the test can
// assert what the server sent. Mirrors packages/host handleVoiceNoteTranscribe.
class FakeTranscribeHost extends InProcessHostLink {
  lastRequest: Extract<WireEvent, { type: 'patch.voice_note.transcribe_request' }> | null = null;
  mode: 'ok' | 'unsupported' | 'failed' = 'ok';
  transcript = 'buy oat milk';

  override send(surfaceId: string, event: WireEvent): void {
    super.send(surfaceId, event);
    if (event.type !== 'patch.voice_note.transcribe_request') return;
    this.lastRequest = event;
    if (this.mode === 'ok') {
      this.emit({
        type: 'patch.voice_note.transcribe_response',
        requestId: event.requestId,
        ok: true,
        transcript: this.transcript,
      });
    } else if (this.mode === 'unsupported') {
      this.emit({
        type: 'patch.voice_note.transcribe_response',
        requestId: event.requestId,
        ok: false,
        error: { code: 'unsupported_format', message: 'local backend cannot decode m4a' },
      });
    } else {
      this.emit({
        type: 'patch.voice_note.transcribe_response',
        requestId: event.requestId,
        ok: false,
        error: { code: 'transcription_failed', message: 'groq 500' },
      });
    }
  }
}

// Build a multipart/form-data body (chatId field + audio file) for app.inject.
function multipartBody(opts: {
  chatId?: string;
  audio?: Buffer;
  filename?: string;
  mimetype?: string;
  surfaceKind?: string;
  prefix?: string;
}): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----patchtestboundary1234567890';
  const CRLF = '\r\n';
  const chunks: Buffer[] = [];
  if (opts.chatId !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="chatId"${CRLF}${CRLF}` +
          `${opts.chatId}${CRLF}`,
        'utf8',
      ),
    );
  }
  if (opts.surfaceKind !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="surfaceKind"${CRLF}${CRLF}` +
          `${opts.surfaceKind}${CRLF}`,
        'utf8',
      ),
    );
  }
  if (opts.prefix !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="prefix"${CRLF}${CRLF}` +
          `${opts.prefix}${CRLF}`,
        'utf8',
      ),
    );
  }
  if (opts.audio !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="audio"; filename="${opts.filename ?? 'voice-note.m4a'}"${CRLF}` +
          `Content-Type: ${opts.mimetype ?? 'audio/m4a'}${CRLF}${CRLF}`,
        'utf8',
      ),
    );
    chunks.push(opts.audio);
    chunks.push(Buffer.from(CRLF, 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('POST /api/voice/note', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-voice-note-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-mobile-1',
      surfaceKind: 'mobile',
      label: 'phone',
      issuedAt: 1,
    });
    const hostLink = new FakeTranscribeHost();
    const built = await buildAll({ logger: false, registry, hostLink });
    // Seed a real chat so the existence check passes.
    hostLink.emit({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '/tmp/c1' });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-mobile-1',
      surfaceKind: 'mobile',
      label: 'phone',
    });
    return { built, hostLink, jwt, registry };
  }

  const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  it('transcribes the uploaded clip and injects a voice-app chat.input', async () => {
    const { built, hostLink, jwt } = await makeApp();
    const audio = Buffer.from('fake-m4a-bytes-', 'binary');
    try {
      const body = multipartBody({ chatId: 'c1', audio });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, transcript: 'buy oat milk', text: 'buy oat milk' });

      // The host received the exact clip + format.
      expect(hostLink.lastRequest).not.toBeNull();
      expect(hostLink.lastRequest?.format).toBe('m4a');
      expect(hostLink.lastRequest?.surfaceKind).toBe('mobile');
      expect(Buffer.from(hostLink.lastRequest!.audioBase64, 'base64').equals(audio)).toBe(true);

      // The transcript was injected as a chat.input carrying the voice-app source.
      const inputs = hostLink.sent.filter((s) => s.event.type === 'chat.input');
      expect(inputs).toHaveLength(1);
      const ev = inputs[0]!.event as Extract<WireEvent, { type: 'chat.input' }>;
      expect(ev.chatId).toBe('c1');
      expect(ev.message).toBe('buy oat milk');
      expect(ev.source).toEqual({ kind: 'voice-app', surfaceKind: 'mobile' });
      expect(ev.localId.length).toBeGreaterThan(0);
    } finally {
      await built.app.close();
    }
  });

  // --- the typed composer text rides along as `prefix` (spec/07 § 1. Voice note)
  //
  // Todoist 6hW5QcMPmf6gWhwc / 6hVhq54fM2mFf8c6: "patch starting a voice
  // note deletes all current content!" / "should append". A note commits its OWN
  // turn, so before this the half-written message sitting in the composer was
  // simply thrown away. It now leads the turn and the transcript follows it.

  it('puts the typed composer text AHEAD of the transcript in one turn', async () => {
    const { built, hostLink, jwt } = await makeApp();
    try {
      const body = multipartBody({
        chatId: 'c1',
        audio: Buffer.from('x'),
        prefix: 'remind me to',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      // `transcript` stays what Whisper heard; `text` is the turn as injected.
      expect(res.json()).toEqual({
        ok: true,
        transcript: 'buy oat milk',
        text: 'remind me to buy oat milk',
      });

      // ONE turn, not two: the typed text is not injected separately.
      const inputs = hostLink.sent.filter((s) => s.event.type === 'chat.input');
      expect(inputs).toHaveLength(1);
      const ev = inputs[0]!.event as Extract<WireEvent, { type: 'chat.input' }>;
      expect(ev.message).toBe('remind me to buy oat milk');
      expect(ev.source).toEqual({ kind: 'voice-app', surfaceKind: 'mobile' });
    } finally {
      await built.app.close();
    }
  });

  it('joins with exactly one space however the typed text was left', async () => {
    // The composer keeps whatever whitespace the user typed; the join must not
    // turn a trailing space into a double space or a leading one into an indent.
    const { built, hostLink, jwt } = await makeApp();
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x'), prefix: '  please   ' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { text: string }).text).toBe('please buy oat milk');
      const inputs = hostLink.sent.filter((s) => s.event.type === 'chat.input');
      const ev = inputs[0]!.event as Extract<WireEvent, { type: 'chat.input' }>;
      expect(ev.message).toBe('please buy oat milk');
    } finally {
      await built.app.close();
    }
  });

  it('an empty composer sends the transcript alone — no leading space', async () => {
    const { built, hostLink, jwt } = await makeApp();
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x'), prefix: '' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { text: string }).text).toBe('buy oat milk');
      const inputs = hostLink.sent.filter((s) => s.event.type === 'chat.input');
      const ev = inputs[0]!.event as Extract<WireEvent, { type: 'chat.input' }>;
      expect(ev.message).toBe('buy oat milk');
    } finally {
      await built.app.close();
    }
  });

  it('keeps the typed text even when the clip transcribes to nothing', async () => {
    // Whisper hearing silence must not cost the user the words he had already
    // written — the whole point of carrying them. The turn is the typed text.
    const { built, hostLink, jwt } = await makeApp();
    hostLink.transcript = '   ';
    try {
      const body = multipartBody({
        chatId: 'c1',
        audio: Buffer.from('x'),
        prefix: 'book the dentist',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { text: string }).text).toBe('book the dentist');
      const inputs = hostLink.sent.filter((s) => s.event.type === 'chat.input');
      const ev = inputs[0]!.event as Extract<WireEvent, { type: 'chat.input' }>;
      expect(ev.message).toBe('book the dentist');
    } finally {
      await built.app.close();
    }
  });

  it('detects a .wav upload as the wav format', async () => {
    const { built, hostLink, jwt } = await makeApp();
    try {
      const body = multipartBody({
        chatId: 'c1',
        audio: Buffer.from('RIFFxxxx'),
        filename: 'note.wav',
        mimetype: 'audio/wav',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(hostLink.lastRequest?.format).toBe('wav');
    } finally {
      await built.app.close();
    }
  });

  it('requires auth (401 without bearer)', async () => {
    const { built } = await makeApp();
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: body.headers,
        payload: body.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects an unknown chatId with 404', async () => {
    const { built, jwt } = await makeApp();
    try {
      const body = multipartBody({ chatId: 'NOPE', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a missing audio file with 400', async () => {
    const { built, jwt } = await makeApp();
    try {
      const body = multipartBody({ chatId: 'c1' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('maps a host unsupported_format error to 400 and injects nothing', async () => {
    const { built, hostLink, jwt } = await makeApp();
    hostLink.mode = 'unsupported';
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('unsupported_format');
      expect(hostLink.sent.some((s) => s.event.type === 'chat.input')).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('maps a host transcription failure to 502', async () => {
    const { built, hostLink, jwt } = await makeApp();
    hostLink.mode = 'failed';
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a JWT that fails signature verification with 401 (distinct from missing bearer)', async () => {
    const { built } = await makeApp();
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { authorization: 'Bearer not-a-real-jwt', ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects when no account has been bootstrapped', async () => {
    const registry = Registry.load(dir); // no bootstrapAccount() call
    const hostLink = new InProcessHostLink();
    const built = await buildAll({ logger: false, registry, hostLink });
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { authorization: 'Bearer whatever', ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a revoked surface', async () => {
    const { built, jwt, registry } = await makeApp();
    registry.revoke('srf-mobile-1');
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('falls back to 401 when requireAuth throws an error without a statusCode', async () => {
    const { built, jwt, registry } = await makeApp();
    (registry as unknown as { getAccount: () => never }).getAccount = () => {
      throw new Error('registry backing store exploded');
    };
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a non-multipart body with 400', async () => {
    const { built, jwt } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), 'content-type': 'application/json' },
        payload: { not: 'multipart' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('expected multipart/form-data');
    } finally {
      await built.app.close();
    }
  });

  it('drains an unexpected file fieldname and still rejects a body with no `audio` field', async () => {
    const { built, jwt } = await makeApp();
    try {
      const boundary = '----patchtestboundary-wrongfield';
      const CRLF = '\r\n';
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="chatId"${CRLF}${CRLF}c1${CRLF}`,
        ),
        Buffer.from(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="notaudio"; filename="x.bin"${CRLF}` +
            `Content-Type: application/octet-stream${CRLF}${CRLF}`,
        ),
        Buffer.from('drained-bytes'),
        Buffer.from(CRLF),
        Buffer.from(`--${boundary}--${CRLF}`),
      ]);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: {
          ...authed(jwt),
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('audio file is required');
    } finally {
      await built.app.close();
    }
  });

  it('rejects a truncated/malformed multipart body with 400 (busboy parse error)', async () => {
    const { built, jwt } = await makeApp();
    try {
      const boundary = '----patchtestboundary-truncated';
      const payload = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="x.m4a"\r\n` +
          `Content-Type: audio/m4a\r\n\r\nnot-actually-terminated-properly`,
      );
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: {
          ...authed(jwt),
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain('invalid multipart body');
    } finally {
      await built.app.close();
    }
  });

  it('rejects a chatId-less upload with 400', async () => {
    const { built, jwt } = await makeApp();
    try {
      const body = multipartBody({ audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('chatId is required');
    } finally {
      await built.app.close();
    }
  });

  it('rejects a present-but-empty audio field with 400', async () => {
    const { built, jwt } = await makeApp();
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.alloc(0) });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('audio file is required');
    } finally {
      await built.app.close();
    }
  });

  it("rejects an oversized clip with 400 (caught by @fastify/multipart's own fileSize limit)", async () => {
    const { built, jwt } = await makeApp();
    try {
      const big = Buffer.alloc(25 * 1024 * 1024 + 1);
      const body = multipartBody({ chatId: 'c1', audio: big });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain('too large');
    } finally {
      await built.app.close();
    }
  }, 15_000);

  it('detects wav from a wav mimetype even when the filename does not end in .wav', async () => {
    const { built, hostLink, jwt } = await makeApp();
    try {
      const body = multipartBody({
        chatId: 'c1',
        audio: Buffer.from('RIFFxxxx'),
        filename: 'clip.bin',
        mimetype: 'audio/x-wav',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(hostLink.lastRequest?.format).toBe('wav');
    } finally {
      await built.app.close();
    }
  });

  it('returns 504 when the host never replies to the transcribe request', async () => {
    // A plain InProcessHostLink (unlike FakeTranscribeHost) never
    // replies to the transcribe request, so this waits out the real 30s
    // STORE_REQUEST_TIMEOUT_MS.
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-mobile-1',
      surfaceKind: 'mobile',
      label: 'phone',
      issuedAt: 1,
    });
    const hostLink = new InProcessHostLink();
    const built = await buildAll({ logger: false, registry, hostLink, voiceNoteTimeoutMs: 50 });
    hostLink.emit({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '/tmp/c1' });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-mobile-1',
      surfaceKind: 'mobile',
      label: 'phone',
    });
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { authorization: `Bearer ${jwt}`, ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(504);
      expect((res.json() as { error: string }).error).toBe('daemon_timeout');
    } finally {
      await built.app.close();
    }
  }, 35_000);

  it('accepts an empty filename / absent content-type file part and still defaults to m4a', async () => {
    const { built, hostLink, jwt } = await makeApp();
    try {
      const boundary = '----patchtestboundary-nofilename';
      const CRLF = '\r\n';
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="chatId"${CRLF}${CRLF}c1${CRLF}`,
        ),
        // No Content-Type header on the file part, and an empty filename —
        // both are still real strings (busboy classifies by filename
        // *presence*, not content), so this exercises `.toLowerCase()` on
        // edge-case-but-real values rather than the defensive `?? ''`
        // fallback (see the v8-ignore comment in src/voice/note.ts).
        Buffer.from(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="audio"; filename=""${CRLF}${CRLF}`,
        ),
        Buffer.from('raw-bytes-no-content-type'),
        Buffer.from(CRLF),
        Buffer.from(`--${boundary}--${CRLF}`),
      ]);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: {
          ...authed(jwt),
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      expect(res.statusCode).toBe(200);
      expect(hostLink.lastRequest?.format).toBe('m4a');
    } finally {
      await built.app.close();
    }
  });

  it('host transcription failure defaults code/message to internal when `error` is omitted', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-mobile-1',
      surfaceKind: 'mobile',
      label: 'phone',
      issuedAt: 1,
    });
    const hostLink = new InProcessHostLink();
    const origSend = hostLink.send.bind(hostLink);
    hostLink.send = (surfaceId, event) => {
      origSend(surfaceId, event);
      if (event.type === 'patch.voice_note.transcribe_request') {
        hostLink.emit({
          type: 'patch.voice_note.transcribe_response',
          requestId: event.requestId,
          ok: true,
          // `transcript` omitted — result.ok is true but the shape is still
          // invalid, hitting the same failure branch as ok:false without an
          // `error` payload.
        });
      }
    };
    const built = await buildAll({ logger: false, registry, hostLink });
    hostLink.emit({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '/tmp/c1' });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-mobile-1',
      surfaceKind: 'mobile',
      label: 'phone',
    });
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { authorization: `Bearer ${jwt}`, ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(502);
      const bodyJson = res.json() as { error: string; message: string };
      expect(bodyJson.error).toBe('internal');
      expect(bodyJson.message).toBe('transcription failed');
    } finally {
      await built.app.close();
    }
  });

  it('ignores a patch.voice_note.transcribe_response frame with an unmatched requestId', async () => {
    const { built, hostLink } = await makeApp();
    try {
      hostLink.emit({
        type: 'patch.voice_note.transcribe_response',
        requestId: 'no-such-request-id',
        ok: true,
        transcript: 'irrelevant',
      });
      const res = await built.app.inject({ method: 'GET', url: '/api/healthz' });
      expect(res.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });

  it('honours a surfaceKind form field (web) on the transcribe request AND the injected source', async () => {
    const { built, hostLink, jwt } = await makeApp();
    try {
      const body = multipartBody({
        chatId: 'c1',
        audio: Buffer.from('RIFFwav'),
        filename: 'voice-note.wav',
        mimetype: 'audio/wav',
        surfaceKind: 'web',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(hostLink.lastRequest?.surfaceKind).toBe('web');
      const ev = hostLink.sent.find((s) => s.event.type === 'chat.input')!.event as Extract<
        WireEvent,
        { type: 'chat.input' }
      >;
      expect(ev.source).toEqual({ kind: 'voice-app', surfaceKind: 'web' });
    } finally {
      await built.app.close();
    }
  });

  it('falls back to mobile for an unknown surfaceKind value', async () => {
    const { built, hostLink, jwt } = await makeApp();
    try {
      const body = multipartBody({
        chatId: 'c1',
        audio: Buffer.from('x'),
        surfaceKind: 'smart-fridge',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(hostLink.lastRequest?.surfaceKind).toBe('mobile');
    } finally {
      await built.app.close();
    }
  });
});

// POST /api/voice/transcribe — transcribe ONLY (no chat injection). Used by the
// composer dictation mic (spec/C1): the recognised text lands in the composer
// input for the user to edit, so the turn must NOT be submitted server-side.
describe('POST /api/voice/transcribe', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-voice-transcribe-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-web-1',
      surfaceKind: 'web',
      label: 'web',
      issuedAt: 1,
    });
    const hostLink = new FakeTranscribeHost();
    const built = await buildAll({ logger: false, registry, hostLink });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web-1',
      surfaceKind: 'web',
      label: 'web',
    });
    return { built, hostLink, jwt, registry };
  }
  const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  it('falls back to 401 when requireAuth throws an error without a statusCode', async () => {
    const { built, jwt, registry } = await makeApp();
    (registry as unknown as { getAccount: () => never }).getAccount = () => {
      throw new Error('registry backing store exploded');
    };
    try {
      const body = multipartBody({ audio: Buffer.from('x'), surfaceKind: 'web' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/transcribe',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('transcribes a clip and returns the transcript WITHOUT injecting a chat.input', async () => {
    const { built, hostLink, jwt } = await makeApp();
    hostLink.transcript = 'dictated words';
    try {
      const body = multipartBody({
        audio: Buffer.from('RIFFwav'),
        filename: 'voice.wav',
        mimetype: 'audio/wav',
        surfaceKind: 'web',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/transcribe',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, transcript: 'dictated words' });
      expect(hostLink.lastRequest?.surfaceKind).toBe('web');
      expect(hostLink.lastRequest?.format).toBe('wav');
      // Critically: NO chat.input is injected (the user hasn't sent anything yet).
      expect(hostLink.sent.some((s) => s.event.type === 'chat.input')).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('requires auth (401 without bearer)', async () => {
    const { built } = await makeApp();
    try {
      const body = multipartBody({ audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/transcribe',
        headers: body.headers,
        payload: body.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a missing audio file with 400', async () => {
    const { built, jwt } = await makeApp();
    try {
      const body = multipartBody({ surfaceKind: 'web' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/transcribe',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('audio file is required');
    } finally {
      await built.app.close();
    }
  });

  it('rejects a non-multipart body with 400', async () => {
    const { built, jwt } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/transcribe',
        headers: { ...authed(jwt), 'content-type': 'application/json' },
        payload: { not: 'multipart' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('expected multipart/form-data');
    } finally {
      await built.app.close();
    }
  });

  it('maps a host transcription failure to 502', async () => {
    const { built, hostLink, jwt } = await makeApp();
    hostLink.mode = 'failed';
    try {
      const body = multipartBody({ audio: Buffer.from('x'), surfaceKind: 'web' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/transcribe',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await built.app.close();
    }
  });
});

// POST /api/voice/turn-check — dictation mode asks the host whether the speaker
// has finished (spec/07 § Dictation mode).
class FakeTurnHost extends InProcessHostLink {
  lastRequest: Extract<WireEvent, { type: 'patch.voice.turn_check_request' }> | null = null;
  answer: 'ok' | 'missing' | 'silent' = 'ok';
  probability = 0.87;

  override send(surfaceId: string, event: WireEvent): void {
    super.send(surfaceId, event);
    if (event.type !== 'patch.voice.turn_check_request') return;
    this.lastRequest = event;
    if (this.answer === 'silent') return;
    this.emit(
      this.answer === 'ok'
        ? {
            type: 'patch.voice.turn_check_response',
            requestId: event.requestId,
            ok: true,
            probability: this.probability,
          }
        : {
            type: 'patch.voice.turn_check_response',
            requestId: event.requestId,
            ok: false,
            error: { code: 'model_unavailable', message: 'no smart_turn.onnx' },
          },
    );
  }
}

describe('POST /api/voice/turn-check', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-voice-turn-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(42));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-web-1',
      surfaceKind: 'web',
      label: 'web',
      issuedAt: 1,
    });
    const hostLink = new FakeTurnHost();
    const built = await buildAll({ logger: false, registry, hostLink });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web-1',
      surfaceKind: 'web',
      label: 'web',
    });
    return { built, hostLink, jwt };
  }
  const post = (
    built: Awaited<ReturnType<typeof makeApp>>['built'],
    jwt: string | null,
    audio: Buffer,
    filename = 'turn.wav',
  ) => {
    const body = multipartBody({
      audio,
      filename,
      mimetype: filename.endsWith('.wav') ? 'audio/wav' : 'audio/mp4',
    });
    return built.app.inject({
      method: 'POST',
      url: '/api/voice/turn-check',
      headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...body.headers },
      payload: body.payload,
    });
  };

  it('relays the clip to the host and returns its probability', async () => {
    const { built, hostLink, jwt } = await makeApp();
    try {
      const res = await post(built, jwt, Buffer.from('RIFFwav'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, probability: 0.87 });
      expect(Buffer.from(hostLink.lastRequest!.audioBase64, 'base64').toString()).toBe('RIFFwav');
    } finally {
      await built.app.close();
    }
  });

  it('passes the host’s refusal through, and refuses a non-WAV clip or no auth', async () => {
    const { built, hostLink, jwt } = await makeApp();
    try {
      hostLink.answer = 'missing';
      const missing = await post(built, jwt, Buffer.from('RIFFwav'));
      expect(missing.statusCode).toBe(502);
      expect(missing.json()).toEqual({ error: 'model_unavailable', message: 'no smart_turn.onnx' });
      expect((await post(built, jwt, Buffer.from('m4a'), 'clip.m4a')).statusCode).toBe(400);
      expect((await post(built, null, Buffer.from('RIFFwav'))).statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('says the host may need updating when it never answers', async () => {
    const { built, hostLink, jwt } = await makeApp();
    hostLink.answer = 'silent';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = post(built, jwt, Buffer.from('RIFFwav'));
      await vi.waitFor(() => expect(hostLink.lastRequest).not.toBeNull());
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.statusCode).toBe(504);
      expect(res.json().message).toMatch(/may need updating/);
    } finally {
      vi.useRealTimers();
      await built.app.close();
    }
  });
});
