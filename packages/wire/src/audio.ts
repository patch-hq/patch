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
import type { VoiceAgentSetting } from './voiceEngines.js';

// --- session lifecycle -----------------------------------------------------

/**
 * `announcement`: an `auto-notify` interrupt spoken on a surface not in a
 * call (spec/07 § Speaking with no session open) — the host reads the text
 * aloud with its own speech engine; no microphone, no voice agent, no call.
 */
export const AudioSessionRole = z.enum([
  'voice-note',
  'voice-call',
  'voice-device-conv',
  'announcement',
]);
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

// --- voice config (spec/07) -------------------------------------------------
//
// The zod schema is `VoiceConfigSetting` in events.ts; this module holds the
// plain TS types and the one place that decides which surface an incoming
// session is and which backend it runs on.

export const VoiceBackend = z.enum(['local', 'gemini', 'openai', 'elevenlabs']);
export type VoiceBackend = z.infer<typeof VoiceBackend>;

/**
 * Where dictation's words come from (spec/07 § Dictation engines), named by
 * where the work happens: `device` — the phone's own speech recogniser, on the
 * phone; `deepgram` / `elevenlabs` — streamed to Deepgram or ElevenLabs Scribe
 * as it is spoken; `host` — streamed to a streaming speech model on the host,
 * each finished phrase then read once by the host's accurate transcriber;
 * `whisper` — the host's Whisper, which re-reads the recording so far for the
 * live words and the whole clip once it ends. A computer (web/desktop) can
 * also pick `local` — Parakeet run in the desktop app on that computer, never
 * on the host; the host refuses a session that asks for it.
 */
export const PhoneDictationEngine = z.enum(['device', 'deepgram', 'elevenlabs', 'host', 'whisper']);
export type PhoneDictationEngine = z.infer<typeof PhoneDictationEngine>;
/** A computer has no recogniser of its own, only the one the desktop app carries (`local`). */
export const ComputerDictationEngine = z.enum([
  'deepgram',
  'elevenlabs',
  'host',
  'whisper',
  'local',
]);
export type ComputerDictationEngine = z.infer<typeof ComputerDictationEngine>;
export type DictationEngine = PhoneDictationEngine | ComputerDictationEngine;

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

/** Any dictation engine, for a device's own choice (`deviceDictation`). */
export const DictationEngineSchema = z.enum([
  'device',
  'deepgram',
  'elevenlabs',
  'host',
  'whisper',
  'local',
]);

/**
 * Engines a device of this kind can run: the phone's recogniser only on a
 * phone, Parakeet only in the desktop app (a browser cannot carry it).
 */
export function dictationEnginesFor(surfaceKind: AudioSurfaceKind): readonly DictationEngine[] {
  if (surfaceKind === 'mobile') return PhoneDictationEngine.options;
  if (surfaceKind === 'desktop') return ComputerDictationEngine.options;
  return ComputerDictationEngine.options.filter((e) => e !== 'local');
}

/**
 * The engine a dictation runs on. Each device picks its own (`deviceDictation`,
 * by surface id); a device that has not picked one yet runs on the engine set
 * for its kind in `voiceConfig.dictation`, which is also what Settings shows
 * for it. A choice the device cannot run is refused, never swapped.
 */
export function dictationEngineFor(
  dictation: DictationConfig,
  surfaceKind: AudioSurfaceKind,
  own?: {
    surfaceId?: string | undefined;
    deviceDictation?: Record<string, DictationEngine> | undefined;
  },
): DictationEngine {
  const chosen = own?.surfaceId !== undefined ? own.deviceDictation?.[own.surfaceId] : undefined;
  if (chosen !== undefined) {
    if (!dictationEnginesFor(surfaceKind).includes(chosen)) {
      throw new Error(
        `This device's dictation engine (${chosen}) does not run on a ${surfaceKind === 'mobile' ? 'phone' : surfaceKind === 'desktop' ? 'computer' : 'browser'}. Pick another in Settings → Dictation.`,
      );
    }
    return chosen;
  }
  return surfaceKind === 'mobile' ? dictation.phone : dictation.computer;
}

/**
 * What reads speech on a turn-based call (backend `local`), and tidies each
 * dictation phrase (spec/07 § Speech to text): `groq` — Groq Whisper over the
 * network; `whisper` — Whisper on the host; `parakeet` — Parakeet on the host;
 * `elevenlabs` — ElevenLabs Scribe. An account setting, not host config. A host
 * that cannot run the chosen one refuses the call and says which.
 */
export const SpeechToTextEngine = z.enum(['groq', 'whisper', 'parakeet', 'elevenlabs']);
export type SpeechToTextEngine = z.infer<typeof SpeechToTextEngine>;
export const DEFAULT_SPEECH_TO_TEXT: SpeechToTextEngine = 'groq';
export const SPEECH_TO_TEXT_LABEL: Record<SpeechToTextEngine, string> = {
  groq: 'Groq Whisper',
  whisper: 'Whisper on host',
  parakeet: 'Parakeet on host',
  elevenlabs: 'ElevenLabs Scribe',
};

/**
 * Who does the work on a hosted voice (spec/07 § The fast voice and the chat's
 * agent): `auto` — the voice answers what it can and hands the rest to the
 * chat's agent; `always` — the voice only speaks, every request goes to the
 * agent; `never` — the voice answers everything itself and has no hand-off.
 * Meaningless on `local`, where every utterance is the agent's turn.
 */
export const VoiceHandoff = z.enum(['auto', 'always', 'never']);
export type VoiceHandoff = z.infer<typeof VoiceHandoff>;

/**
 * Who transcribes a meeting (spec/07): `local` — Parakeet on the computer
 * running the meeting; `elevenlabs`, `deepgram` (Nova-3) and `assemblyai`
 * (Universal) — a paid hosted engine, each with its own speaker separation.
 * Chosen explicitly and never a fallback: a missing key fails the clip.
 */
export const MeetingEngine = z.enum(['local', 'elevenlabs', 'deepgram', 'assemblyai']);
export type MeetingEngine = z.infer<typeof MeetingEngine>;

/**
 * How a voice device's conversation is answered (spec/16): by the account's
 * voice agent, or directly, with speech on the chat's host.
 */
export const DeviceAnswer = z.enum(['agent', 'direct']);
export type DeviceAnswer = z.infer<typeof DeviceAnswer>;

export interface VoiceConfig {
  speechToText: SpeechToTextEngine;
  dictation: DictationConfig;
  meeting: MeetingEngine;
  deviceAnswer: DeviceAnswer;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  speechToText: DEFAULT_SPEECH_TO_TEXT,
  dictation: { phone: 'device', computer: 'whisper', tidy: false },
  meeting: 'local',
  deviceAnswer: 'direct',
};

// --- the voice agent (spec/07 § The voice agent) ---------------------------
//
// What each engine offers is described once, in voiceEngines.ts, and that one
// description drives Settings on every surface and the host's provider config.
export * from './voiceEngines.js';

/**
 * The providers a host reads lists from for Settings → Voice calls: the voice
 * agent providers, and Groq, whose speech to text a direct call can use.
 */
export const CatalogProvider = z.enum(['gemini', 'openai', 'elevenlabs', 'groq']);
export type CatalogProvider = z.infer<typeof CatalogProvider>;
export const CATALOG_PROVIDER_LABEL: Record<CatalogProvider, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  elevenlabs: 'ElevenLabs',
  groq: 'Groq',
};

/**
 * What a host read from a provider's API for Settings → Voice calls: its
 * realtime models and voices (the voice agent), its text to speech models and
 * voices and its speech to text models (direct calls). `error` says why a read
 * failed; the lists are then absent. A list the provider's API does not offer
 * (Gemini's and OpenAI's voices, ElevenLabs' Scribe models) is the one its
 * documentation names.
 */
const CatalogItem = z.object({ id: z.string().min(1), label: z.string() });
export type CatalogItem = z.infer<typeof CatalogItem>;
export const VoiceCatalogEntry = z.object({
  models: z.array(CatalogItem).optional(),
  voices: z.array(CatalogItem).optional(),
  /** Text to speech models (ElevenLabs, OpenAI). */
  speechModels: z.array(CatalogItem).optional(),
  /** Text to speech voices where they are not `voices` (OpenAI's speech voices). */
  speechVoices: z.array(CatalogItem).optional(),
  /** Speech to text models (Groq, ElevenLabs). */
  transcriptionModels: z.array(CatalogItem).optional(),
  error: z.string().optional(),
  /** Epoch ms of the read. */
  at: z.number().int().nonnegative(),
});
export type VoiceCatalogEntry = z.infer<typeof VoiceCatalogEntry>;
export const VoiceCatalog = z.object({
  gemini: VoiceCatalogEntry.optional(),
  openai: VoiceCatalogEntry.optional(),
  elevenlabs: VoiceCatalogEntry.optional(),
  groq: VoiceCatalogEntry.optional(),
});
export type VoiceCatalog = z.infer<typeof VoiceCatalog>;

/** What Settings shows for a provider's lists. */
export type VoiceCatalogView =
  | { state: 'ready'; entry: VoiceCatalogEntry; hostName: string }
  | { state: 'loading' }
  | { state: 'failed'; message: string }
  | { state: 'no-key' };

/**
 * The read Settings → Voice calls lists a provider's models and voices from:
 * the freshest successful read any host has made, online hosts first. With
 * none, the failure says why; a host with the key that has not read yet is
 * loading; no host with the key says so rather than showing an empty list.
 */
export interface CatalogHost {
  hostName: string;
  online: boolean;
  voiceKeys?: Partial<Record<CatalogProvider, boolean | undefined>> | undefined;
  voiceCatalog?: VoiceCatalog | undefined;
}

export function voiceCatalogView(
  provider: CatalogProvider,
  hosts: ReadonlyArray<CatalogHost>,
): VoiceCatalogView {
  const reads = hosts
    .flatMap((h) => {
      const entry = h.voiceCatalog?.[provider];
      return entry ? [{ h, entry }] : [];
    })
    .sort((a, b) => Number(b.h.online) - Number(a.h.online) || b.entry.at - a.entry.at);
  const ok = reads.find((r) => r.entry.error === undefined);
  if (ok) return { state: 'ready', entry: ok.entry, hostName: ok.h.hostName };
  const failed = reads[0];
  if (failed) return { state: 'failed', message: `${failed.h.hostName}: ${failed.entry.error}` };
  if (hosts.some((h) => h.voiceKeys?.[provider] === true)) return { state: 'loading' };
  return { state: 'no-key' };
}

/** What a voice session is (spec/07): dictation, a voice device, a call in either mode, or a spoken alert. */
export type VoiceSurface = 'dictation' | 'device' | 'hands-free' | 'call' | 'announcement';

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
 * own doc comment above). `role: 'announcement'` is a spoken alert.
 */
export function deriveVoiceSurface(args: {
  role: AudioSessionRole;
  surfaceKind: AudioSurfaceKind;
  mode?: AudioSessionMode;
}): VoiceSurface {
  if (args.role === 'voice-note') return 'dictation';
  if (args.role === 'announcement') return 'announcement';
  if (args.surfaceKind === 'device') return 'device';
  if (args.mode === 'hands-free') return 'hands-free';
  return 'call';
}

/** A surface that holds a conversation, as opposed to dictation or a spoken alert. */
export type ConversationSurface = Exclude<VoiceSurface, 'dictation' | 'announcement'>;

/**
 * The backend a conversation surface runs on. A call and hands-free are always
 * voice agent calls (spec/07 § Two kinds of call), on the account's one voice
 * agent setup; a voice device answers on the voice agent too unless its own
 * setting has it answer directly, with speech on the chat's host (`local`).
 */
export function voiceBackendFor(
  config: VoiceConfig,
  agent: VoiceAgentSetting,
  surface: ConversationSurface,
): VoiceBackend {
  if (surface === 'device' && config.deviceAnswer === 'direct') return 'local';
  return agent.provider;
}

/** A backend that runs on a provider's API and so needs a key on the host. */
export type HostedVoiceBackend =
  | Exclude<VoiceBackend, 'local'>
  | 'deepgram'
  | 'elevenlabs'
  | 'assemblyai';

/** The env var each hosted backend's key may come from on a host. Logs only — never shown to a person. */
export const VOICE_BACKEND_KEY_ENV: Record<HostedVoiceBackend, string> = {
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_REALTIME_API_KEY',
  elevenlabs: 'ELEVEN_LABS_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
  assemblyai: 'ASSEMBLYAI_API_KEY',
};

/** How each hosted backend's key is named to a person; never its env var. */
export const VOICE_BACKEND_KEY_LABEL: Record<HostedVoiceBackend, string> = {
  gemini: 'Gemini key',
  openai: 'OpenAI key',
  deepgram: 'Deepgram key',
  elevenlabs: 'ElevenLabs key',
  assemblyai: 'AssemblyAI key',
};

/** How each surface is named on every screen, Settings → Voice included. */
export const VOICE_SURFACE_LABEL: Record<VoiceSurface, string> = {
  dictation: 'Dictation',
  device: 'Voice device',
  'hands-free': 'Hands-free',
  call: 'Call',
  announcement: 'Spoken alert',
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
  groq: boolean;
  /** Absent on a host older than ElevenLabs (Agents, Scribe), which cannot run it. */
  elevenlabs?: boolean;
  /** Absent on a host older than Deepgram dictation, which cannot run it. */
  deepgram?: boolean;
  /** Absent on a host older than AssemblyAI meetings, which cannot run it. */
  assemblyai?: boolean;
}

export * from './voiceReadiness.js';

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
    /**
     * Move a call here: the host closes every other `call` session on the same
     * chat (reason `transferred`) before this one opens, so the call is on one
     * device at a time (`07-voice-app.md` § A call can move between devices).
     */
    takeOver: z.boolean().optional(),
    /**
     * A surface redialling a call whose line dropped: the session it was last
     * live on. The host, which holds that session for `CALL_RESUME_WINDOW_MS`,
     * puts this connection back on it; a session it no longer holds (the
     * window ran out, the host restarted) ends the call with `ended_by_agent`:
     * it never opens a new one (`07-voice-app.md` § A dropped call comes back).
     */
    resumes: z.string().min(1).optional(),
    /**
     * The reason an agent gave when it called the user (`patch_call`), on the
     * call that answers it. The voice agent opens the call by saying it
     * (`07-voice-app.md` § Agent-initiated voice).
     */
    callReason: z.string().min(1).max(2000).optional(),
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
 * rather than guessing. Voice devices get it too, so any device can show what
 * the session is doing without inferring it. The
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

/**
 * Host -> surface: the voice agent moved the call to another chat with its
 * switch chat tool (spec/07 § A call stays on its chat). The call carries on;
 * the surface's call bar names the new chat from here on.
 */
export const AudioChatSwitchedEvent = z
  .object({
    type: z.literal('audio.chat_switched'),
    sessionId: z.string().min(1),
    chatId: z.string().min(1),
  })
  .strict();
export type AudioChatSwitchedEvent = z.infer<typeof AudioChatSwitchedEvent>;

/**
 * Host -> surface: the voice agent passed a request to the chat's agent and it
 * is queued (pass to agent answered "received"). The device plays the passed
 * to agent sound (spec/07 § Call sounds).
 */
export const AudioPassedToAgentEvent = z
  .object({
    type: z.literal('audio.passed_to_agent'),
    sessionId: z.string().min(1),
  })
  .strict();
export type AudioPassedToAgentEvent = z.infer<typeof AudioPassedToAgentEvent>;

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
   * The host has not installed its voice component (onnxruntime, sherpa-onnx
   * and the VAD / turn models), which the local voice pipeline cannot run
   * without. `message` names the component and where to install it. Never
   * answered by running without voice activity detection.
   */
  'voice_component_missing',
  /**
   * Dictation on the `deepgram` engine: the streaming connection could not
   * open, or Deepgram failed mid-dictation. The live words ARE the transcript
   * on this engine, so the dictation has failed and the surface says so. Never
   * answered by quietly transcribing with another engine.
   */
  'deepgram_unavailable',
  /** The same, for dictation on the `elevenlabs` (Scribe) engine. */
  'elevenlabs_unavailable',
  /**
   * The catch-up on a chat's earlier messages, written by a small job while a
   * voice agent call connects (spec/07 § Keeping voice and text as one
   * conversation), failed. The call carries on without it; the surface shows it.
   */
  'catch_up_failed',
  /**
   * One of the voice agent's tools failed (a request could not be passed to
   * the chat's agent, a chat could not be read). The voice agent is told too;
   * the call carries on.
   */
  'voice_tool_failed',
]);
export type AudioErrorCode = z.infer<typeof AudioErrorCode>;

/**
 * The errors a call carries on through: shown on the call bar, never a reason
 * to end the call. Every other `audio.error` ends it.
 */
export const AUDIO_NOTICE_CODES: ReadonlySet<AudioErrorCode> = new Set([
  'catch_up_failed',
  'voice_tool_failed',
]);

export const AudioErrorEvent = z
  .object({
    type: z.literal('audio.error'),
    code: AudioErrorCode,
    message: z.string(),
    sessionId: z.string().min(1).optional(),
  })
  .strict();
export type AudioErrorEvent = z.infer<typeof AudioErrorEvent>;

// --- line liveness + call log (spec/07 § A dropped call comes back) ---------

/** How often the host sends a heartbeat on a call. */
export const HEARTBEAT_INTERVAL_MS = 1_000;
/**
 * A surface that has heard nothing from the host for this long treats the line
 * as lost: three missed heartbeats, so one late frame is not a drop.
 */
export const HEARTBEAT_LOST_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS;

/**
 * How long the host keeps a call's session after its device's line goes quiet,
 * waiting for the device to resume it (spec/07 § Fixed timings): about the
 * span of the device's redial schedule, so a stall or a release restarting
 * the server is ridden out, while a phone that is gone for good costs the
 * provider two minutes of silence.
 */
export const CALL_RESUME_WINDOW_MS = 120_000;

/**
 * Both ways on every app audio session. The host sends one every `HEARTBEAT_INTERVAL_MS`,
 * numbered from 0 per session and carrying the round trip it last measured;
 * the surface echoes each back with the same `n` and no `rttMs`, which is how
 * the host measures it.
 */
export const AudioHeartbeatEvent = z
  .object({
    type: z.literal('audio.heartbeat'),
    sessionId: z.string().min(1),
    /** The heartbeat's number, from 0 per session. */
    n: z.number().int().nonnegative(),
    /** Host → surface: the last round trip the host measured, in ms. */
    rttMs: z.number().nonnegative().optional(),
  })
  .strict();
export type AudioHeartbeatEvent = z.infer<typeof AudioHeartbeatEvent>;

/**
 * A surface's answer to a host heartbeat: the same number, sent straight back.
 * Every app audio session answers every heartbeat, whatever kind of session it
 * is (a call, dictation, a spoken alert): the host judges the device by what it
 * hears from it, and a session with no microphone has nothing else to say.
 */
export function heartbeatEcho(frame: AudioHeartbeatEvent): AudioHeartbeatEvent {
  return { type: 'audio.heartbeat', sessionId: frame.sessionId, n: frame.n };
}

/** Why a call's audio stopped (spec/07 § Call logs). */
export const CallStopReason = z.enum([
  /** No heartbeat from the host for `HEARTBEAT_LOST_AFTER_MS`. */
  'signal_lost',
  /** The audio connection closed under a live call. */
  'connection_closed',
  /** The server reported the chat's host gone mid-call. */
  'host_unreachable',
  /** A redial was not acknowledged in time. */
  'connect_timeout',
  /** Another app took the audio focus (Android). */
  'audio_focus_taken',
  /** An audio device was added or removed (headset, Bluetooth). */
  'output_device_changed',
]);
export type CallStopReason = z.infer<typeof CallStopReason>;

const callLogBase = {
  /** ms since epoch, on the surface's clock. */
  at: z.number().int().nonnegative(),
  /** The session the entry is about — not necessarily the one it is sent on. */
  sessionId: z.string().min(1),
};

/** One record in a call's log (spec/07 § Call logs). */
export const CallLogEntry = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('audio_stopped'),
      ...callLogBase,
      reason: CallStopReason,
      detail: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('quality'),
      ...callLogBase,
      /** Heartbeats heard on the session. */
      heartbeats: z.number().int().nonnegative(),
      /** Heartbeats never heard (gaps in their numbers). */
      lost: z.number().int().nonnegative(),
      /** Heartbeats that came more than half an interval late. */
      late: z.number().int().nonnegative(),
      /** The longest the surface went without one, in ms. */
      maxGapMs: z.number().int().nonnegative(),
      /** Round trips the host reported, in ms. */
      rttMs: z.object({ min: z.number(), avg: z.number(), max: z.number() }).strict().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reconnected'),
      ...callLogBase,
      /** How long the line was down, in ms. */
      downMs: z.number().int().nonnegative(),
      /** How many dials it took. */
      attempts: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('turn'),
      ...callLogBase,
      /** End of the user's speech to their words coming back. */
      speechToTextMs: z.number().int().nonnegative().optional(),
      /** Their words to the first audio of the reply. */
      modelMs: z.number().int().nonnegative().optional(),
      /** The first audio of the reply to its end. */
      voiceMs: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);
export type CallLogEntry = z.infer<typeof CallLogEntry>;

/** Most entries one `audio.call_log` carries. */
export const CALL_LOG_MAX_ENTRIES = 500;

/**
 * Surface → host: the call's log since it was last sent, on reconnect and at
 * the end (spec/07 § Call logs). The host writes it to its own log.
 */
export const AudioCallLogEvent = z
  .object({
    type: z.literal('audio.call_log'),
    sessionId: z.string().min(1),
    entries: z.array(CallLogEntry).max(CALL_LOG_MAX_ENTRIES),
    /** Entries the surface dropped because the log outgrew `CALL_LOG_MAX_ENTRIES`. */
    dropped: z.number().int().positive().optional(),
  })
  .strict();
export type AudioCallLogEvent = z.infer<typeof AudioCallLogEvent>;

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
  AudioHeartbeatEvent,
  AudioCallLogEvent,
  AudioChatSwitchedEvent,
  AudioPassedToAgentEvent,
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
  'audio.heartbeat': AudioHeartbeatEvent,
  'audio.call_log': AudioCallLogEvent,
  'audio.chat_switched': AudioChatSwitchedEvent,
  'audio.passed_to_agent': AudioPassedToAgentEvent,
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

/**
 * The voices a Gemini Live call can speak in (Gemini's prebuilt voices), for
 * Settings → Voice. Unset (`geminiVoice` absent) is Gemini's own default.
 */
export const GEMINI_VOICES: readonly string[] = [
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Aoede',
  'Leda',
  'Orus',
  'Zephyr',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
];

/** The voices OpenAI's speech endpoint (`/v1/audio/speech`) speaks in; its API has no voice list. */
export const OPENAI_TTS_VOICES: readonly string[] = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
];

/** The voices an OpenAI Realtime call can speak in. Unset (`openaiVoice` absent) is `marin`. */
export const OPENAI_VOICES: readonly string[] = [
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
];
