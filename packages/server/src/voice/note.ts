// Voice-note upload route (spec/07 § End-to-end voice transport —
// "Voice note (single utterance)", Mobile).
//
// On mobile a streaming PCM tap isn't available, so the surface records the
// note locally and uploads it as ONE file to `POST /api/voice/note`
// (multipart: `chatId` + `audio` m4a). This route:
//   1. verifies the surface credential (same gate as the sibling /api routes),
//   2. hands the clip to the host — which owns Whisper — over the host
//      link, correlated by `requestId` exactly like `/api/skills`
//      (`patch.voice_note.transcribe_*`), and awaits the transcript,
//   3. injects the turn — the optional `prefix` field (text already typed into
//      the composer the note was started from) followed by the transcript — as
//      the target chat's next user turn via a `chat.input` tagged
//      `source: { kind: 'voice-app', surfaceKind: 'mobile' }`
//      (the host prepends `[voice • mobile]` — see specialThreads
//      `voicePrefixForSource`), exactly as a streamed note would land, and
//   4. returns `{ ok: true, transcript, text }` — `transcript` is what Whisper
//      heard, `text` is the turn as injected.
//
// NO FALLBACK: a missing/invalid/revoked credential → 401; an unknown chat →
// 404; the host being silent → 504; a transcription failure surfaces the
// host's typed error (`unsupported_format` → 400, else 502). The note is
// NEVER silently dropped.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CLOUD_STT_ENGINES, CLOUD_TTS_ENGINES, DirectTtsSound } from '@patch/wire/direct-call';
import type { Logger } from 'pino';
import { verifySurfaceCredential } from '@patch/auth';
import { DirectCallUsage, type VoiceAppSurfaceKind, type WireEvent } from '@patch/wire';
import type { Registry } from '../registry.js';
import type { ChatRegistry } from '../chat-registry.js';
import type { HostLink } from '../host-link.js';

/**
 * A clip is minutes of speech, uploaded and transcribed in one request, so it
 * needs far longer than the short utterances the shorter timeouts are sized for.
 */
const TRANSCRIBE_REQUEST_TIMEOUT_MS = 150_000;
/**
 * A turn check is asked at a pause in speech, so a slow answer is a pause the
 * speaker notices. A host that predates the check never answers at all.
 */
const TURN_CHECK_TIMEOUT_MS = 10_000;
/** Reject clips larger than this before spending a host round-trip on them. */
const MAX_CLIP_BYTES = 25 * 1024 * 1024;
/** One utterance or one sentence: a cloud engine answers in a second or two. */
const DIRECT_SPEECH_TIMEOUT_MS = 30_000;

const VALID_SURFACE_KINDS: readonly VoiceAppSurfaceKind[] = ['web', 'desktop', 'mobile'];
function normaliseSurfaceKind(raw: string | undefined): VoiceAppSurfaceKind {
  // Default 'mobile' for back-compat: the mobile surface (the original caller)
  // does not send the field. Web/desktop send their own kind so the host tags
  // the turn `[voice • web]` / `[voice • desktop]` rather than lying "mobile".
  if (raw === undefined) return 'mobile';
  return VALID_SURFACE_KINDS.includes(raw as VoiceAppSurfaceKind)
    ? (raw as VoiceAppSurfaceKind)
    : 'mobile';
}

async function requireAuth(
  req: FastifyRequest,
  registry: Registry,
): Promise<{ surfaceId: string }> {
  const generic = (): Error & { statusCode?: number } => {
    const e = new Error('unauthenticated') as Error & { statusCode?: number };
    e.statusCode = 401;
    return e;
  };
  const account = registry.getAccount();
  if (!account) throw generic();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) throw generic();
  const jwt = authHeader.slice('Bearer '.length).trim();
  let claims;
  try {
    claims = await verifySurfaceCredential(jwt, { userPublicKey: account.userPublicKey });
  } catch {
    throw generic();
  }
  if (registry.isRevoked(claims.surface_id)) throw generic();
  return { surfaceId: claims.surface_id };
}

export interface VoiceNoteRouteDeps {
  logger: Logger;
  registry: Registry;
  chatRegistry: ChatRegistry;
  hostLink: HostLink;
  idGenerator: () => string;
  /** Override the wait for the host's transcript (tests). */
  transcribeTimeoutMs?: number;
  /** Override the wait for a direct call's cloud speech (tests). */
  directSpeechTimeoutMs?: number;
}

export function registerVoiceNoteRoute(app: FastifyInstance, deps: VoiceNoteRouteDeps): void {
  // Correlate `patch.voice_note.transcribe_response` frames back to the
  // awaiting HTTP call (same pattern as secrets/skills/files RPCs).
  const pending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.voice_note.transcribe_response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.hostLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.voice_note.transcribe_response') return;
    const w = pending.get(event.requestId);
    if (!w) return;
    pending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });

  function awaitHost(
    surfaceId: string,
    build: (requestId: string) => WireEvent,
  ): Promise<Extract<WireEvent, { type: 'patch.voice_note.transcribe_response' }> | 'timeout'> {
    const requestId = deps.idGenerator();
    return new Promise((resolveP) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        resolveP('timeout');
      }, deps.transcribeTimeoutMs ?? TRANSCRIBE_REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve: resolveP, timeout });
      deps.hostLink.send(surfaceId, build(requestId));
    });
  }

  // Shared multipart parser for both routes: an optional `chatId` field, an
  // optional `surfaceKind` field, and the `audio` file (whose extension/mimetype
  // picks m4a vs wav). Returns `{ error }` for a non-multipart / malformed body.
  async function parseAudio(req: FastifyRequest): Promise<
    | { error: string }
    | {
        chatId?: string;
        audio?: Buffer;
        format: 'm4a' | 'wav';
        surfaceKindRaw?: string;
        prefix?: string;
        engine?: string;
      }
  > {
    if (!req.isMultipart()) return { error: 'expected multipart/form-data' };
    let chatId: string | undefined;
    let audio: Buffer | undefined;
    let surfaceKindRaw: string | undefined;
    let prefix: string | undefined;
    let engine: string | undefined;
    let format: 'm4a' | 'wav' = 'm4a';
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'audio') {
            // Drain unexpected files so the stream doesn't stall.
            await part.toBuffer();
            continue;
          }
          audio = await part.toBuffer();
          // `?? ''`: defensive only — @fastify/multipart types `filename`/
          // `mimetype` as always-`string` for a file-type part (busboy uses
          // filename presence to decide file vs field), so this default is
          // unreachable via a real multipart upload.
          /* v8 ignore next 2 */
          const name = (part.filename ?? '').toLowerCase();
          const mime = (part.mimetype ?? '').toLowerCase();
          if (name.endsWith('.wav') || mime.includes('wav')) format = 'wav';
          else format = 'm4a';
        } else if (part.fieldname === 'chatId') {
          chatId = String(part.value);
        } else if (part.fieldname === 'surfaceKind') {
          surfaceKindRaw = String(part.value);
        } else if (part.fieldname === 'prefix') {
          prefix = String(part.value);
        } else if (part.fieldname === 'engine') {
          engine = String(part.value);
        }
      }
    } catch (err) {
      return { error: `invalid multipart body: ${(err as Error).message}` };
    }
    return {
      chatId,
      audio,
      format,
      surfaceKindRaw,
      prefix,
      ...(engine !== undefined ? { engine } : {}),
    };
  }

  // Hand a clip to the host (it owns Whisper) and await the transcript, mapping
  // the host's typed outcome onto an HTTP shape. Shared by both routes.
  async function transcribe(
    surfaceId: string,
    surfaceKind: VoiceAppSurfaceKind,
    format: 'm4a' | 'wav',
    audio: Buffer,
    engine?: 'whisper',
  ): Promise<{ ok: true; transcript: string } | { ok: false; status: number; body: object }> {
    const audioBase64 = audio.toString('base64');
    const result = await awaitHost(surfaceId, (requestId) => ({
      type: 'patch.voice_note.transcribe_request',
      requestId,
      surfaceKind,
      surfaceId,
      format,
      audioBase64,
      ...(engine !== undefined ? { engine } : {}),
    }));
    if (result === 'timeout') {
      deps.logger.warn('voice: host transcription timed out');
      return { ok: false, status: 504, body: { error: 'daemon_timeout' } };
    }
    if (!result.ok || typeof result.transcript !== 'string') {
      const code = result.error?.code ?? 'internal';
      const status = code === 'unsupported_format' ? 400 : 502;
      return {
        ok: false,
        status,
        body: { error: code, message: result.error?.message ?? 'transcription failed' },
      };
    }
    return { ok: true, transcript: result.transcript };
  }

  app.post('/api/voice/note', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }

    const parsed = await parseAudio(req);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const { chatId, audio, format } = parsed;
    const surfaceKind = normaliseSurfaceKind(parsed.surfaceKindRaw);
    const prefix = parsed.prefix ?? '';

    if (!chatId || chatId.length === 0) {
      return reply.code(400).send({ error: 'chatId is required' });
    }
    if (!audio || audio.byteLength === 0) {
      return reply.code(400).send({ error: 'audio file is required' });
    }
    // Unreachable via HTTP: @fastify/multipart's own `fileSize` limit (app.ts,
    // registered at the same 25MB ceiling this route was sized for) always
    // truncates/rejects an oversized part first, landing in the parse `catch`
    // above with a 400, so `audio.byteLength` can never exceed this here.
    /* v8 ignore next 3 */
    if (audio.byteLength > MAX_CLIP_BYTES) {
      return reply.code(413).send({ error: 'audio clip too large' });
    }

    // NO SILENT FALLBACK (mirrors /send-to, /voice/token): a note for an
    // unknown chatId must be rejected, not transcribed-then-dropped.
    if (!deps.chatRegistry.get(chatId)) {
      return reply.code(404).send({ error: `chat not found: ${chatId}` });
    }

    const result = await transcribe(auth.surfaceId, surfaceKind, format, audio);
    if (!result.ok) return reply.code(result.status).send(result.body);

    // The surface may have had text already typed into the composer the note was
    // started from (spec/07 § 1. Voice note — the new-chat composer's mic). That
    // text LEADS the turn and the transcript is appended to it, one space
    // between, the same join dictation uses. An empty side of the join is simply
    // absent — never a bare space, never a dropped half.
    const text = [prefix.trim(), result.transcript.trim()].filter((p) => p.length > 0).join(' ');

    // Inject it as the chat's next user turn. The server is one of
    // the two legitimate attachers of `source` (the voice-device
    // hook, and this route); it goes straight to the host link (not the surface
    // ingress path, which strips `source`). The host prepends `[voice • <kind>]`.
    deps.hostLink.send(auth.surfaceId, {
      type: 'chat.input',
      chatId,
      message: text,
      localId: deps.idGenerator(),
      source: { kind: 'voice-app', surfaceKind },
    });

    // `transcript` is what Whisper heard; `text` is the turn that was actually
    // injected. The caller echoes `text`, so its local bubble matches the
    // persisted turn and reconciles against it instead of duplicating.
    return reply.code(200).send({ ok: true, transcript: result.transcript, text });
  });

  const pendingTurn = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.voice.turn_check_response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.hostLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.voice.turn_check_response') return;
    const w = pendingTurn.get(event.requestId);
    if (!w) return;
    pendingTurn.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });

  // POST /api/voice/turn-check — dictation mode (spec/07 § Dictation mode)
  // asks, at a short silence, whether the speaker has finished. The host runs
  // Smart Turn on the clip so far and answers with a probability.
  app.post('/api/voice/turn-check', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsed = await parseAudio(req);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const { audio, format } = parsed;
    if (!audio || audio.byteLength === 0) {
      return reply.code(400).send({ error: 'audio file is required' });
    }
    if (format !== 'wav') return reply.code(400).send({ error: 'a turn check takes a WAV clip' });
    /* v8 ignore next 3 -- same @fastify/multipart fileSize guard as /voice/note. */
    if (audio.byteLength > MAX_CLIP_BYTES) {
      return reply.code(413).send({ error: 'audio clip too large' });
    }
    const requestId = deps.idGenerator();
    const result = await new Promise<
      Extract<WireEvent, { type: 'patch.voice.turn_check_response' }> | 'timeout'
    >((resolveP) => {
      const timeout = setTimeout(() => {
        pendingTurn.delete(requestId);
        resolveP('timeout');
      }, TURN_CHECK_TIMEOUT_MS);
      pendingTurn.set(requestId, { resolve: resolveP, timeout });
      deps.hostLink.send(auth.surfaceId, {
        type: 'patch.voice.turn_check_request',
        requestId,
        audioBase64: audio.toString('base64'),
      });
    });
    if (result === 'timeout') {
      deps.logger.warn('voice: host turn check timed out');
      return reply.code(504).send({
        error: 'daemon_timeout',
        message: 'the host did not answer the turn check — it may need updating',
      });
    }
    if (!result.ok || result.probability === undefined) {
      const code = result.error?.code ?? 'internal';
      return reply.code(code === 'unsupported_format' ? 400 : 502).send({
        error: code,
        message: result.error?.message ?? 'turn check failed',
      });
    }
    return reply.code(200).send({ ok: true, probability: result.probability });
  });

  // POST /api/voice/transcribe — transcribe ONLY (no chat injection). The
  // composer mic (spec/C1) records a clip and drops the recognised text into the
  // composer input for the user to edit before sending, so the turn must NOT be
  // submitted here. Same auth gate + host round-trip as /voice/note, minus the
  // chatId + chat.input inject.
  app.post('/api/voice/transcribe', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }

    const parsed = await parseAudio(req);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const { audio, format } = parsed;
    const surfaceKind = normaliseSurfaceKind(parsed.surfaceKindRaw);
    if (parsed.engine !== undefined && parsed.engine !== 'whisper') {
      return reply.code(400).send({ error: `unknown engine: ${parsed.engine}` });
    }

    if (!audio || audio.byteLength === 0) {
      return reply.code(400).send({ error: 'audio file is required' });
    }
    /* v8 ignore next 3 -- same @fastify/multipart fileSize guard as /voice/note. */
    if (audio.byteLength > MAX_CLIP_BYTES) {
      return reply.code(413).send({ error: 'audio clip too large' });
    }

    const result = await transcribe(
      auth.surfaceId,
      surfaceKind,
      format,
      audio,
      parsed.engine === 'whisper' ? 'whisper' : undefined,
    );
    if (!result.ok) return reply.code(result.status).send(result.body);
    return reply.code(200).send({ ok: true, transcript: result.transcript });
  });

  // ---- Direct calls' cloud speech (spec/07 § Direct calls) ----
  //
  // A direct call runs on its device, but a cloud engine's key is on the
  // chat's host, never on the device. These two routes carry one utterance to
  // be read, or one piece of a reply to be spoken, to the chat's host and back.
  // A failure names the engine; nothing is answered by another engine.
  type DirectResponse = Extract<
    WireEvent,
    { type: 'patch.voice.direct_transcribe_response' | 'patch.voice.direct_speak_response' }
  >;
  const pendingDirect = new Map<
    string,
    { resolve: (ev: DirectResponse) => void; timeout: NodeJS.Timeout }
  >();
  deps.hostLink.onEvent((event: WireEvent) => {
    if (
      event.type !== 'patch.voice.direct_transcribe_response' &&
      event.type !== 'patch.voice.direct_speak_response'
    ) {
      return;
    }
    const w = pendingDirect.get(event.requestId);
    if (!w) return;
    pendingDirect.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });
  function awaitDirect(
    surfaceId: string,
    build: (requestId: string) => WireEvent,
  ): Promise<DirectResponse | 'timeout'> {
    const requestId = deps.idGenerator();
    return new Promise((resolveP) => {
      const timeout = setTimeout(() => {
        pendingDirect.delete(requestId);
        resolveP('timeout');
      }, deps.directSpeechTimeoutMs ?? DIRECT_SPEECH_TIMEOUT_MS);
      pendingDirect.set(requestId, { resolve: resolveP, timeout });
      // `chatId` on the frame routes it to the chat's own host.
      deps.hostLink.send(surfaceId, build(requestId));
    });
  }
  function directFailure(
    reply: FastifyReply,
    result: DirectResponse | 'timeout',
    what: string,
  ): FastifyReply {
    if (result === 'timeout') {
      deps.logger.warn(`voice: host did not answer a direct call ${what}`);
      return reply.code(504).send({
        error: 'daemon_timeout',
        message: `the chat's host did not answer the ${what} — it may be offline or need updating`,
      });
    }
    const code = result.error?.code ?? 'internal';
    return reply
      .code(code === 'key_missing' ? 409 : 502)
      .send({ error: code, message: result.error?.message ?? `${what} failed` });
  }

  const TranscribeBody = z
    .object({
      chatId: z.string().min(1),
      engine: z.enum(CLOUD_STT_ENGINES),
      model: z.string().min(1).optional(),
      /** 16 kHz mono PCM16 WAV, base64. */
      audioBase64: z.string().min(1),
    })
    .strict();

  // An utterance runs up to two minutes: ~5 MB as base64 WAV.
  app.post('/api/voice/direct/transcribe', { bodyLimit: MAX_CLIP_BYTES }, async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const body = TranscribeBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    if (!deps.chatRegistry.get(body.data.chatId)) {
      return reply.code(404).send({ error: `chat not found: ${body.data.chatId}` });
    }
    const result = await awaitDirect(auth.surfaceId, (requestId) => ({
      type: 'patch.voice.direct_transcribe_request',
      requestId,
      ...body.data,
    }));
    if (result === 'timeout' || !result.ok || !('transcript' in result)) {
      return directFailure(reply, result, 'transcription');
    }
    return reply.code(200).send({ ok: true, transcript: result.transcript ?? '' });
  });

  const SpeakBody = z
    .object({
      chatId: z.string().min(1),
      engine: z.enum(CLOUD_TTS_ENGINES),
      model: z.string().min(1),
      voice: z.string().min(1),
      sound: DirectTtsSound,
      text: z.string().min(1).max(5000),
    })
    .strict();

  app.post('/api/voice/direct/speak', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const body = SpeakBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    if (!deps.chatRegistry.get(body.data.chatId)) {
      return reply.code(404).send({ error: `chat not found: ${body.data.chatId}` });
    }
    const result = await awaitDirect(auth.surfaceId, (requestId) => ({
      type: 'patch.voice.direct_speak_request',
      requestId,
      ...body.data,
    }));
    if (result === 'timeout' || !result.ok || !('pcmBase64' in result) || !result.pcmBase64) {
      return directFailure(reply, result, 'speech');
    }
    return reply.code(200).send({ ok: true, pcmBase64: result.pcmBase64, sampleRate: 24000 });
  });

  // A direct call has ended on its device (spec/07 § Call cost): the chat's host
  // prices what the device counted its cloud engines were sent and writes the
  // call's line into the chat. The surface kind is the authenticated surface's.
  const EndBody = z
    .object({
      chatId: z.string().min(1),
      startedAt: z.number().int().nonnegative(),
      usage: DirectCallUsage,
    })
    .strict();
  app.post('/api/voice/direct/end', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const body = EndBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    const { chatId, startedAt, usage } = body.data;
    if (!deps.chatRegistry.get(chatId)) {
      return reply.code(404).send({ error: `chat not found: ${chatId}` });
    }
    const kind = deps.registry.getSurface(auth.surfaceId)?.surfaceKind;
    if (kind !== 'web' && kind !== 'desktop' && kind !== 'mobile') {
      return reply
        .code(400)
        .send({ error: `a ${kind ?? 'unknown'} surface cannot make a direct call` });
    }
    const endedAt = Date.now();
    if (startedAt > endedAt) return reply.code(400).send({ error: 'startedAt is in the future' });
    deps.hostLink.send(auth.surfaceId, {
      type: 'patch.voice.direct_call_end',
      chatId,
      callId: deps.idGenerator(),
      surfaceKind: kind,
      startedAt,
      endedAt,
      usage,
    });
    return reply.code(200).send({ ok: true });
  });

  // A direct call's words, read on the device, become the chat's next user turn
  // tagged `[voice • <kind>]` (spec/07 § Direct calls). A surface never sets a
  // voice `source` itself (ChatInputSource), so the server attaches it here from
  // the authenticated surface's own kind. Mid-turn it queues like typed input.
  const TurnBody = z.object({ chatId: z.string().min(1), text: z.string().min(1) }).strict();
  app.post('/api/voice/direct/turn', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const body = TurnBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message });
    const { chatId } = body.data;
    const text = body.data.text.trim();
    if (text === '') return reply.code(400).send({ error: 'text is empty' });
    if (!deps.chatRegistry.get(chatId)) {
      return reply.code(404).send({ error: `chat not found: ${chatId}` });
    }
    const kind = deps.registry.getSurface(auth.surfaceId)?.surfaceKind;
    if (kind !== 'web' && kind !== 'desktop' && kind !== 'mobile') {
      return reply
        .code(400)
        .send({ error: `a ${kind ?? 'unknown'} surface cannot make a direct call` });
    }
    deps.hostLink.send(auth.surfaceId, {
      type: 'chat.input',
      chatId,
      message: text,
      localId: deps.idGenerator(),
      source: { kind: 'voice-app', surfaceKind: kind },
    });
    return reply.code(200).send({ ok: true, text });
  });
}
