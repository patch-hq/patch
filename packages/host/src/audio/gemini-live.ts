// Native voice tier: Gemini Live (group: native voice tier).
//
// spec/07-voice-app.md § Light layer / heavy layer split. The native tier
// replaces Whisper→agent→Kokoro with ONE hosted speech-to-speech session: the
// host relays mic PCM straight through to Gemini Live and plays back
// whatever audio it returns, with no local STT/TTS stage at all. Gemini Live
// IS the light layer — "a capable but generic assistant" with no access to
// Patch's data — and passes work to the chat's agent with the voice agent's
// tools (voiceAgent.ts), declared NON_BLOCKING so the model keeps talking while
// the agent works. Everything about the chat (the start context, the tools the
// host answers, the answers pushed back in) is the shared VoiceAgentCall.
//
// Model: `gemini-2.5-flash-native-audio-preview-12-2025` (see
// https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-native-audio-preview-12-2025,
// confirmed as the documented Live API native-audio model, 2026-09-16 — Google
// versions these frequently; override with GEMINI_LIVE_MODEL if it moves).
// Endpoint + message shapes (setup / realtimeInput / serverContent / toolCall /
// toolResponse / clientContent) confirmed against
// https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket and
// .../live-api/tools and .../live-api/capabilities the same day.
//
// Scope: this class only ever backs a `role: 'voice-call'` session on a
// non-device surface — hands-free or call (audio/server.ts only constructs it
// for those). The model, voice and sound are the account's voice agent setup
// (Settings → Voice calls). DICTATION on `gemini` does not use
// a Live session at all: dictation is bounded by a gesture, not by Gemini's own
// turn-taking, and is STT only, so it runs the ordinary `VoiceSession` with a
// Gemini transcriber in Whisper's place (hosted-stt.ts). `finalizeNote()` below
// exists only to satisfy `VoiceSessionLike`. The physical device is a separate
// scope cut: its 16kHz-mic/48kHz-speaker resampling path is specific to
// `VoiceSession`'s device branch, so `device` on `gemini` is refused at
// connection time (`voice_config_not_implemented`) until that path is built.
// Hands-free's address gating: Gemini Live has no "transcribe but don't answer"
// switch (OpenAI Realtime's `create_response: false`, which openai-realtime.ts
// uses), so the gate runs BEFORE the audio reaches it (address-gate.ts). When
// the audio server wires a gate (`deps.gate`), Gemini's own activity detection
// is switched off and a local VAD + transcriber decide which utterances are
// sent as `activityStart` / audio / `activityEnd`; an unaddressed one never
// leaves the host. Without a gate (tests) Gemini detects activity itself and
// hands-free is refused at session start rather than pretended.
//
// One conversation with the chat (spec/07 § Keeping voice and text as one
// conversation): the instructions end with the chat's start context, pushes
// arrive as messages when the line is quiet (VoiceAgentCall), and every
// exchange is written back through `deps.timeline` — the user's words once the
// model starts answering, its reply streamed as the output transcription
// arrives.
//
// Barge-in (spec/07 § Barge-in): the Live API has no way for a client to cut
// the model's record of its reply. When its activity detection hears the user
// it cancels the generation and keeps in the session what it had already sent
// to the host, which runs ahead of what the user heard. So Gemini's own record
// is cut only to what was sent; the reply written into the chat is cut to what
// was heard (SpokenReply). Gemini interrupts only a reply it is still
// generating: the user speaking over one it has finished, which is still
// playing on the surface, is a barge-in the host makes itself.

import type { Logger } from 'pino';
import { WebSocket as WsImpl, type WebSocket as WsSocket } from 'ws';
import type { AudioEvent, AudioSessionMode, VoiceHandoff } from '@patch/wire/audio';
import type { Vad } from './vad.js';
import type { WhisperBackend } from './whisper.js';
import { AddressGate } from './address-gate.js';
import { mergeConfig, modeRequiresAddress } from '@patch/wire/audio';
import type { SessionInit, SessionState } from './session.js';
import type { VoiceSessionLike, VoiceTimeline } from './voice-session-like.js';
import { SpokenReply } from './spokenReply.js';
import { MicLevelWatch, micSilentMessage } from './micLevel.js';
import { addTokens, ZERO_TOKENS, type EngineCosting, type EngineTokens } from './voiceCost.js';
import {
  PASS_TO_AGENT_TOOL_NAME,
  voiceAgentInstructions,
  voiceAgentTools,
  type VoiceAgentLink,
} from './voiceAgent.js';
import { VoiceAgentCall } from './voiceAgentCall.js';
import {
  CHAT_STATUS_DESCRIPTION,
  CHAT_STATUS_TOOL_NAME,
  FIND_CHATS_DESCRIPTION,
  FIND_CHATS_TOOL_NAME,
  MANAGER_QUICK_TOOLS,
  MANAGER_QUICK_TOOL_NAMES,
  stringArgs,
  MANAGER_TOOL_PARAMS,
  ManagerChatLookupError,
  managerHostedInstruction,
  managerReplyMessage,
  SEND_TO_CHAT_DESCRIPTION,
  SEND_TO_CHAT_TOOL_NAME,
  type ManagerSendAccepted,
  type ManagerVoiceTools,
} from './managerVoice.js';

/** The documented Gemini Live native-audio model as of 2026-09-16. */
export const DEFAULT_GEMINI_LIVE_MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

/**
 * Affective dialog (`generationConfig.enableAffectiveDialog`, Settings' "Match
 * my tone") is only on the v1alpha Live API, so a session that asks for it
 * opens there.
 */
function bidiGenerateContentUrl(apiKey: string, affective: boolean): string {
  const version = affective ? 'v1alpha' : 'v1beta';
  return (
    'wss://generativelanguage.googleapis.com/ws/' +
    `google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContent?key=${apiKey}`
  );
}

export interface GeminiLiveDeps {
  logger: Logger;
  /** A voice device's session: what it is told about speaking aloud (spec/16 § Speaking aloud). */
  spokenAloud?: string;
  /** Local VAD + transcriber that decide which utterances reach Gemini (address-gate.ts). */
  gate?: { makeVad: () => Vad; transcriber: WhisperBackend };
  sendAudio: (ev: AudioEvent) => void;
  sendBinary: (pcm: Int16Array) => void;
  /** Where this session's spoken exchanges are written into the chat. */
  timeline: VoiceTimeline;
  /** The voice agent's tools the host answers, and the chat's start context. */
  link: VoiceAgentLink;
  /** The account's voice instructions (spec/07 § Voice instructions), read at the session's start. */
  instructions: string;
  /** How the voice sounds, as the user wrote it; goes in the instructions after them. */
  tone?: string;
  /** How it sounds, as `setup` fields (`soundConfig` of the Gemini engine description). */
  soundConfig?: Record<string, unknown>;
  /** GEMINI_API_KEY. Required — the caller must have already refused to construct this class without one (NO FALLBACK). */
  apiKey: string;
  /** Defaults to {@link DEFAULT_GEMINI_LIVE_MODEL}. */
  model?: string;
  /** Who does the work (spec/07 § The fast voice and the chat's agent). Defaults to `auto`. */
  handoff?: VoiceHandoff;
  /** The prebuilt voice to speak in (`geminiVoice`). Absent: Gemini's own default. */
  voice?: string;
  /**
   * Set only on a call to the Manager (spec/07 § A call to the Manager): the
   * voice is the manager, with tools to find chats, read their status and send
   * them messages, in place of `pass_to_agent` — the Manager's own agent is
   * not in the loop. `handoff` does not apply to such a call.
   */
  manager?: ManagerVoiceTools;
  /**
   * The Gemini side is gone for good (never opened, or closed under us). The
   * audio server ends the surface session, so the surface stops streaming into
   * a dead engine and shows the failure instead of "Listening".
   */
  onFatal?: (message: string) => void;
  /** Test seam: substitute the WebSocket constructor (mirrors persistent-ws.ts). */
  wsCtor?: new (url: string) => WsSocket;
  /** Test seam: override the connect URL entirely (skips the real Google endpoint). */
  wsUrl?: string;
}

/** The Gemini Live wire shapes this module actually sends/reads. Not exhaustive — Gemini's schema has far more fields than we use. */
interface GeminiSetupMessage {
  setup: {
    model: string;
    generationConfig: {
      responseModalities: ['AUDIO'];
      speechConfig?: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
      enableAffectiveDialog?: boolean;
    };
    systemInstruction: { parts: [{ text: string }] };
    tools?: [{ functionDeclarations: GeminiFunctionDeclaration[] }];
    realtimeInputConfig: {
      automaticActivityDetection:
        | { endOfSpeechSensitivity: 'END_SENSITIVITY_LOW'; silenceDurationMs: number }
        | { disabled: true };
    };
    inputAudioTranscription: Record<string, never>;
    outputAudioTranscription: Record<string, never>;
  };
}
interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'OBJECT';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  behavior: 'NON_BLOCKING';
}
interface GeminiServerMessage {
  setupComplete?: Record<string, unknown>;
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    turnComplete?: boolean;
    interrupted?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  usageMetadata?: GeminiUsageMetadata;
  toolCall?: {
    functionCalls?: Array<{ id: string; name: string; args?: Record<string, unknown> }>;
  };
  toolCallCancellation?: { ids?: string[] };
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  responseTokenCount?: number;
  promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
  responseTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
}

/** One Gemini usage report, by kind. */
export function geminiUsageTokens(u: GeminiUsageMetadata): EngineTokens {
  const by = (details: GeminiUsageMetadata['promptTokensDetails'], modality: string): number =>
    (details ?? [])
      .filter((d) => d.modality === modality)
      .reduce((n, d) => n + (d.tokenCount ?? 0), 0);
  return {
    textIn: by(u.promptTokensDetails, 'TEXT'),
    audioIn: by(u.promptTokensDetails, 'AUDIO'),
    cachedIn: u.cachedContentTokenCount ?? 0,
    textOut: by(u.responseTokensDetails, 'TEXT'),
    audioOut: by(u.responseTokensDetails, 'AUDIO'),
  };
}

/**
 * Silence Gemini's server-side VAD waits for before it ends the user's turn.
 * People pause on "uh/um" mid-sentence; the default (a few hundred ms) ends the
 * turn on every pause and the model answers the fragment.
 */
const END_OF_SPEECH_SILENCE_MS = 1800;

/**
 * Speech that says work has been handed to, or done by, the agent. Used only to
 * catch the model narrating a hand-off it never made (see GeminiLiveSession.endTurn).
 */
const HANDOFF_CLAIM =
  /\b(passed (that|it|this|them|the request)? ?on|pass(ed|ing) (that|it|this) (on|to)|dispatched|(sent|forwarded|handed) (that|it|this|the request|your request)\b|(asked|checking with|check(ing)? in with) (the|your) agent|agent is (still )?(working|on it|looking|checking)|results? (will|should) (arrive|come|be with)|(i've|i have|i) (just )?(added|booked|noted|set up|sent|looked in|checked))\b/i;

/** True when the voice's words claim a hand-off or an action. */
export function claimsHandoff(text: string): boolean {
  return HANDOFF_CLAIM.test(text);
}

/** How long a spoken claim waits for its tool call before it counts as false. */
const FALSE_CLAIM_GRACE_MS = 400;

/** The same correction on a Manager call, where sending is `send_to_chat`. */
export const MANAGER_FALSE_CLAIM_CORRECTION =
  `[System] You just said you had sent, asked or told a chat something, but you did not call ` +
  `${SEND_TO_CHAT_TOOL_NAME}, so nothing was sent. Tell the user in a few words that it had not ` +
  `actually been sent, then call ${SEND_TO_CHAT_TOOL_NAME} now with the chat and the message the ` +
  'user asked for.';

export const FALSE_CLAIM_CORRECTION =
  `[System] You just said you had passed something on or done it, but you did not call ` +
  `${PASS_TO_AGENT_TOOL_NAME}, so nothing was sent and nothing has happened. Tell the user in a ` +
  `few words that it had not actually been sent, then call ${PASS_TO_AGENT_TOOL_NAME} now with ` +
  "the user's real request from the conversation.";

/** A NON_BLOCKING declaration taking string parameters. */
function stringTool(
  name: string,
  description: string,
  params: Record<string, string>,
  required: string[] = Object.keys(params),
): GeminiFunctionDeclaration {
  return {
    name,
    description,
    parameters: {
      type: 'OBJECT',
      properties: Object.fromEntries(
        Object.entries(params).map(([k, d]) => [k, { type: 'STRING', description: d }]),
      ),
      required,
    },
    behavior: 'NON_BLOCKING',
  };
}

/** The Manager call's tools (spec/07 § A call to the Manager). */
function managerDeclarations(): GeminiFunctionDeclaration[] {
  return [
    stringTool(
      FIND_CHATS_TOOL_NAME,
      FIND_CHATS_DESCRIPTION,
      { query: MANAGER_TOOL_PARAMS.query },
      [],
    ),
    stringTool(CHAT_STATUS_TOOL_NAME, CHAT_STATUS_DESCRIPTION, { chat: MANAGER_TOOL_PARAMS.chat }),
    stringTool(SEND_TO_CHAT_TOOL_NAME, SEND_TO_CHAT_DESCRIPTION, {
      chat: MANAGER_TOOL_PARAMS.chat,
      message: MANAGER_TOOL_PARAMS.message,
    }),
    ...MANAGER_QUICK_TOOLS.map((t) => stringTool(t.name, t.description, t.params, t.required)),
  ];
}

function buildSetupMessage(
  model: string,
  tools: GeminiFunctionDeclaration[],
  instructions: string,
  manualActivity: boolean,
  voiceName: string | undefined,
  sound: Record<string, unknown>,
): GeminiSetupMessage {
  const message: GeminiSetupMessage = {
    setup: {
      model,
      generationConfig: {
        responseModalities: ['AUDIO'],
        ...(voiceName !== undefined
          ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } }
          : {}),
      },
      systemInstruction: { parts: [{ text: instructions }] },
      ...(tools.length > 0 ? { tools: [{ functionDeclarations: tools }] } : {}),
      realtimeInputConfig: {
        automaticActivityDetection: manualActivity
          ? { disabled: true }
          : {
              endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
              silenceDurationMs: END_OF_SPEECH_SILENCE_MS,
            },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
  return { setup: mergeConfig(message.setup, sound) };
}

/**
 * A hosted Gemini Live session standing in for `VoiceSession` on the native
 * tier. See the module doc above for what is and isn't implemented.
 */
export class GeminiLiveSession implements VoiceSessionLike {
  private readonly init: SessionInit;
  private readonly deps: GeminiLiveDeps;
  private state: SessionState = 'connecting';
  private mode: AudioSessionMode;
  private ws?: WsSocket;
  private setupDone = false;
  /** Base64 PCM16 chunks captured before the WS handshake finished. */
  private micQueue: string[] = [];
  private closed = false;
  private fatal = false;
  private setupCompleteWaiters: Array<() => void> = [];
  private gate?: AddressGate;
  /** Frames the gate produced before the WS handshake finished. */
  private gateQueue: unknown[] = [];
  private lastSpokeAt?: number;
  // --- what actually happened on this session, for the closing summary (mirrors VoiceSession.stats()) ---
  private micFrames = 0;
  private micSamples = 0;
  private turns = 0;
  private turnHadInput = false;
  private turnHadAudioOut = false;
  /** The user spoke over the model this turn: the reply it was cut off from is not lost. */
  private turnInterrupted = false;
  private inputTranscriptBuf = '';
  /** The turn's only "input" was <noise>: whatever the model says to it is dropped. */
  private turnNoiseOnly = false;
  // --- the chat timeline (spec/07 § Keeping voice and text as one conversation) ---
  /** The current utterance has been written into the chat. */
  private userWritten = false;
  /** The reply being spoken now, streaming into the chat. */
  private reply?: SpokenReply;
  /** The reply before it, over for Gemini and maybe still playing on the surface. */
  private lastReply?: SpokenReply;
  /** The call's chat, tools and pushes (spec/07 § The voice agent and the chat's agent). */
  private readonly call: VoiceAgentCall;
  /** Pass-to-agent calls received so far: a claim is checked against whether one arrived since. */
  private dispatchCount = 0;
  /** The turn that carried a dispatch call is still open: its speech is the acknowledgement. */
  private dispatchTurnOpen = false;
  /** Turns of unprompted speech still allowed: one acknowledgement per dispatch. */
  private unpromptedBudget = 0;
  private turnUnpromptedOutput = false;
  /** A dispatch has been made since the user last spoke: hand-off talk is true. */
  private dispatchCovers = false;
  /** The model was already told off for a false claim since the user last spoke. */
  private correctionSent = false;
  /** What the filler guard threw away this turn, for the log. */
  private droppedText = '';
  private droppedChunks = 0;
  // --- the log (what the model and the host did, in order, on this call) ---
  private readonly startedAt = Date.now();
  private turnStartedAt = 0;
  private turnModelText = '';
  private turnAudioChunks = 0;
  private turnSeq = 0;
  private lastWaitLogged = '';
  /** The model is speaking about a push (an agent's answer sent as a message), not answering the user. */
  private relaying = false;
  private relayHadOutput = false;
  // --- usage (spec/07 § Call cost) ---
  private turnUsage?: EngineTokens;
  private tokens: EngineTokens = ZERO_TOKENS;
  /** The turn called a tool: its speech comes with the tool's answer, in the next turn. */
  private turnHadToolCall = false;

  constructor(init: SessionInit, deps: GeminiLiveDeps) {
    this.init = init;
    this.deps = deps;
    this.mode = init.mode ?? 'call';
    this.call = new VoiceAgentCall({
      link: deps.link,
      sessionId: init.sessionId,
      chatId: init.chatId,
      source: {
        kind: 'voice-app',
        surfaceKind: init.surfaceKind as 'web' | 'desktop' | 'mobile',
        sessionId: init.sessionId,
      },
      logger: deps.logger,
      sendAudio: deps.sendAudio,
      ...(init.callReason !== undefined ? { callReason: init.callReason } : {}),
    });
    if (deps.gate) {
      this.gate = new AddressGate({
        vad: deps.gate.makeVad(),
        transcriber: deps.gate.transcriber,
        addressWord: () => this.init.addressWord,
        requiresAddress: () => modeRequiresAddress(this.mode),
        msSinceSpoke: () =>
          this.state === 'speaking'
            ? 0
            : this.lastSpokeAt === undefined
              ? undefined
              : Date.now() - this.lastSpokeAt,
        endSilenceMs: END_OF_SPEECH_SILENCE_MS,
        activityStart: () => this.gateSend({ realtimeInput: { activityStart: {} } }),
        audio: (pcm) =>
          this.gateSend({
            realtimeInput: {
              audio: {
                data: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
                mimeType: 'audio/pcm;rate=16000',
              },
            },
          }),
        activityEnd: () => this.gateSend({ realtimeInput: { activityEnd: {} } }),
        unaddressed: (text) => {
          this.deps.logger.debug(
            { sessionId: this.init.sessionId },
            'gemini-live: unaddressed utterance dropped',
          );
          this.deps.sendAudio({
            type: 'audio.transcript_final',
            sessionId: this.init.sessionId,
            text,
            addressed: false,
          });
        },
        onError: (err) => {
          this.deps.logger.error(
            { sessionId: this.init.sessionId, err: err.message },
            'gemini-live: address gate could not transcribe an utterance',
          );
          this.deps.sendAudio({
            type: 'audio.error',
            code: 'whisper_unavailable',
            message: `hands-free could not check what you said: ${err.message}`,
            sessionId: this.init.sessionId,
          });
        },
      });
    }
  }

  private gateSend(frame: unknown): void {
    if (!this.setupDone || !this.ws) {
      this.gateQueue.push(frame);
      return;
    }
    this.sendRawFrame(frame);
  }

  private sendRawFrame(frame: unknown): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch (err) {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, err: (err as Error).message },
        'gemini-live: mic send failed',
      );
    }
  }

  getMode(): AudioSessionMode {
    return this.mode;
  }

  /**
   * spec/07 § Session modes — flip the open session's mode. NOTE: unlike
   * `VoiceSession`, the native tier does not yet enforce hands-free's
   * address-word gating (see module doc — Gemini decides turn boundaries and
   * starts generating before we could know an utterance was unaddressed).
   * With a gate wired (address-gate.ts) the mode is read live by it, so the
   * flip applies to the next utterance.
   */
  setMode(next: AudioSessionMode): void {
    if (this.mode === next) return;
    this.mode = next;
    this.deps.logger.info(
      { sessionId: this.init.sessionId, mode: next },
      'gemini-live: mode changed',
    );
    if (!this.gate && modeRequiresAddress(next)) this.refuseUngatedHandsFree();
  }

  /** Hands-free with no gate would answer everything; say so rather than pretend. */
  private refuseUngatedHandsFree(): void {
    const message =
      'hands-free is not available on this voice engine: it cannot check for the address word';
    this.deps.logger.error({ sessionId: this.init.sessionId }, `gemini-live: ${message}`);
    this.die(message);
  }

  getState(): SessionState {
    return this.state;
  }

  getCurrentChatId(): string {
    return this.call.chatId;
  }

  /** The host moved the call to another chat (switch chat). */
  setFocus(chatId: string): void {
    this.call.setChat(chatId);
  }

  private readonly micLevel = new MicLevelWatch();

  stats(): {
    micFrames: number;
    micSeconds: number;
    vadEvents: number;
    turns: number;
    micPeakDbfs: number;
  } {
    return {
      micFrames: this.micFrames,
      micSeconds: Number((this.micSamples / 16000).toFixed(1)),
      // Gemini's VAD runs server-side and is invisible to the host — there
      // is no local event to count (unlike VoiceSession's Silero VAD).
      vadEvents: 0,
      turns: this.turns,
      micPeakDbfs: this.micLevel.peakDbfs(),
    };
  }

  private setState(next: SessionState): void {
    if (this.state === next) return;
    if (this.state === 'speaking') this.lastSpokeAt = Date.now();
    this.state = next;
    this.deps.sendAudio({ type: 'audio.state', sessionId: this.init.sessionId, state: next });
  }

  /** First wire event after WS upgrade. Kicks off the async connect. */
  onSessionStart(): void {
    if (this.state !== 'connecting') {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, state: this.state },
        'gemini-live: duplicate session_start',
      );
      return;
    }
    if (!this.gate && modeRequiresAddress(this.mode)) {
      this.refuseUngatedHandsFree();
      return;
    }
    void this.connect().catch((err: Error) => {
      this.deps.logger.error(
        { sessionId: this.init.sessionId, err: err.message },
        'gemini-live: failed to open native session',
      );
      this.die(`native voice session failed to open: ${err.message}`);
    });
  }

  /** Report a failure the session cannot recover from and end the surface session. */
  private die(message: string): void {
    if (this.fatal || this.closed) return;
    this.fatal = true;
    this.deps.sendAudio({
      type: 'audio.error',
      code: 'gemini_unavailable',
      message,
      sessionId: this.init.sessionId,
    });
    this.deps.onFatal?.(message);
  }

  private async connect(): Promise<void> {
    const url =
      this.deps.wsUrl ??
      bidiGenerateContentUrl(
        this.deps.apiKey,
        (
          this.deps.soundConfig?.['generationConfig'] as
            | { enableAffectiveDialog?: unknown }
            | undefined
        )?.enableAffectiveDialog === true,
      );
    const Ctor = this.deps.wsCtor ?? (WsImpl as unknown as new (url: string) => WsSocket);
    const ws = new Ctor(url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => resolve();
      const onError = (err: Error): void => reject(err);
      ws.once('open', onOpen);
      ws.once('error', onError);
    });
    ws.on('message', (data: Buffer | string, _isBinary: boolean) => this.onWsMessage(data));
    ws.on('close', (code: number, reason: Buffer | string) => this.onWsClose(code, reason));
    ws.on('error', (err: Error) => {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, err: err.message },
        'gemini-live: ws error',
      );
    });
    // spec/07 § Voice instructions — the user's instructions (or the Manager's prompt), the
    // tone, then the chat as it stands. A chat that cannot be read fails the session loudly.
    const manager = this.deps.manager;
    const instructions = voiceAgentInstructions({
      instructions: manager
        ? managerHostedInstruction(true, manager.voicePrompt?.())
        : this.deps.instructions,
      extra: this.deps.spokenAloud ? [this.deps.spokenAloud] : [],
      ...(this.deps.tone !== undefined ? { tone: this.deps.tone } : {}),
      startContext: this.call.startContext(),
    });
    const tools = [
      ...(manager ? managerDeclarations() : []),
      ...voiceAgentTools({
        handoff: manager ? 'never' : (this.deps.handoff ?? 'auto'),
        lookBack: true,
        switchChat: !manager,
      }).map((t) => stringTool(t.name, t.description, t.params, t.required)),
    ];
    // The full text, so what the voice was told can be read back from the log.
    this.log('instructions', { chars: instructions.length, instructions });
    ws.send(
      JSON.stringify(
        buildSetupMessage(
          this.getEngineModel(),
          tools,
          instructions,
          this.deps.gate !== undefined,
          this.deps.voice,
          this.deps.soundConfig ?? {},
        ),
      ),
    );
    await new Promise<void>((resolve) => this.setupCompleteWaiters.push(resolve));
    // Gemini closed the socket instead of completing setup (a rejected model
    // or key): onWsClose has already reported it.
    if (this.fatal) return;
    if (this.closed) return;
    this.setupDone = true;
    this.setState('listening');
    const queued = this.micQueue;
    this.micQueue = [];
    for (const b64 of queued) this.sendAudioChunk(b64);
    const gated = this.gateQueue;
    this.gateQueue = [];
    for (const f of gated) this.sendRawFrame(f);
    this.call.attach({
      addContext: (text) =>
        this.sendFrame(
          { clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: false } },
          'context added',
          { chars: text.length },
        ),
      speakAbout: (text) => {
        this.relaying = true;
        this.relayHadOutput = false;
        this.sendFrame(
          { clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } },
          'push sent as a message',
          { chars: text.length },
        );
      },
      isIdle: () => this.isIdleForResult(),
      playbackLeftMs: () => Math.max(this.reply?.leftMs() ?? 0, this.lastReply?.leftMs() ?? 0),
    });
  }

  private sendAudioChunk(b64: string): void {
    if (!this.ws) return;
    try {
      this.ws.send(
        JSON.stringify({
          realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } },
        }),
      );
    } catch (err) {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, err: (err as Error).message },
        'gemini-live: mic send failed',
      );
    }
  }

  /** Feed one mic PCM frame (16 kHz mono). Forwarded straight to Gemini Live — no local VAD/STT. */
  async onMicFrame(pcm: Int16Array): Promise<void> {
    if (this.closed) return;
    this.micFrames += 1;
    this.micSamples += pcm.length;
    // spec/07 — a mic sending only digital silence is a failure to report.
    if (this.micLevel.feed(pcm)) {
      this.deps.logger.error(
        { sessionId: this.init.sessionId },
        'voice: the microphone is sending only digital silence',
      );
      this.deps.sendAudio({
        type: 'audio.error',
        code: 'mic_silent',
        message: micSilentMessage(this.init.surfaceKind),
        sessionId: this.init.sessionId,
      });
    }
    // Base64-encode SYNCHRONOUSLY, before any await — `pcm` is a caller-owned
    // view (server.ts: sometimes a zero-copy slice of a pooled WS receive
    // buffer) that must not be retained past this call (same contract
    // VoiceSession.onMicFrame documents).
    if (this.gate) {
      // The gate copies the frame, and decides what Gemini is sent.
      await this.gate.feed(pcm);
      return;
    }
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    if (!this.setupDone || !this.ws) {
      this.micQueue.push(b64);
      return;
    }
    this.sendAudioChunk(b64);
  }

  /** One line of the call's log: what happened, how long into the call, and the state around it. */
  private log(event: string, fields: Record<string, unknown> = {}): void {
    this.deps.logger.info(
      {
        sessionId: this.init.sessionId,
        t: Date.now() - this.startedAt,
        state: this.state,
        openHandoffs: this.call.openHandoffs(),
        pushes: this.call.pendingPushes(),
        ...fields,
      },
      `gemini-live: ${event}`,
    );
  }

  private onWsMessage(data: Buffer | string): void {
    let msg: GeminiServerMessage;
    try {
      msg = JSON.parse(
        typeof data === 'string' ? data : data.toString('utf8'),
      ) as GeminiServerMessage;
    } catch (err) {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, err: (err as Error).message },
        'gemini-live: bad json from server',
      );
      return;
    }
    if (msg.setupComplete) {
      this.log('setup complete');
      const waiters = this.setupCompleteWaiters;
      this.setupCompleteWaiters = [];
      for (const w of waiters) w();
      return;
    }
    // Anything the host has no handling for is still worth seeing (goAway, session resumption…).
    const unhandled = Object.keys(msg).filter(
      (k) => !['serverContent', 'usageMetadata', 'toolCall', 'toolCallCancellation'].includes(k),
    );
    if (unhandled.length > 0) this.log('server message', { keys: unhandled });
    if (msg.usageMetadata) this.turnUsage = geminiUsageTokens(msg.usageMetadata);
    if (msg.toolCall?.functionCalls) {
      this.log('tool call', {
        calls: msg.toolCall.functionCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      });
      this.turnHadToolCall = true;
      for (const call of msg.toolCall.functionCalls) {
        if (this.call.handles(call.name)) void this.handleVoiceTool(call);
        else if (this.deps.manager) this.handleManagerTool(this.deps.manager, call);
        else
          this.answerTool(call.id, call.name, `There is no tool called ${call.name}.`, 'INTERRUPT');
      }
    }
    if (msg.toolCallCancellation) {
      // Gemini says these calls should not have run. A hand-off is answered at once,
      // so nothing waits on Gemini here: the agent's answer is still pushed as a message.
      this.deps.logger.warn(
        {
          sessionId: this.init.sessionId,
          t: Date.now() - this.startedAt,
          ids: msg.toolCallCancellation.ids,
          openHandoffs: this.call.openHandoffs(),
        },
        'gemini-live: tool call cancelled by the server',
      );
    }
    if (msg.serverContent) this.onServerContent(msg.serverContent);
  }

  private onServerContent(sc: NonNullable<GeminiServerMessage['serverContent']>): void {
    const signals = Object.keys(sc).filter(
      (k) => !['modelTurn', 'inputTranscription', 'outputTranscription'].includes(k),
    );
    if (signals.length > 0) {
      this.log('server content', { signals, relaying: this.relaying });
    }
    // Gemini transcribes audio with no speech as "<noise>", and sometimes as a bare "." —
    // neither opens a turn: a first transcript with no letter or digit in it is not input.
    // (Punctuation arriving after words is kept — it belongs to them.)
    const heardRaw = sc.inputTranscription?.text?.replace(/<noise>/gi, '');
    const heard =
      heardRaw !== undefined && (this.turnHadInput || /[\p{L}\p{N}]/u.test(heardRaw))
        ? heardRaw
        : '';
    if (sc.inputTranscription?.text && heard.trim() === '' && !this.turnHadInput) {
      this.turnNoiseOnly = true;
    } else if (heard) {
      this.turnNoiseOnly = false;
      if (!this.turnHadInput) {
        this.log('user speaking');
        this.dispatchCovers = false;
        this.correctionSent = false;
        if (this.lastReply?.playing()) this.bargeIn();
      }
      this.inputTranscriptBuf += heard;
      this.turnHadInput = true;
      // The words so far, live — the call bar shows them while the user talks.
      if (this.state === 'listening') this.setState('transcribing');
      this.deps.sendAudio({
        type: 'audio.transcript_partial',
        sessionId: this.init.sessionId,
        text: this.inputTranscriptBuf.trim(),
      });
    }
    if (sc.interrupted) {
      // Barge-in: the user spoke over Gemini's own reply (spec/07 § Barge-in —
      // Gemini's server-side VAD does this for us; there is no local VAD to
      // drive on the native tier).
      this.bargeIn();
      this.turnHadAudioOut = false;
      this.turnInterrupted = true;
    }
    const parts = sc.modelTurn?.parts ?? [];
    const hasAudio = parts.some((p) => p.inlineData?.data);
    const outText = sc.outputTranscription?.text;
    if ((hasAudio || outText) && this.turnStartedAt === 0) {
      this.turnStartedAt = Date.now();
      this.log('model speaking', {
        prompted: this.turnHadInput,
        relaying: this.relaying,
        dispatchTurn: this.dispatchTurnOpen,
      });
    }
    if (this.turnNoiseOnly && !this.turnHadInput && (hasAudio || outText)) {
      this.droppedChunks += 1;
      if (outText) this.droppedText += outText;
      if (sc.turnComplete) this.endTurn();
      return;
    }
    if (outText) this.turnModelText += outText;
    if (
      (hasAudio || outText) &&
      this.call.openHandoffs() > 0 &&
      !this.turnHadInput &&
      !this.relaying
    ) {
      // The model is talking on its own while the agent works. One acknowledgement per
      // hand-off is wanted; more is the "still working on it" loop, which no prompt has
      // stopped. Replies to what the user says are never touched.
      if (this.dispatchTurnOpen || this.unpromptedBudget > 0) {
        this.turnUnpromptedOutput = true;
      } else {
        this.droppedChunks += 1;
        if (outText) this.droppedText += outText;
        if (sc.turnComplete) this.endTurn();
        return;
      }
    }
    // The model has started answering, so the utterance is finished: it goes
    // into the chat ahead of the reply.
    if (hasAudio || outText) this.commitUserWords();
    if (this.relaying && (hasAudio || outText)) this.relayHadOutput = true;
    // Everything the voice says is written into the chat, including its words about an
    // agent's answer: the answer is already there as the agent's own message, and what the
    // voice made of it is a separate thing the user heard and should be able to read.
    if (outText) {
      this.spokenReply().append(outText);
    }
    for (const part of parts) {
      const inline = part.inlineData;
      if (!inline?.data) continue;
      // Native tier only ever backs web/desktop/mobile (audio/server.ts scopes
      // it away from `surfaceKind: 'device'`), which decode native 24 kHz PCM
      // directly — same rate Kokoro emits, so no resample is needed here
      // (unlike VoiceSession's device branch).
      const buf = Buffer.from(inline.data, 'base64');
      const pcm = new Int16Array(buf.byteLength >>> 1);
      const bytes = new Uint8Array(pcm.buffer);
      bytes.set(buf);
      if (this.state !== 'speaking') this.setState('speaking');
      this.turnHadAudioOut = true;
      this.turnAudioChunks += 1;
      this.spokenReply().audio(pcm.length);
      this.deps.sendAudio({
        type: 'audio.tts_chunk',
        sessionId: this.init.sessionId,
        samples: pcm.length,
      });
      this.deps.sendBinary(pcm);
    }
    if (sc.turnComplete) this.endTurn();
  }

  /** The model's whole answer to this turn was punctuation: it said nothing and meant to. */
  private modelDeclinedToAnswer(): boolean {
    const said = this.turnModelText.trim();
    return said !== '' && !/[\p{L}\p{N}]/u.test(said);
  }

  /** The model finished a turn: close it out for the chat, the surface and the usage count. */
  private endTurn(): void {
    const wasRelaying = this.relaying;
    this.turnSeq += 1;
    this.log('turn', {
      seq: this.turnSeq,
      user: this.inputTranscriptBuf.trim(),
      model: this.turnModelText.trim(),
      audioChunks: this.turnAudioChunks,
      speakingMs: this.turnStartedAt === 0 ? 0 : Date.now() - this.turnStartedAt,
      prompted: this.turnHadInput,
      relaying: this.relaying,
      dispatchTurn: this.dispatchTurnOpen,
      unprompted: this.turnUnpromptedOutput,
      droppedChunks: this.droppedChunks,
      droppedText: this.droppedText.trim(),
    });
    if (this.droppedChunks > 0) {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, text: this.droppedText.trim() },
        'gemini-live: dropped the model talking on its own while a hand-off ran',
      );
    }
    // The acknowledgement budget: the turn that carried the dispatch is free; the next
    // unprompted turn that spoke uses up the one allowed for each hand-off.
    if (this.dispatchTurnOpen) this.dispatchTurnOpen = false;
    else if (this.turnUnpromptedOutput && this.unpromptedBudget > 0) this.unpromptedBudget -= 1;
    this.commitUserWords();
    if (this.turnHadInput) this.turns += 1;
    this.finishReply();
    if (this.turnUsage) {
      this.tokens = addTokens(this.tokens, this.turnUsage);
      this.turnUsage = undefined;
    }
    if (this.relaying) {
      // This turn was the model speaking an agent result. If it said nothing, the
      // result was lost between the host and the speaker — say so, loudly.
      if (!this.relayHadOutput) {
        const message = 'the model did not speak the hand-off result';
        this.deps.logger.error({ sessionId: this.init.sessionId }, `gemini-live: ${message}`);
        this.deps.sendAudio({
          type: 'audio.error',
          code: 'gemini_unavailable',
          message,
          sessionId: this.init.sessionId,
        });
      }
      this.relaying = false;
    }
    // NO SILENT FAILURES (CLAUDE.md): a turn that had audible user input but
    // produced no TTS audio has lost its reply somewhere — say so, mirroring
    // VoiceSession.endStream's identical guard. A turn that called a tool speaks
    // when the tool's answer comes back, in the next turn.
    if (
      this.turnHadInput &&
      !this.turnHadAudioOut &&
      !this.turnInterrupted &&
      !this.turnHadToolCall &&
      this.modelDeclinedToAnswer()
    ) {
      // Gemini heard something it could not make speech of (background noise it
      // transcribed as a stray foreign-script fragment) and answered with bare
      // punctuation, e.g. "...". That is the model choosing silence, not a lost reply:
      // logged, but not a call failure.
      this.deps.logger.warn(
        {
          sessionId: this.init.sessionId,
          heard: this.inputTranscriptBuf.trim(),
          model: this.turnModelText.trim(),
        },
        'gemini-live: the model answered what it heard with no words and no audio',
      );
    } else if (
      this.turnHadInput &&
      !this.turnHadAudioOut &&
      !this.turnInterrupted &&
      !this.turnHadToolCall
    ) {
      const message = 'native voice turn produced no TTS audio for the surface';
      this.deps.logger.error({ sessionId: this.init.sessionId }, message);
      this.deps.sendAudio({
        type: 'audio.error',
        code: 'gemini_unavailable',
        message,
        sessionId: this.init.sessionId,
      });
    }
    this.deps.sendAudio({ type: 'audio.tts_end', sessionId: this.init.sessionId });
    if (!wasRelaying) this.guardFalseClaim(this.turnModelText);
    this.inputTranscriptBuf = '';
    this.turnHadInput = false;
    this.turnNoiseOnly = false;
    this.turnHadAudioOut = false;
    this.turnInterrupted = false;
    this.userWritten = false;
    this.turnStartedAt = 0;
    this.turnModelText = '';
    this.turnAudioChunks = 0;
    this.turnUnpromptedOutput = false;
    this.turnHadToolCall = false;
    this.droppedText = '';
    this.droppedChunks = 0;
    // Every hand-off answered: no acknowledgement is owed any more.
    if (this.call.openHandoffs() === 0) {
      this.unpromptedBudget = 0;
      this.dispatchTurnOpen = false;
    }
    this.setState('listening');
    this.call.flush();
  }

  /**
   * The model said it passed something on or did it, with no dispatch behind the words.
   * The audio has already been spoken, so the lie can't be unsaid: tell the model to
   * own up and send the request now. A second false claim since the user last spoke is
   * not retried — it is an error the surface shows.
   */
  private guardFalseClaim(spoken: string): void {
    if (!claimsHandoff(spoken)) return;
    // The call can reach us just after the turn that spoke the words completes: give it a
    // moment before deciding the hand-off was never made.
    const dispatchesBefore = this.dispatchCount;
    setTimeout(() => {
      if (this.closed || this.dispatchCount !== dispatchesBefore) return;
      this.checkFalseClaim(spoken);
    }, FALSE_CLAIM_GRACE_MS);
  }

  private checkFalseClaim(spoken: string): void {
    if (
      ((this.deps.handoff ?? 'auto') === 'never' && !this.deps.manager) ||
      this.dispatchCovers ||
      this.call.openHandoffs() > 0 ||
      this.call.pendingPushes() > 0 ||
      this.turnInterrupted ||
      !claimsHandoff(spoken)
    ) {
      return;
    }
    if (this.correctionSent) {
      const message = 'the voice claimed a hand-off that was not sent';
      this.deps.logger.error({ sessionId: this.init.sessionId, spoken }, `gemini-live: ${message}`);
      this.deps.sendAudio({
        type: 'audio.error',
        code: 'gemini_unavailable',
        message: `${message}: not sent, say it again`,
        sessionId: this.init.sessionId,
      });
      return;
    }
    this.correctionSent = true;
    this.deps.logger.warn(
      { sessionId: this.init.sessionId, spoken },
      'gemini-live: the model claimed a hand-off without calling dispatch_to_patch',
    );
    this.sendFrame(
      {
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text: this.deps.manager ? MANAGER_FALSE_CLAIM_CORRECTION : FALSE_CLAIM_CORRECTION,
                },
              ],
            },
          ],
          turnComplete: true,
        },
      },
      'correction: claimed a hand-off that was not made',
    );
  }

  /** Write the finished utterance into the chat, once, and tell the surface it is final. */
  private commitUserWords(): void {
    if (!this.turnHadInput || this.userWritten) return;
    this.userWritten = true;
    const text = this.inputTranscriptBuf.trim();
    if (text.length === 0) return;
    this.deps.timeline.userSaid(this.call.chatId, text);
    this.deps.sendAudio({ type: 'audio.transcript_final', sessionId: this.init.sessionId, text });
    // spec/07 § Permission prompts during voice — a spoken yes / no answers a waiting permission.
    this.deps.link.answerPermission(this.call.chatId, text);
  }

  /** The reply being spoken now, begun on its first words or audio. */
  private spokenReply(): SpokenReply {
    this.reply ??= new SpokenReply(() => this.deps.timeline.beginReply(this.call.chatId));
    return this.reply;
  }

  /** Nothing more of the reply is coming; the chat gets it once it has played out. */
  private finishReply(): void {
    if (!this.reply) return;
    this.reply.end();
    this.lastReply = this.reply;
    this.reply = undefined;
  }

  /** The user spoke over the reply: stop the surface playing it, and keep what was heard. */
  private bargeIn(): void {
    this.deps.sendAudio({ type: 'audio.barge_in', sessionId: this.init.sessionId, at: Date.now() });
    this.deps.sendAudio({ type: 'audio.tts_end', sessionId: this.init.sessionId, bargedIn: true });
    this.cutReply();
    this.setState('listening');
  }

  /** The user spoke over the reply: the chat keeps what they heard of it. */
  private cutReply(): void {
    const target = this.reply ?? this.lastReply;
    this.reply = undefined;
    this.lastReply = undefined;
    if (!target) return;
    const heardMs = target.cut();
    if (heardMs !== null) {
      this.log('reply cut off', {
        heardMs: Math.round(heardMs),
        audioMs: Math.round(target.audioMs()),
      });
    }
  }

  getEngineModel(): string {
    return this.deps.model ?? DEFAULT_GEMINI_LIVE_MODEL;
  }

  engineCosting(): EngineCosting {
    const tokens = this.turnUsage ? addTokens(this.tokens, this.turnUsage) : this.tokens;
    return { backend: 'gemini', model: this.getEngineModel(), tokens, stt: null };
  }

  pushMessage(text: string, opts: { handoffSettled?: boolean } = {}): void {
    this.call.push(text, opts);
  }

  /** Answer one tool call. `WHEN_IDLE` lets the model finish what it is saying first. */
  private answerTool(
    callId: string,
    name: string,
    result: string,
    scheduling: 'INTERRUPT' | 'WHEN_IDLE',
    note?: string,
  ): void {
    this.log(`tool answered (${name})`, { callId, chars: result.length, result });
    this.sendFrame(
      {
        toolResponse: {
          functionResponses: [
            {
              id: callId,
              name,
              response: { result, ...(note !== undefined ? { note } : {}), scheduling },
            },
          ],
        },
      },
      `tool response (${name})`,
      { callId, scheduling },
    );
  }

  /** The voice agent's own tools (voiceAgent.ts), answered through the shared call. */
  private async handleVoiceTool(call: {
    id: string;
    name: string;
    args?: Record<string, unknown>;
  }): Promise<void> {
    const handoff = call.name === PASS_TO_AGENT_TOOL_NAME;
    if (handoff) {
      // The chat reads in order: what the user said, what the voice said, then the hand-off.
      this.commitUserWords();
      this.finishReply();
      this.dispatchCount += 1;
      this.dispatchCovers = true;
      this.dispatchTurnOpen = true;
      this.unpromptedBudget += 1;
    }
    const result = await this.call.runTool(call.name, call.args ?? {});
    if (this.closed || !this.ws) return;
    // "received" lets the model finish its sentence and then say it has passed it on;
    // anything else is what it was asking for, so it answers now.
    this.answerTool(call.id, call.name, result, handoff ? 'WHEN_IDLE' : 'INTERRUPT');
  }

  /**
   * A Manager call's tools (spec/07 § A call to the Manager). `find_chats` and
   * `chat_status` answer at once, like `look_back`; `send_to_chat` runs as a
   * hand-off — answered once the chat has the message, its reply pushed later
   * as a message, exactly as an agent's answer is.
   */
  private handleManagerTool(
    manager: ManagerVoiceTools,
    call: { id: string; name: string; args?: Record<string, unknown> },
  ): void {
    const arg = (k: string): string =>
      typeof call.args?.[k] === 'string' ? (call.args[k] as string) : '';
    if (call.name === SEND_TO_CHAT_TOOL_NAME) {
      void this.handleSendToChat(manager, call.id, arg('chat'), arg('message'));
      return;
    }
    const answer = (result: string): void =>
      this.answerTool(call.id, call.name, result, 'INTERRUPT');
    const fail = (err: Error): void => {
      if (!(err instanceof ManagerChatLookupError)) {
        this.deps.logger.error(
          { sessionId: this.init.sessionId, err: err.message, tool: call.name },
          'gemini-live: a manager tool failed',
        );
      }
      answer(`That failed: ${err.message}`);
    };
    if (call.name === FIND_CHATS_TOOL_NAME) {
      manager.findChats(arg('query')).then(answer, fail);
      return;
    }
    if (call.name === CHAT_STATUS_TOOL_NAME) {
      manager.chatStatus(arg('chat')).then(answer, fail);
      return;
    }
    if (MANAGER_QUICK_TOOL_NAMES.has(call.name)) {
      manager.quick(call.name, stringArgs(call.args), this.quickContext()).then(answer, fail);
      return;
    }
    const message = `the voice called a tool a Manager call does not have: ${call.name}`;
    this.deps.logger.error({ sessionId: this.init.sessionId }, `gemini-live: ${message}`);
    answer(`There is no tool called ${call.name} on this call.`);
  }

  /** Where a quick tool is being called from: the device this conversation is on, if it is one. */
  private quickContext(): { deviceId?: string } {
    return this.init.deviceId !== undefined ? { deviceId: this.init.deviceId } : {};
  }

  /**
   * A Manager call's `send_to_chat`: answered once the chat has the message;
   * the chat's reply is pushed into the call when it comes.
   */
  private async handleSendToChat(
    manager: ManagerVoiceTools,
    callId: string,
    chat: string,
    message: string,
  ): Promise<void> {
    this.log('sending to a chat', { callId, chat, message });
    // The chat reads in order: what the user said, what the voice said, then the send.
    this.commitUserWords();
    this.finishReply();
    this.dispatchCount += 1;
    this.dispatchCovers = true;
    this.dispatchTurnOpen = true;
    this.unpromptedBudget += 1;
    this.call.handoffOpened();
    let name = chat;
    // Answered only once the chat has the message: the voice must not say it has gone before then.
    let accepted = false;
    const answerStarted = (info?: ManagerSendAccepted): void => {
      if (accepted) return;
      accepted = true;
      this.answerTool(
        callId,
        SEND_TO_CHAT_TOOL_NAME,
        'started',
        'WHEN_IDLE',
        info?.replyComing === false
          ? `"${info.name}" has the message. It is on another computer, so its reply will not ` +
              'come back into this call: tell the user it has been sent and that the answer will ' +
              'be in that chat.'
          : `"${info?.name ?? name}" has the message and is working on it. If you mention it, ` +
              'say so in a few words of your own, then carry on. Its reply will arrive as a ' +
              'message; do not wait for it or keep mentioning it.',
      );
    };
    let reply: string | null;
    try {
      const res = await manager.sendToChat({
        chat,
        message,
        onAccepted: (info) => {
          name = info.name;
          answerStarted(info);
        },
      });
      reply = res.reply;
    } catch (err) {
      const reason = (err as Error).message;
      const lookup = err instanceof ManagerChatLookupError;
      if (!lookup) {
        this.deps.logger.error(
          { sessionId: this.init.sessionId, err: reason },
          'gemini-live: send to chat failed',
        );
      }
      if (accepted) {
        this.call.push(managerReplyMessage(name, message, `That failed: ${reason}`), {
          handoffSettled: true,
        });
        return;
      }
      // Never taken: say so to the user and the voice, loudly.
      this.call.handoffClosed();
      if (!lookup) {
        this.deps.sendAudio({
          type: 'audio.error',
          code: 'gemini_unavailable',
          message: `The message was not sent to the chat: ${reason}`,
          sessionId: this.init.sessionId,
        });
      }
      if (this.closed || !this.ws) return;
      this.answerTool(
        callId,
        SEND_TO_CHAT_TOOL_NAME,
        'failed',
        'WHEN_IDLE',
        lookup
          ? `Nothing was sent. ${reason}`
          : `The message did NOT reach the chat (${reason}). Tell the user in a few words that ` +
              'it was not sent. Do not say it was.',
      );
      return;
    }
    answerStarted();
    if (reply === null) {
      // Taken, and nothing will come back into the call (a chat on another host).
      this.call.handoffClosed();
      return;
    }
    this.call.push(managerReplyMessage(name, message, reply), { handoffSettled: true });
  }

  /** Nobody is talking and no result is being spoken: a result can be said without cutting anyone off. */
  private isIdleForResult(): boolean {
    return (
      !this.closed &&
      this.setupDone &&
      this.ws !== undefined &&
      !this.relaying &&
      !this.turnHadInput &&
      !this.turnHadAudioOut &&
      this.inputTranscriptBuf === ''
    );
  }

  /** Send one JSON frame to Gemini, logging what it was. */
  private sendFrame(frame: unknown, what: string, fields: Record<string, unknown> = {}): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(frame));
      this.log(`sent: ${what}`, fields);
    } catch (err) {
      this.deps.logger.error(
        { sessionId: this.init.sessionId, err: (err as Error).message, what },
        'gemini-live: failed to send a frame to Gemini',
      );
    }
  }

  private onWsClose(code?: number, reason?: Buffer | string): void {
    if (this.closed) return;
    const why = typeof reason === 'string' ? reason : reason?.toString('utf8');
    this.deps.logger.warn({ sessionId: this.init.sessionId, code, why }, 'gemini-live: ws closed');
    // NO SILENT FAILURES: Gemini hanging up on an open call used to be only a
    // log line, leaving the surface on "Listening" over a dead engine.
    this.die(`Gemini Live closed the session (code ${code ?? 'unknown'}${why ? `: ${why}` : ''})`);
    const waiters = this.setupCompleteWaiters;
    this.setupCompleteWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Not implemented — native tier only ever backs `role: 'voice-call'`
   * sessions (see module doc). Present to satisfy `VoiceSessionLike`.
   */
  async finalizeNote(): Promise<boolean> {
    this.deps.logger.warn(
      { sessionId: this.init.sessionId },
      'gemini-live: finalizeNote called on a native session — voice notes are fallback-tier only, this is a no-op',
    );
    return false;
  }

  /**
   * DEV/TEST seam, and a genuine capability of the wire protocol: Gemini Live
   * accepts a text turn via `clientContent` exactly like a spoken one, so this
   * drives a REAL turn through the model (including a possible dispatch) —
   * not a synthetic echo.
   */
  async injectTranscript(text: string): Promise<void> {
    if (this.closed || !this.setupDone || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true },
      }),
    );
  }

  /**
   * Approximation (see module doc): Gemini Live has no raw "say exactly this"
   * primitive short of its separate TTS-only models, which is out of scope
   * here. Instructing the live conversational model to speak the text
   * verbatim gets audibly close for the one thing this is used for — a short
   * agent-initiated interrupt spoken into an ALREADY-open call (spec/07
   * § Which surface it reaches) — without guaranteeing byte-identical prosody
   * the way Kokoro's direct synthesis does.
   */
  async speak(text: string): Promise<void> {
    if (this.closed || !this.setupDone || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [
                { text: `Say exactly the following out loud, verbatim, and nothing else: ${text}` },
              ],
            },
          ],
          turnComplete: true,
        },
      }),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.call.close();
    this.log('closing');
    this.reply?.flush();
    this.lastReply?.flush();
    this.closed = true;
    void this.gate?.close();
    const waiters = this.setupCompleteWaiters;
    this.setupCompleteWaiters = [];
    for (const w of waiters) w();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
