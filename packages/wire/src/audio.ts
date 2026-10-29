// Audio WSS frames (group 13).
//
// The host hosts a separate WS endpoint at `wss://daemon:3003/audio/<sessionId>`.
// Surfaces (web / desktop / mobile) and — via the patch server proxy — the
// voice device firmware open one WS per voice session, exchange a control
// `audio.session_start` frame, then stream PCM16 mono.
//
// PCM frames are sent as **binary** WS frames (raw little-endian 16-bit PCM,
// 16 kHz mic / 24 kHz TTS); the events in this module are the JSON control
// envelope. Keeping them in a subpath (`@patch/wire/audio`) avoids bloating
// the surface-facing wire union — only the host-side audio server and the
// surface voice modules import this file.

import { z } from 'zod';

// --- session lifecycle -----------------------------------------------------

export const AudioSessionRole = z.enum(['voice-note', 'voice-call', 'voice-device-conv']);
export type AudioSessionRole = z.infer<typeof AudioSessionRole>;

/**
 * Audio-plane surface kind. Adds `'device'` to {@link VoiceAppSurfaceKind} —
 * the voice device firmware terminates control + audio WSS via the host
 * and identifies itself as `'device'` in the session_start frame. Kept
 * separate from `VoiceAppSurfaceKind` so the surface-app `chat.input.source`
 * discriminator (which only ever originates from web/desktop/mobile) is
 * unchanged.
 */
export const AudioSurfaceKind = z.enum(['web', 'desktop', 'mobile', 'device']);
export type AudioSurfaceKind = z.infer<typeof AudioSurfaceKind>;

/**
 * Mode of a sustained session (spec/07 § Session modes). Both hold the mic open
 * for the session's whole length and differ only in what an utterance means:
 *   call        — every utterance is a turn. The phone call.
 *   hands-free  — the line left open for plastering a wall or a long drive. It
 *                 never ends itself on silence, and only an ADDRESSED utterance
 *                 is a turn, so a room full of other people's talk isn't one.
 * Replies are spoken in both. Absent on a voice note or a device session, which
 * have no such policy.
 */
export const AudioSessionMode = z.enum(['call', 'hands-free']);
export type AudioSessionMode = z.infer<typeof AudioSessionMode>;

/** True when the mode only takes utterances addressed to Patch. */
export function modeRequiresAddress(mode: AudioSessionMode): boolean {
  return mode === 'hands-free';
}

// --- voice config (spec/07 § Voice — a config matrix) ----------------------
//
// Shared with the zod schemas in packages/server/src/settings.ts,
// packages/wire/src/events.ts (`host.settings` → `voiceConfig`) and
// packages/host/src/hostState.ts, which each declare their own zod copy of
// this shape (this codebase's established pattern — see e.g. the repeated
// `z.enum(['fallback','native'])` this superseded). This module holds the
// plain TS types and the one place that decides WHICH of the four surfaces
// an incoming session is, so that logic exists exactly once.

export const VoiceBackend = z.enum(['local', 'gemini', 'openai', 'elevenlabs']);
export type VoiceBackend = z.infer<typeof VoiceBackend>;

/**
 * Where dictation's words come from (spec/07 § Dictation engines), named by
 * where the work happens: `device` — the phone's own speech recogniser, on the
 * phone; `deepgram` — streamed to Deepgram as it is spoken; `whisper` — the
 * host's Whisper, which re-reads the recording so far for the live words and
 * the whole clip once it ends.
 */
export const PhoneDictationEngine = z.enum(['device', 'deepgram', 'whisper']);
export type PhoneDictationEngine = z.infer<typeof PhoneDictationEngine>;
/** A computer has no recogniser of its own. */
export const ComputerDictationEngine = z.enum(['deepgram', 'whisper']);
export type ComputerDictationEngine = z.infer<typeof ComputerDictationEngine>;
export type DictationEngine = PhoneDictationEngine;

/**
 * The dictation setting: an engine for the phone app, an engine for web and
 * desktop, and whether Whisper tidies up a live engine's words — each finished
 * phrase read again and swapped in place as dictation goes on.
 */
export interface DictationConfig {
  phone: PhoneDictationEngine;
  computer: ComputerDictationEngine;
  tidy: boolean;
}

/**
 * Reads a dictation setting saved before the phone and computer had engines of
 * their own (`{ backend, phone?, tidy? }`). `deepgram` stays Deepgram, the
 * phone recogniser switch becomes the phone's `device` engine, and the retired
 * hosted transcribers (`gemini`, `openai`) become the host's Whisper.
 */
export function upgradeDictationSetting(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !('backend' in raw)) return raw;
  const old = raw as { backend?: unknown; phone?: unknown; tidy?: unknown };
  const deepgram = old.backend === 'deepgram';
  return {
    phone: old.phone === true ? 'device' : deepgram ? 'deepgram' : 'whisper',
    computer: deepgram ? 'deepgram' : 'whisper',
    tidy: old.tidy === true,
  };
}

export const DictationSetting = z.preprocess(
  upgradeDictationSetting,
  z
    .object({ phone: PhoneDictationEngine, computer: ComputerDictationEngine, tidy: z.boolean() })
    .strict(),
);

/** The engine a dictation from this kind of surface runs on. */
export function dictationEngineFor(
  dictation: DictationConfig,
  surfaceKind: AudioSurfaceKind,
): DictationEngine {
  return surfaceKind === 'mobile' ? dictation.phone : dictation.computer;
}

export const VoiceLayer = z.enum(['direct', 'light', 'heavy']);
export type VoiceLayer = z.infer<typeof VoiceLayer>;

/**
 * Who does the work on a hosted voice (spec/07 § The fast voice and the chat's
 * agent): `auto` — the voice answers what it can and hands the rest to the
 * chat's agent; `always` — the voice only speaks, every request goes to the
 * agent; `never` — the voice answers everything itself and has no hand-off.
 * Meaningless on `local`, where every utterance is the agent's turn.
 */
export const VoiceHandoff = z.enum(['auto', 'always', 'never']);
export type VoiceHandoff = z.infer<typeof VoiceHandoff>;

export interface VoiceSurfaceConfig {
  backend: VoiceBackend;
  layer: VoiceLayer;
  handoff: VoiceHandoff;
}

export interface VoiceConfig {
  dictation: DictationConfig;
  device: VoiceSurfaceConfig;
  handsFree: VoiceSurfaceConfig;
  call: VoiceSurfaceConfig;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  dictation: { phone: 'device', computer: 'whisper', tidy: false },
  device: { backend: 'local', layer: 'direct', handoff: 'auto' },
  handsFree: { backend: 'local', layer: 'direct', handoff: 'auto' },
  call: { backend: 'local', layer: 'direct', handoff: 'auto' },
};

/** The four independently-configurable voice surfaces (spec/07 § Voice). */
export type VoiceSurface = 'dictation' | 'device' | 'hands-free' | 'call';

/**
 * Which of the four surfaces a session belongs to, from the signals already
 * on `audio.session_start`. A voice NOTE and composer DICTATION share
 * `role: 'voice-note'` on the wire (they differ only in how the session ends
 * — committed vs. cancelled, spec/07 § Voice-input modes) and are mechanically
 * identical for config purposes: STT only, no agent turn to front, so both
 * are `'dictation'` here. A physical device is always `'device'`, regardless
 * of whether this particular session is its wake-triggered conversation or an
 * accepted ring — spec/16 treats the device as one surface, not two. Anything
 * else is `role: 'voice-call'`, split by `mode` into `'hands-free'` or
 * `'call'` (`mode` undefined defaults to `'call'`, per `AudioSessionMode`'s
 * own doc comment above).
 */
export function deriveVoiceSurface(args: {
  role: AudioSessionRole;
  surfaceKind: AudioSurfaceKind;
  mode?: AudioSessionMode;
}): VoiceSurface {
  if (args.role === 'voice-note') return 'dictation';
  if (args.surfaceKind === 'device') return 'device';
  if (args.mode === 'hands-free') return 'hands-free';
  return 'call';
}

/** A surface that holds a conversation, as opposed to dictation. */
export type ConversationSurface = Exclude<VoiceSurface, 'dictation'>;

/** The `{backend, layer, handoff}` cell a conversation surface runs on. */
export function voiceCellFor(
  config: VoiceConfig,
  surface: ConversationSurface,
): VoiceSurfaceConfig {
  if (surface === 'hands-free') return config.handsFree;
  return config[surface];
}

/**
 * Whether a sustained session can switch `from` → `to` mode in place. Both
 * modes ride the same session only while they are configured onto the same
 * engine: flipping `call` (say, gemini/light) to `hands-free` (local/direct)
 * in place would keep running the engine the NEW mode is not configured for.
 * When this is false the surface ends the session and opens a fresh one in
 * the new mode, and the host refuses an in-place `audio.mode` switch.
 */
export function modesShareVoiceEngine(
  config: VoiceConfig,
  from: AudioSessionMode,
  to: AudioSessionMode,
): boolean {
  const a = voiceCellFor(config, from === 'hands-free' ? 'hands-free' : 'call');
  const b = voiceCellFor(config, to === 'hands-free' ? 'hands-free' : 'call');
  return a.backend === b.backend && a.layer === b.layer && a.handoff === b.handoff;
}

/** A backend that runs on a provider's API and so needs a key on the host. */
export type HostedVoiceBackend = Exclude<VoiceBackend, 'local'> | 'deepgram';

/** The env var each hosted backend reads its key from on a host. */
export const VOICE_BACKEND_KEY_ENV: Record<HostedVoiceBackend, string> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_REALTIME_API_KEY',
  elevenlabs: 'ELEVEN_LABS_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
};

/** How each surface is named on every screen, Settings → Voice included. */
export const VOICE_SURFACE_LABEL: Record<VoiceSurface, string> = {
  dictation: 'Dictation',
  device: 'Voice device',
  'hands-free': 'Hands-free',
  call: 'Call',
};

/**
 * Which provider keys one host holds (reported on `host.host.voiceKeys`).
 * A key being absent is not a host fault — it only matters for a surface
 * configured onto that provider, and it fails that surface's sessions, never
 * the host.
 */
export interface VoiceKeys {
  gemini: boolean;
  openai: boolean;
  /** Absent on a host older than ElevenLabs Agents, which cannot run it. */
  elevenlabs?: boolean;
  /** Absent on a host older than Deepgram dictation, which cannot run it. */
  deepgram?: boolean;
}

/**
 * THE sentence for a session refused because its surface's backend has no key
 * on this host. One copy, so the host's refusal, its boot log and every
 * surface's error say exactly the same thing.
 */
export function voiceKeyMissingMessage(surface: VoiceSurface, backend: HostedVoiceBackend): string {
  const label = VOICE_SURFACE_LABEL[surface];
  return (
    `${label} is set to ${backend}, but ${VOICE_BACKEND_KEY_ENV[backend]} is not set on this host. ` +
    `Switch ${label} to another backend in Settings → Voice.`
  );
}

/**
 * Settings → Voice's line for a cell on `backend`: which hosts cannot run it
 * because they lack its key, or null when every host that has reported can (or
 * the backend is `local`). A host that has not reported `voiceKeys` is not
 * counted either way.
 */
export function voiceKeyHostStatus(
  backend: VoiceBackend | DictationEngine,
  hosts: ReadonlyArray<{ hostName: string; voiceKeys?: VoiceKeys | undefined }>,
): string | null {
  if (backend === 'local' || backend === 'device' || backend === 'whisper') return null;
  const missing = hosts.filter((h) => h.voiceKeys !== undefined && h.voiceKeys[backend] !== true);
  if (missing.length === 0) return null;
  const names = missing.map((h) => h.hostName).join(', ');
  return `Not configured on ${names}: ${VOICE_BACKEND_KEY_ENV[backend]} is missing. Sessions there are refused.`;
}

/**
 * Every surface whose configured backend has no key on a host holding `keys`,
 * in Settings order. Empty when every configured backend can run.
 */
export function voiceSurfacesMissingKey(
  config: VoiceConfig,
  keys: VoiceKeys,
): Array<{ surface: VoiceSurface; backend: HostedVoiceBackend; env: string }> {
  const out: Array<{ surface: VoiceSurface; backend: HostedVoiceBackend; env: string }> = [];
  const { phone, computer } = config.dictation;
  if ((phone === 'deepgram' || computer === 'deepgram') && keys.deepgram !== true) {
    out.push({ surface: 'dictation', backend: 'deepgram', env: VOICE_BACKEND_KEY_ENV.deepgram });
  }
  const surfaces: ConversationSurface[] = ['device', 'hands-free', 'call'];
  for (const surface of surfaces) {
    const { backend } = voiceCellFor(config, surface);
    if (backend === 'local' || keys[backend] === true) continue;
    out.push({ surface, backend, env: VOICE_BACKEND_KEY_ENV[backend] });
  }
  return out;
}

/**
 * Surface → host control frame; FIRST frame after WS upgrade.
 * Carries the one-shot voice session token minted by the server's
 * `POST /api/voice/token`. Host verifies the token, binds the WS to
 * the (accountId, surfaceId, sessionId) triple, then transitions to
 * 'listening'.
 */
export const AudioSessionStartEvent = z
  .object({
    type: z.literal('audio.session_start'),
    sessionId: z.string().min(1),
    accountId: z.string().min(1),
    surfaceId: z.string().min(1),
    surfaceKind: AudioSurfaceKind,
    chatId: z.string().min(1),
    role: AudioSessionRole,
    /**
     * Raw token. Schema accepts any string; the host's token-verifier
     * rejects empty/missing/malformed values with `auth_failed` instead
     * of the generic `invalid_frame` (group 14, DX m6).
     */
    token: z.string(),
    /**
     * Whether the surface has hardware/OS-level AEC (phone, browser).
     * If true, host-side AEC3 is bypassed for this session. The voice
     * device sets this to false — the host must run AEC there.
     */
    surfaceHasAec: z.boolean(),
    /**
     * Daemon-minted voice token forwarded to a `surfaceKind: 'device'`
     * session via the control-plane `session_start` frame (B-23-3
     * recommended resolution: host pushes the token rather than the
     * device calling `POST /api/voice/token` itself). Optional because
     * web/desktop/mobile surfaces continue to mint their own tokens via
     * the server HTTP route and place the result in `token` above.
     */
    voiceToken: z.string().optional(),
    /**
     * Physical voice-device identity (kitchen, bedroom, …). Present iff
     * `surfaceKind === 'device'` — the host's audio server enforces that
     * coupling at `session_start` (it rejects a device session with no
     * deviceId, and a non-device session that supplies one). It is the
     * deviceId the device announced over the host control plane; the host
     * stamps it onto the resulting `chat.input.source` (`kind: 'voice-device'`)
     * so the Speakers thread is tagged `[voice • device:<deviceId>]` and the
     * reply auto-routes TTS back to the originating device (spec/06 ## Reply
     * routing, spec/16).
     */
    deviceId: z.string().min(1).optional(),
    /**
     * Mode the session opens in (spec/07 § Session modes). Only meaningful for
     * `role: 'voice-call'`; omitted, the host treats the session as `call`,
     * which is what every other role is.
     */
    mode: AudioSessionMode.optional(),
    /**
     * The account's address word — what an utterance has to open with to become
     * a turn while the session is quiet (spec/07 § Temperaments). Carried by the
     * surface, which is where the setting is edited; omitted, the host uses
     * its default.
     */
    addressWord: z.string().min(1).optional(),
  })
  .strict();
export type AudioSessionStartEvent = z.infer<typeof AudioSessionStartEvent>;

/**
 * Surface → host: switch the open session's mode. Nothing is torn down — the
 * transport, the chat and the audio plane are identical across all three, and
 * only the turn-taking and audio policy differ.
 */
export const AudioModeEvent = z
  .object({
    type: z.literal('audio.mode'),
    sessionId: z.string().min(1),
    mode: AudioSessionMode,
  })
  .strict();
export type AudioModeEvent = z.infer<typeof AudioModeEvent>;

/**
 * Surface → host: synthesise and play `text` on this session, with no chat
 * turn behind it (spec/07 § Speaking with no session open). This is how an
 * `auto-notify` interrupt is spoken on a surface that is not in a conversation:
 * the surface opens a session that never starts its microphone, asks for the
 * message, plays it, and closes. There is no reply path — the host runs
 * Kokoro and streams the audio back, and that is all.
 */
export const AudioSpeakEvent = z
  .object({
    type: z.literal('audio.speak'),
    sessionId: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();
export type AudioSpeakEvent = z.infer<typeof AudioSpeakEvent>;

/**
 * True iff the `surfaceKind` / `deviceId` coupling on an `audio.session_start`
 * is valid: device sessions MUST carry a deviceId; non-device sessions MUST
 * NOT. Returns an error string when invalid, or null when valid.
 */
export function validateDeviceIdCoupling(start: AudioSessionStartEvent): string | null {
  if (start.surfaceKind === 'device' && start.deviceId === undefined) {
    return "deviceId is required when surfaceKind === 'device'";
  }
  if (start.surfaceKind !== 'device' && start.deviceId !== undefined) {
    return "deviceId is only valid when surfaceKind === 'device'";
  }
  return null;
}

/**
 * Ends the session, either direction. `spec/03-wire-protocol.md` documents the
 * payload as `{reason}` alone, and that IS sufficient: one WS carries exactly
 * one session, whose id is already in the URL path (`/audio/<sessionId>`) and
 * bound by the verified token. `sessionId` is therefore OPTIONAL — a
 * spec-conformant client that sends only `{reason}` is accepted. When it IS
 * present the host requires it to match the bound session rather than
 * ignoring it (see audio/server.ts).
 */
export const AudioSessionEndEvent = z
  .object({
    type: z.literal('audio.session_end'),
    sessionId: z.string().min(1).optional(),
    /**
     * Why the session ended. `committed` / `cancelled` for a voice note (the
     * gesture-commit vs Esc), otherwise a human-readable reason.
     */
    reason: z.string().optional(),
  })
  .strict();
export type AudioSessionEndEvent = z.infer<typeof AudioSessionEndEvent>;

/**
 * Surface → host: the user has stopped dictating on a streaming engine
 * (spec/07 § Dictation engines). The host flushes the engine, waits for the
 * last words (and, with tidy-up on, for Whisper's pass over the last phrase)
 * and answers with one `audio.transcript_final` carrying the whole dictation.
 * The live text already is the transcript, so nothing is transcribed again.
 */
export const AudioDictationFinishEvent = z
  .object({
    type: z.literal('audio.dictation_finish'),
    sessionId: z.string().min(1),
  })
  .strict();
export type AudioDictationFinishEvent = z.infer<typeof AudioDictationFinishEvent>;

// --- streaming frames ------------------------------------------------------

/**
 * JSON announcement that a binary PCM blob follows on the SAME WS in the
 * very next frame. PCM16 frames are sent as binary WS messages: this event
 * is the metadata wrapper used when serialising a fixture stream into JSON
 * (e.g. tests, the model-bootstrap clip player). At runtime the binary
 * frame is interleaved with these JSON envelopes.
 */
export const AudioPcm16Event = z
  .object({
    type: z.literal('audio.pcm16'),
    /** ms-since-epoch when the chunk was captured / synthesised. */
    ts: z.number().int().nonnegative(),
    /** 16 kHz from surface, 24 kHz from host. */
    sampleRate: z.union([z.literal(16000), z.literal(24000)]),
    /** Number of int16 samples in the upcoming binary frame. */
    samples: z.number().int().positive(),
  })
  .strict();
export type AudioPcm16Event = z.infer<typeof AudioPcm16Event>;

// --- STT events ------------------------------------------------------------

export const AudioTranscriptPartialEvent = z
  .object({
    type: z.literal('audio.transcript_partial'),
    sessionId: z.string().min(1),
    text: z.string(),
  })
  .strict();
export type AudioTranscriptPartialEvent = z.infer<typeof AudioTranscriptPartialEvent>;

export const AudioTranscriptFinalEvent = z
  .object({
    type: z.literal('audio.transcript_final'),
    sessionId: z.string().min(1),
    text: z.string(),
    /** ms — STT latency from VAD-end to final transcript, for the budget telemetry. */
    sttLatencyMs: z.number().int().nonnegative().optional(),
    /**
     * Whether the utterance was addressed to Patch and so became a user turn.
     * Only ever `false` in a `waiting` or `working` session, for speech the mic
     * heard that was not addressed to it (spec/07 § Session modes) — the host
     * discards that text rather than delivering it, and the surface shows it as
     * heard-but-not-sent so the user can see the mic is alive. Omitted means
     * addressed.
     */
    addressed: z.boolean().optional(),
  })
  .strict();
export type AudioTranscriptFinalEvent = z.infer<typeof AudioTranscriptFinalEvent>;

// --- TTS events ------------------------------------------------------------

/** Host → surface JSON envelope: a TTS PCM chunk follows. */
export const AudioTtsChunkEvent = z
  .object({
    type: z.literal('audio.tts_chunk'),
    sessionId: z.string().min(1),
    samples: z.number().int().positive(),
    /** ms — Kokoro first-frame latency from text to audio, for the budget. */
    firstFrameLatencyMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type AudioTtsChunkEvent = z.infer<typeof AudioTtsChunkEvent>;

export const AudioTtsEndEvent = z
  .object({
    type: z.literal('audio.tts_end'),
    sessionId: z.string().min(1),
    /** True when Kokoro was halted mid-stream by barge-in. */
    bargedIn: z.boolean().optional(),
  })
  .strict();
export type AudioTtsEndEvent = z.infer<typeof AudioTtsEndEvent>;

// --- session state (surface-visible progress) ------------------------------

/**
 * The five phases of a voice session's turn cycle (mirrors
 * `VoiceSession['state']` in the host). Surfaces render this so the user can
 * SEE where the session is instead of an ambiguous "on call":
 *   connecting   — pre-session (the surface owns this locally before the WS is live)
 *   listening    — mic open, waiting for / hearing speech
 *   transcribing — end-of-utterance detected, STT running
 *   thinking     — transcript committed, the agent turn is running
 *   speaking     — TTS is streaming back
 */
export const AudioSessionStateName = z.enum([
  'connecting',
  'listening',
  'transcribing',
  'thinking',
  'speaking',
]);
export type AudioSessionStateName = z.infer<typeof AudioSessionStateName>;

/**
 * Host → surface: a session-state transition. Emitted on every meaningful
 * edge of the turn cycle (spec/15 § Voice states) so the call overlay can drive
 * a live LISTENING → TRANSCRIBING → THINKING → SPEAKING indicator from the wire
 * rather than guessing. NOT emitted to `surfaceKind: 'device'` sessions (the
 * firmware ignores unknown control frames; keep its wire byte-identical). The
 * return-to-listening after TTS is signalled by `audio.tts_end`, so no state
 * frame follows a `tts_end` (surfaces map tts_end → listening themselves).
 */
export const AudioStateEvent = z
  .object({
    type: z.literal('audio.state'),
    sessionId: z.string().min(1),
    state: AudioSessionStateName,
  })
  .strict();
export type AudioStateEvent = z.infer<typeof AudioStateEvent>;

// --- barge-in + errors -----------------------------------------------------

export const AudioBargeInEvent = z
  .object({
    type: z.literal('audio.barge_in'),
    sessionId: z.string().min(1),
    /** ms — when the VAD fired during a 'speaking' state. */
    at: z.number().int().nonnegative(),
  })
  .strict();
export type AudioBargeInEvent = z.infer<typeof AudioBargeInEvent>;

export const AudioErrorCode = z.enum([
  'auth_failed',
  'token_expired',
  'token_replayed',
  'concurrency_cap',
  'whisper_unavailable',
  'kokoro_unavailable',
  /**
   * The microphone has delivered nothing but digital silence for the first 5
   * seconds of audio (spec/07). On macOS that is what an app without
   * microphone permission is given instead of an error.
   */
  'mic_silent',
  /**
   * Native-tier (Gemini Live) session could not open or died mid-session —
   * a rejected connection or a backend error (a missing key is
   * `voice_key_missing`). Kept
   * distinct from `whisper_unavailable`/`kokoro_unavailable` because the
   * native tier has no separate STT/TTS stage to blame (spec/07 § Native).
   */
  'gemini_unavailable',
  /**
   * OpenAI Realtime counterpart of `gemini_unavailable`: the hosted session
   * could not open (rejected connection) or died / errored mid-session. Also raised when an OpenAI transcription
   * request for dictation fails. Never answered by quietly running `local`.
   */
  'openai_unavailable',
  /** ElevenLabs Agents counterpart of `openai_unavailable`. Never answered by running another backend. */
  'elevenlabs_unavailable',
  'sdk_error',
  'invalid_frame',
  'session_not_found',
  /**
   * The chat's host is offline, or is online but has not declared an
   * `audioRelayHost` the server can reach it at (spec/07 § Voice is a
   * per-host capability — a host the server cannot reach only dials OUT to
   * it, so a voice session for a chat there has to be relayed and the relay
   * has nowhere to go). Raised by the SERVER before any audio is accepted,
   * mirroring `session_not_found`'s own before-any-audio timing.
   */
  'host_unreachable',
  /**
   * The surface's `voiceConfig` cell is accepted by the settings schema but
   * has no implementation yet (spec/07 § Voice — a config matrix). NO SILENT
   * FALLBACK: refuse the session loudly rather than quietly running a
   * different engine than the one configured.
   */
  'voice_config_not_implemented',
  /**
   * The surface is configured onto a hosted backend whose key this host does
   * not hold. `message` is `voiceKeyMissingMessage(...)` — a complete sentence
   * naming the key and the Settings → Voice fix — and surfaces show it as is.
   * Never answered by running `local` instead; never a reason not to boot.
   */
  'voice_key_missing',
  /**
   * Dictation on the `deepgram` engine: the streaming connection could not
   * open, or Deepgram failed mid-dictation. The live words ARE the transcript
   * on this engine, so the dictation has failed and the surface says so. Never
   * answered by quietly transcribing with another engine.
   */
  'deepgram_unavailable',
]);
export type AudioErrorCode = z.infer<typeof AudioErrorCode>;

export const AudioErrorEvent = z
  .object({
    type: z.literal('audio.error'),
    code: AudioErrorCode,
    message: z.string(),
    sessionId: z.string().min(1).optional(),
  })
  .strict();
export type AudioErrorEvent = z.infer<typeof AudioErrorEvent>;

// --- union -----------------------------------------------------------------

export const AudioEvent = z.discriminatedUnion('type', [
  AudioSessionStartEvent,
  AudioSessionEndEvent,
  AudioModeEvent,
  AudioSpeakEvent,
  AudioDictationFinishEvent,
  AudioPcm16Event,
  AudioTranscriptPartialEvent,
  AudioTranscriptFinalEvent,
  AudioTtsChunkEvent,
  AudioTtsEndEvent,
  AudioStateEvent,
  AudioBargeInEvent,
  AudioErrorEvent,
]);
export type AudioEvent = z.infer<typeof AudioEvent>;
export type AudioEventType = AudioEvent['type'];

export const AUDIO_EVENT_SCHEMAS = {
  'audio.session_start': AudioSessionStartEvent,
  'audio.session_end': AudioSessionEndEvent,
  'audio.mode': AudioModeEvent,
  'audio.speak': AudioSpeakEvent,
  'audio.dictation_finish': AudioDictationFinishEvent,
  'audio.pcm16': AudioPcm16Event,
  'audio.transcript_partial': AudioTranscriptPartialEvent,
  'audio.transcript_final': AudioTranscriptFinalEvent,
  'audio.tts_chunk': AudioTtsChunkEvent,
  'audio.tts_end': AudioTtsEndEvent,
  'audio.state': AudioStateEvent,
  'audio.barge_in': AudioBargeInEvent,
  'audio.error': AudioErrorEvent,
} as const satisfies Record<AudioEventType, z.ZodTypeAny>;

export function encodeAudio(event: AudioEvent): string {
  return JSON.stringify(event);
}

export function decodeAudio(raw: string | Buffer | ArrayBuffer | Uint8Array): AudioEvent {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (raw instanceof Uint8Array) text = Buffer.from(raw).toString('utf8');
  else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString('utf8');
  else throw new Error('decodeAudio: unsupported frame type');
  const parsed: unknown = JSON.parse(text);
  return AudioEvent.parse(parsed);
}

/**
 * Dictation preview before a chat exists (the new-chat screen): the voice
 * session is scoped to a HOST, named `draft:<hostId>` in place of a chatId.
 * Only the `voice-note` role may use it — it carries no chat context.
 */
export const DRAFT_DICTATION_PREFIX = 'draft:';

export function draftDictationChatId(hostId: string): string {
  return `${DRAFT_DICTATION_PREFIX}${hostId}`;
}

/** The host a `draft:<hostId>` pseudo-chat id names, or null for a real chat id. */
export function draftDictationHostId(chatId: string): string | null {
  return chatId.startsWith(DRAFT_DICTATION_PREFIX) && chatId.length > DRAFT_DICTATION_PREFIX.length
    ? chatId.slice(DRAFT_DICTATION_PREFIX.length)
    : null;
}
