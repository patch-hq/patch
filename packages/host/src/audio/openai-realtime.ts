// Hosted voice tier: OpenAI Realtime (spec/07 § Voice — a config matrix,
// `backend: openai`). The OpenAI counterpart of gemini-live.ts, and built the
// same way: the HOST relays the surface's mic PCM to one hosted
// speech-to-speech session over a server-side WebSocket and streams the
// returned audio back down the surface's existing audio WSS. No surface talks
// to OpenAI itself and no surface holds a key or an ephemeral token — a phone
// on `openai` sends exactly the frames it sends on `local`, which is why this
// backend needs no WebRTC or other native module on Android.
//
// The model IS the voice agent and passes work to the chat's agent with the
// voice agent's tools (voiceAgent.ts); everything about the chat — the start
// context, the tools the host answers, the answers pushed back in — is the
// shared VoiceAgentCall, the same as on the other providers. The model, voice
// and sound are the account's voice agent setup (Settings → Voice calls).
//
// Protocol: the GA Realtime API over WebSocket
// (developers.openai.com/api/docs/guides/realtime-websocket, checked
// 2026-09-24): `wss://api.openai.com/v1/realtime?model=<m>` with
// `Authorization: Bearer`, configured by `session.update`
// (`session.type: 'realtime'`, `audio.input/output.format` PCM16 @ 24 kHz),
// mic in as `input_audio_buffer.append`, audio out as
// `response.output_audio.delta`, the user's words as
// `conversation.item.input_audio_transcription.delta/.completed`, tool calls as
// `response.function_call_arguments.done`, answered with a
// `function_call_output` item + `response.create`.
//
// The API only takes 24 kHz PCM, and surfaces send 16 kHz, so every mic frame
// is upsampled 2:3 here before it is appended. Output is already 24 kHz — the
// rate the surfaces' TTS sinks play — so it is forwarded untouched.
//
// Hands-free (spec/07 § Session modes) IS enforced on this tier, unlike Gemini:
// in `hands-free` the server VAD is told not to answer by itself
// (`create_response: false`) or to cut its own reply off when somebody else in
// the room talks (`interrupt_response: false`). Each finished transcript is
// then run through the same `isAddressed` rule the local tier uses: addressed
// → `response.create`; not addressed → reported as heard-but-not-sent
// (`addressed: false`) and the item deleted from the conversation so it never
// becomes context either.
//
// Barge-in (spec/07 § Barge-in): when the user speaks over a reply, the reply
// is cut in OpenAI's own conversation with `conversation.item.truncate` at the
// point playback had reached (the time since its first audio chunk went to the
// surface), which also drops the unheard part of its transcript, and the reply
// written into the chat is cut to the same point.
//
// NO SILENT FALLBACK. A connect failure, an `error` event, a failed response,
// a failed transcription, or the provider closing the socket is reported to
// the surface as `audio.error {code: 'openai_unavailable'}`; a closed or
// never-opened provider socket is fatal and ends the surface session
// (`onFatal`) rather than leaving a call bar that says "Listening" over a dead
// engine.

import type { Logger } from 'pino';
import { WebSocket as WsImpl, type WebSocket as WsSocket } from 'ws';
import type { AudioEvent, AudioSessionMode, VoiceHandoff } from '@patch/wire/audio';
import { mergeConfig, modeRequiresAddress } from '@patch/wire/audio';
import { identifyVoice, type VoiceProfile } from '@patch/wire';
import {
  HANDOFF_REFUSED,
  handoffSpeakerLine,
  mayHearHistory,
  mayUseAgent,
  MicTape,
  recognisesSpeakers,
  speakerInstruction,
  type DeviceVoiceDeps,
} from './deviceVoice.js';
import { MIN_VOICEPRINT_SECONDS } from './speakerId.js';
import type { VoiceTimeline } from './voice-session-like.js';
import { SpokenReply } from './spokenReply.js';
import { MicLevelWatch, micSilentMessage } from './micLevel.js';
import { addTokens, ZERO_TOKENS, type EngineCosting, type EngineTokens } from './voiceCost.js';
import {
  DEFAULT_ADDRESS_WORD,
  isAddressed,
  type SessionInit,
  type SessionState,
} from './session.js';
import type { VoiceSessionLike } from './voice-session-like.js';
import {
  PASS_TO_AGENT_TOOL_NAME,
  SEND_TO_CHAT_TOOL_NAME,
  SWITCH_CHAT_TOOL_NAME,
  voiceAgentInstructions,
  type VoiceAgentLink,
  type VoiceToolSpec,
} from './voiceAgent.js';
import { VoiceAgentCall } from './voiceAgentCall.js';
import { openaiSchema } from './toolSchemas.js';
import type { VoiceToolbox } from './voiceTools.js';
import { ChatLookupError } from './chatLookup.js';
import {
  managerHostedInstruction,
  MANAGER_QUICK_TOOLS,
  MANAGER_QUICK_TOOL_NAMES,
  stringArgs,
  type ManagerVoiceTools,
} from './managerVoice.js';

/** Input transcription model the Realtime session uses to show the user's words. */
export const DEFAULT_OPENAI_REALTIME_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
export const DEFAULT_OPENAI_REALTIME_VOICE = 'marin';

function realtimeUrl(model: string): string {
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

export type OpenAIWsCtor = new (url: string, opts: { headers: Record<string, string> }) => WsSocket;

export interface OpenAIRealtimeDeps {
  logger: Logger;
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
  /** How it sounds, as `session` fields (`soundConfig` of the OpenAI engine description). */
  soundConfig?: Record<string, unknown>;
  /** OPENAI_REALTIME_API_KEY. The caller refuses to construct this class without one. */
  apiKey: string;
  /** Realtime model, from the voice agent setup. */
  model: string;
  /** Who does the work (spec/07 § The fast voice and the chat's agent). Defaults to `auto`. */
  handoff?: VoiceHandoff;
  /** The MCP servers' tools and the Patch tool groups turned off, for every call. */
  toolbox: VoiceToolbox;
  /** Set only on a call to the Manager (spec/07 § A call to the Manager); see gemini-live.ts. */
  manager?: ManagerVoiceTools;
  transcribeModel?: string;
  voice?: string;
  /**
   * The provider side is gone for good (never opened, or closed under us). The
   * audio server ends the surface session so the surface stops streaming into
   * a dead engine and shows the failure.
   */
  onFatal?: (message: string) => void;
  /** A voice device's session: the spoken-aloud prompt and who is speaking (spec/16). */
  device?: DeviceVoiceDeps;
  /** Test seam: substitute the WebSocket constructor. */
  wsCtor?: OpenAIWsCtor;
  /** Test seam: override the connect URL. */
  wsUrl?: string;
}

interface RealtimeUsage {
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: { text_tokens?: number; audio_tokens?: number };
  };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

/**
 * One response's usage, by kind. Cached input is reported inside the text and
 * audio input counts; it is taken out of them so it is priced once, at the
 * cached rate.
 */
export function realtimeUsageTokens(u: RealtimeUsage): EngineTokens {
  const i = u.input_token_details ?? {};
  const cached = i.cached_tokens ?? 0;
  const cachedText = i.cached_tokens_details?.text_tokens ?? 0;
  const cachedAudio = i.cached_tokens_details?.audio_tokens ?? cached - cachedText;
  return {
    textIn: (i.text_tokens ?? 0) - cachedText,
    audioIn: (i.audio_tokens ?? 0) - cachedAudio,
    cachedIn: cached,
    textOut: u.output_token_details?.text_tokens ?? 0,
    audioOut: u.output_token_details?.audio_tokens ?? 0,
  };
}

interface RealtimeServerEvent {
  type: string;
  item_id?: string;
  /** `input_audio_buffer.speech_started/stopped`: ms since the session's audio began. */
  audio_start_ms?: number;
  audio_end_ms?: number;
  delta?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { message?: string; code?: string; type?: string };
  response?: {
    status?: string;
    status_details?: { error?: { message?: string; code?: string }; reason?: string } | null;
    output?: Array<{ type?: string }>;
    usage?: RealtimeUsage;
  };
}

/**
 * Upsample 16 kHz PCM16 to 24 kHz (ratio 3:2) by linear interpolation. Output
 * sample j sits at input position 2j/3; the last fractional position of a
 * frame holds its final sample (the next frame isn't here yet).
 */
export function upsample16kTo24k(pcm: Int16Array): Int16Array {
  const outLen = Math.floor((pcm.length * 3) / 2);
  const out = new Int16Array(outLen);
  const last = pcm.length - 1;
  for (let j = 0; j < outLen; j++) {
    const pos = (j * 2) / 3;
    const i = Math.floor(pos);
    const frac = pos - i;
    const a = pcm[i]!;
    const b = pcm[Math.min(i + 1, last)]!;
    out[j] = Math.round(a + (b - a) * frac);
  }
  return out;
}

export class OpenAIRealtimeSession implements VoiceSessionLike {
  private readonly init: SessionInit;
  private readonly deps: OpenAIRealtimeDeps;
  private state: SessionState = 'connecting';
  /** The call's chat, tools and pushes (spec/07 § The voice agent and the chat's agent). */
  private readonly call: VoiceAgentCall;
  private mode: AudioSessionMode;
  private ws?: WsSocket;
  private setupDone = false;
  private closed = false;
  private fatal = false;
  private micQueue: string[] = [];
  private setupWaiter?: { resolve: () => void; reject: (err: Error) => void };
  private lastSpokeAt?: number;
  private partialByItem = new Map<string, string>();
  // Per-response bookkeeping, reset on every response.done.
  private responseHadAudio = false;
  private responseHadToolCall = false;
  // --- the reply as the user hears it (spec/07 § Barge-in) ---
  /** The reply being generated now, and the conversation item its audio belongs to. */
  private reply?: SpokenReply;
  private replyItemId?: string;
  /** The reply before it: over for OpenAI, maybe still playing on the surface. */
  private lastReply?: SpokenReply;
  private lastReplyItemId?: string;
  /** The reply in flight was cut off: what is still streaming of it was never heard. */
  private replyCut = false;
  // --- the chat timeline (spec/07 § Keeping voice and text as one conversation) ---
  /** The user is mid-utterance or its transcript has not landed yet. */
  private awaitingUserWords = false;
  /** Reply text that arrived before the user's words were written. */
  private heldReply = '';
  /** The chat as it stood when the call started; at the end of the instructions. */
  private startContext = '';
  private tokens: EngineTokens = ZERO_TOKENS;
  // --- who is speaking (spec/16 § Who is speaking) ---
  /** Settled at session start: recognise speakers, and answer only once we know who it was. */
  private gate = false;
  /** Who is speaking now; null is nobody recognised. */
  private speaker: VoiceProfile | null = null;
  /** The microphone, kept so each utterance can be cut out for its voiceprint. */
  private tape?: MicTape;
  private speechStartMs = 0;
  /** Between response.created and response.done. */
  private responseInFlight = false;
  /** A reply asked for while another was still going. */
  private replyQueued = false;
  /** Recent-voice entry per conversation item, filled with the words once they land. */
  private recentByItem = new Map<string, string>();
  /** Words that landed before their utterance's voiceprint did. */
  private wordsByItem = new Map<string, string>();
  /** Utterances whose voiceprint is still being taken. */
  private embedding = new Map<string, Promise<void>>();
  // Stats.
  private micFrames = 0;
  private micSamples = 0;
  private turns = 0;

  constructor(init: SessionInit, deps: OpenAIRealtimeDeps) {
    this.init = init;
    this.deps = deps;
    this.mode = init.mode ?? 'call';
    this.call = new VoiceAgentCall({
      link: deps.link,
      sessionId: init.sessionId,
      chatId: init.chatId,
      source:
        init.surfaceKind === 'device'
          ? { kind: 'voice-device', deviceId: init.deviceId ?? 'unknown' }
          : {
              kind: 'voice-app',
              surfaceKind: init.surfaceKind as 'web' | 'desktop' | 'mobile',
              sessionId: init.sessionId,
            },
      logger: deps.logger,
      toolbox: deps.toolbox,
      sendAudio: deps.sendAudio,
      ...(init.callReason !== undefined ? { callReason: init.callReason } : {}),
    });
    this.gate = recognisesSpeakers(deps.device) && deps.device?.embed !== undefined;
    if (deps.device?.embed !== undefined) this.tape = new MicTape();
  }

  /** Who this session takes the speaker to be (null: nobody recognised). */
  getSpeaker(): VoiceProfile | null {
    return this.speaker;
  }

  getMode(): AudioSessionMode {
    return this.mode;
  }

  setMode(next: AudioSessionMode): void {
    if (this.mode === next) return;
    this.mode = next;
    this.deps.logger.info(
      { sessionId: this.init.sessionId, mode: next },
      'openai-realtime: mode changed',
    );
    if (this.setupDone)
      this.sendJson({
        type: 'session.update',
        session: { type: 'realtime', audio: { input: { turn_detection: this.turnDetection() } } },
      });
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
      // Server-side VAD — nothing local to count.
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

  private reportError(message: string): void {
    this.deps.logger.error({ sessionId: this.init.sessionId, message }, 'openai-realtime: error');
    this.deps.sendAudio({
      type: 'audio.error',
      code: 'openai_unavailable',
      message,
      sessionId: this.init.sessionId,
    });
  }

  private die(message: string): void {
    if (this.fatal || this.closed) return;
    this.fatal = true;
    this.reportError(message);
    this.deps.onFatal?.(message);
  }

  private turnDetection(): Record<string, unknown> {
    const answersEverything = !modeRequiresAddress(this.mode);
    return {
      type: 'server_vad',
      // Recognising speakers: we ask for the reply ourselves once we know who spoke.
      create_response: answersEverything && !this.gate,
      interrupt_response: answersEverything,
    };
  }

  /** The hand-off mode in force: someone who may not use the agent gets none. */
  private effectiveHandoff(): VoiceHandoff {
    const handoff = this.deps.handoff ?? 'auto';
    return this.gate && !mayUseAgent(this.speaker) ? 'never' : handoff;
  }

  /** Whether the chat's history (start context, look-back, switch chat, pushes) may reach this speaker. */
  private historyAllowed(): boolean {
    return !this.gate || mayHearHistory(this.speaker);
  }

  private instructions(): string {
    const extra: string[] = [];
    if (this.deps.device) extra.push(this.deps.device.prompt());
    if (this.gate) extra.push(speakerInstruction(this.speaker));
    return voiceAgentInstructions({
      instructions: this.deps.manager
        ? managerHostedInstruction(this.deps.manager.voicePrompt?.())
        : this.deps.instructions,
      extra,
      ...(this.deps.tone !== undefined ? { tone: this.deps.tone } : {}),
      startContext: this.historyAllowed() ? this.startContext : '',
    });
  }

  /** The parts of the session that change with who is speaking. */
  private speakerConfig(): Record<string, unknown> {
    const history = this.historyAllowed();
    const manager = this.deps.manager !== undefined;
    const tools = this.call.tools({
      // A Manager call has its own tools and no agent behind it; `never` has no agent either.
      handoff: manager ? 'never' : this.effectiveHandoff(),
      lookBack: history,
      switchChat: !manager && history,
      ...(manager ? { quick: MANAGER_QUICK_TOOLS } : {}),
    });
    return {
      instructions: this.instructions(),
      tools: tools.map(realtimeTool),
      tool_choice: 'auto',
    };
  }

  private sessionConfig(): Record<string, unknown> {
    const session = {
      type: 'realtime',
      ...this.speakerConfig(),
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: {
            model: this.deps.transcribeModel ?? DEFAULT_OPENAI_REALTIME_TRANSCRIBE_MODEL,
            language: 'en',
          },
          turn_detection: this.turnDetection(),
        },
        output: {
          format: { type: 'audio/pcm', rate: 24000 },
          voice: this.deps.voice ?? DEFAULT_OPENAI_REALTIME_VOICE,
        },
      },
    };
    return {
      type: 'session.update',
      session: mergeConfig(session, this.deps.soundConfig ?? {}),
    };
  }

  private sendJson(msg: unknown): void {
    if (!this.ws || this.closed) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.reportError(`send to OpenAI Realtime failed: ${(err as Error).message}`);
    }
  }

  onSessionStart(): void {
    if (this.state !== 'connecting') return;
    void this.connect().catch((err: Error) => {
      this.die(`OpenAI Realtime session failed to open: ${err.message}`);
    });
  }

  private async connect(): Promise<void> {
    const url = this.deps.wsUrl ?? realtimeUrl(this.deps.model);
    const Ctor = this.deps.wsCtor ?? (WsImpl as unknown as OpenAIWsCtor);
    const ws = new Ctor(url, { headers: { Authorization: `Bearer ${this.deps.apiKey}` } });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err: Error) => reject(err));
    });
    ws.on('message', (data: Buffer | string) => this.onWsMessage(data));
    ws.on('close', (code: number, reason: Buffer | string) => this.onWsClose(code, reason));
    ws.on('error', (err: Error) => {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, err: err.message },
        'openai-realtime: ws error',
      );
    });
    const configured = new Promise<void>((resolve, reject) => {
      this.setupWaiter = { resolve, reject };
    });
    // spec/07 § Keeping voice and text as one conversation — the chat as it stands, at the
    // end of the instructions. A chat that cannot be read fails the session loudly.
    this.startContext = this.call.startContext();
    await this.call.loadTools();
    if (this.closed) return;
    const config = this.sessionConfig();
    // The full text, so what the voice was told can be read back from the log.
    this.deps.logger.info(
      { sessionId: this.init.sessionId, instructions: this.instructions() },
      'openai-realtime: instructions',
    );
    this.sendJson(config);
    await configured;
    if (this.closed) return;
    this.setupDone = true;
    this.setState('listening');
    const queued = this.micQueue;
    this.micQueue = [];
    // Load the speaker model now, so the first utterance does not wait for it.
    this.deps.device?.warm?.();
    for (const b64 of queued) this.sendJson({ type: 'input_audio_buffer.append', audio: b64 });
    this.call.attach({
      addContext: (text) => this.sendJson(userText(text)),
      speakAbout: (text) => {
        this.sendJson(userText(text));
        this.askForReply();
      },
      isIdle: () =>
        this.setupDone &&
        !this.responseInFlight &&
        !this.replyQueued &&
        !this.awaitingUserWords &&
        this.state !== 'speaking' &&
        this.state !== 'transcribing',
      playbackLeftMs: () => Math.max(this.reply?.leftMs() ?? 0, this.lastReply?.leftMs() ?? 0),
    });
  }

  async onMicFrame(pcm: Int16Array): Promise<void> {
    if (this.closed || this.fatal) return;
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
    if (pcm.length === 0) return;
    this.tape?.push(pcm);
    // Convert synchronously — `pcm` may be a view onto a pooled buffer.
    const up = upsample16kTo24k(pcm);
    const b64 = Buffer.from(up.buffer, up.byteOffset, up.byteLength).toString('base64');
    if (!this.setupDone) {
      this.micQueue.push(b64);
      return;
    }
    this.sendJson({ type: 'input_audio_buffer.append', audio: b64 });
  }

  private onWsMessage(data: Buffer | string): void {
    let ev: RealtimeServerEvent;
    try {
      ev = JSON.parse(
        typeof data === 'string' ? data : data.toString('utf8'),
      ) as RealtimeServerEvent;
    } catch (err) {
      this.reportError(`unparseable frame from OpenAI Realtime: ${(err as Error).message}`);
      return;
    }
    switch (ev.type) {
      case 'session.updated': {
        const w = this.setupWaiter;
        this.setupWaiter = undefined;
        w?.resolve();
        return;
      }
      case 'error': {
        const message = `OpenAI Realtime error${ev.error?.code ? ` (${ev.error.code})` : ''}: ${ev.error?.message ?? 'unknown'}`;
        if (this.setupWaiter) {
          const w = this.setupWaiter;
          this.setupWaiter = undefined;
          w.reject(new Error(message));
          return;
        }
        this.reportError(message);
        return;
      }
      case 'input_audio_buffer.speech_stopped':
        if (this.tape) {
          const id = ev.item_id ?? '';
          const done = this.onUtteranceEnd(id, ev.audio_end_ms ?? 0).finally(() =>
            this.embedding.delete(id),
          );
          this.embedding.set(id, done);
        }
        return;
      case 'input_audio_buffer.speech_started':
        this.speechStartMs = ev.audio_start_ms ?? 0;
        this.awaitingUserWords = true;
        if (
          (this.state === 'speaking' || this.lastReply?.playing() === true) &&
          !modeRequiresAddress(this.mode)
        ) {
          // Barge-in — the server has already cancelled its reply
          // (interrupt_response); stop what the surface is still playing, and
          // cut the reply, in OpenAI's record and the chat's, to what was heard.
          this.cutReply();
          this.deps.sendAudio({
            type: 'audio.barge_in',
            sessionId: this.init.sessionId,
            at: Date.now(),
          });
          this.deps.sendAudio({
            type: 'audio.tts_end',
            sessionId: this.init.sessionId,
            bargedIn: true,
          });
          this.setState('listening');
        }
        return;
      case 'conversation.item.input_audio_transcription.delta': {
        const id = ev.item_id ?? '';
        const text = (this.partialByItem.get(id) ?? '') + (ev.delta ?? '');
        this.partialByItem.set(id, text);
        if (this.state === 'listening') this.setState('transcribing');
        this.deps.sendAudio({
          type: 'audio.transcript_partial',
          sessionId: this.init.sessionId,
          text,
        });
        return;
      }
      case 'conversation.item.input_audio_transcription.completed':
        this.onTranscript(ev.item_id ?? '', (ev.transcript ?? '').trim());
        return;
      case 'conversation.item.input_audio_transcription.failed':
        this.partialByItem.delete(ev.item_id ?? '');
        this.reportError(
          `OpenAI Realtime could not transcribe what was said: ${ev.error?.message ?? 'unknown'}`,
        );
        if (this.state === 'transcribing') this.setState('listening');
        this.call.flush();
        return;
      case 'response.created':
        this.responseInFlight = true;
        if (this.state !== 'speaking') this.setState('thinking');
        return;
      case 'response.output_audio_transcript.delta':
        if (ev.delta) this.onReplyText(ev.delta);
        return;
      case 'response.output_audio.delta': {
        if (!ev.delta) return;
        const buf = Buffer.from(ev.delta, 'base64');
        const pcm = new Int16Array(buf.byteLength >>> 1);
        new Uint8Array(pcm.buffer).set(buf.subarray(0, pcm.byteLength));
        if (pcm.length === 0) return;
        if (this.replyCut) return;
        this.responseHadAudio = true;
        this.spokenReply().audio(pcm.length);
        if (ev.item_id !== undefined) this.replyItemId = ev.item_id;
        if (this.state !== 'speaking') this.setState('speaking');
        this.deps.sendAudio({
          type: 'audio.tts_chunk',
          sessionId: this.init.sessionId,
          samples: pcm.length,
        });
        this.deps.sendBinary(pcm);
        return;
      }
      case 'response.function_call_arguments.done':
        if (this.deps.manager && ev.call_id && ev.name && MANAGER_QUICK_TOOL_NAMES.has(ev.name)) {
          this.responseHadToolCall = true;
          void this.handleManagerTool(this.deps.manager, ev.call_id, ev.name, ev.arguments ?? '{}');
        }
        if (ev.name && ev.call_id && this.call.handles(ev.name)) {
          this.responseHadToolCall = true;
          void this.handleVoiceTool(ev.call_id, ev.name, ev.arguments ?? '{}');
        }
        return;
      case 'response.done':
        this.responseInFlight = false;
        this.onResponseDone(ev.response ?? {});
        if (this.replyQueued && !this.closed) {
          this.replyQueued = false;
          this.sendJson({ type: 'response.create' });
        }
        this.call.flush();
        return;
      default:
        return;
    }
  }

  /**
   * An utterance ended (the provider's VAD). Take its voiceprint, keep it for
   * enrolment, and, when recognising speakers, settle who spoke before asking
   * for the reply: the instructions and tools change with the speaker.
   */
  private async onUtteranceEnd(itemId: string, endMs: number): Promise<void> {
    const device = this.deps.device!;
    const pcm = this.tape!.slice(this.speechStartMs, endMs);
    const seconds = pcm.length / 16000;
    if (seconds >= MIN_VOICEPRINT_SECONDS && device.embed) {
      try {
        const voiceprint = await device.embed(pcm);
        const profiles = device.profiles();
        const match = identifyVoice(voiceprint, profiles, device.threshold?.());
        const words = this.wordsByItem.get(itemId);
        this.wordsByItem.delete(itemId);
        const recentId = device.recent?.add({
          at: Date.now(),
          text: words ?? '',
          seconds: Number(seconds.toFixed(1)),
          voiceprint: voiceprint.map((x) => Math.round(x * 1e5) / 1e5),
          ...(match.profile ? { matchedProfileId: match.profile.id } : {}),
          score: Number(match.score.toFixed(3)),
        });
        if (recentId !== undefined && words === undefined) this.recentByItem.set(itemId, recentId);
        this.deps.logger.info(
          {
            sessionId: this.init.sessionId,
            seconds: Number(seconds.toFixed(1)),
            speaker: match.profile?.name ?? null,
            score: Number(match.score.toFixed(3)),
          },
          'openai-realtime: voice heard',
        );
        if (this.gate) this.setSpeaker(match.profile);
      } catch (err) {
        // The previous speaker stands; the reply still goes out.
        this.deps.logger.warn(
          { sessionId: this.init.sessionId, err: (err as Error).message },
          'openai-realtime: voiceprint failed',
        );
      }
    }
    // Too short to tell ("yes", "thanks"): the previous speaker stands.
    if (this.gate && !this.closed) this.askForReply();
  }

  /**
   * Ask for the reply to what was just said. One response at a time: with one
   * still going (a hand-off's answer being spoken), this one follows it.
   */
  private askForReply(): void {
    if (this.responseInFlight) {
      this.replyQueued = true;
      return;
    }
    this.sendJson({ type: 'response.create' });
  }

  private setSpeaker(next: VoiceProfile | null): void {
    if ((next?.id ?? null) === (this.speaker?.id ?? null)) return;
    this.speaker = next;
    this.sendJson({
      type: 'session.update',
      session: { type: 'realtime', ...this.speakerConfig() },
    });
  }

  private onReplyText(delta: string): void {
    // The rest of a reply the user cut off was never said to them.
    if (this.replyCut) return;
    // The voice's words about an agent's answer are written too: the answer is already in
    // the chat as the agent's own message, and what the voice said of it is a separate
    // thing the user heard and should be able to read.
    if (this.awaitingUserWords) {
      this.heldReply += delta;
      return;
    }
    this.spokenReply().append(delta);
  }

  /** The reply being generated now, begun on its first words or audio. */
  private spokenReply(): SpokenReply {
    this.reply ??= new SpokenReply(() => this.deps.timeline.beginReply(this.call.chatId));
    return this.reply;
  }

  /** Nothing more of the reply is coming; its message in the chat is complete unless the user cuts it. */
  private finishReply(): void {
    if (!this.reply) return;
    this.reply.end();
    this.lastReply = this.reply;
    this.lastReplyItemId = this.replyItemId;
    this.reply = undefined;
    this.replyItemId = undefined;
  }

  /**
   * The user spoke over the reply: cut it, in OpenAI's conversation and in the
   * chat, to what had played.
   */
  private cutReply(): void {
    if (this.responseInFlight) this.replyCut = true;
    const target = this.reply ?? this.lastReply;
    const itemId = this.reply ? this.replyItemId : this.lastReplyItemId;
    this.reply = undefined;
    this.replyItemId = undefined;
    this.lastReply = undefined;
    this.lastReplyItemId = undefined;
    const heardMs = target?.cut() ?? null;
    if (heardMs === null) return;
    if (itemId !== undefined) {
      this.sendJson({
        type: 'conversation.item.truncate',
        item_id: itemId,
        content_index: 0,
        audio_end_ms: Math.floor(heardMs),
      });
    }
    this.deps.logger.info(
      {
        sessionId: this.init.sessionId,
        heardMs: Math.round(heardMs),
        audioMs: Math.round(target!.audioMs()),
      },
      'openai-realtime: reply cut off',
    );
  }

  /** The user's words are settled (written, or dropped): release any held reply. */
  private releaseHeldReply(): void {
    this.awaitingUserWords = false;
    const held = this.heldReply;
    this.heldReply = '';
    if (held) this.onReplyText(held);
  }

  engineCosting(): EngineCosting {
    return { backend: 'openai', model: this.deps.model, tokens: this.tokens, stt: null };
  }

  setLine(up: boolean): void {
    this.call.setLine(up);
  }

  pushMessage(text: string, opts: { handoffSettled?: boolean } = {}): void {
    // The chat's activity is its history: not for someone who may not hear it.
    if (!this.historyAllowed() && opts.handoffSettled !== true) {
      this.deps.logger.info(
        { sessionId: this.init.sessionId },
        'openai-realtime: a chat reply was not pushed: this speaker may not hear the chat',
      );
      return;
    }
    this.call.push(text, opts);
  }

  private onTranscript(itemId: string, text: string): void {
    // Recognising speakers: who said it is settled before the words are
    // written. The reply waits for the same thing, so nothing reorders.
    const pending = this.embedding.get(itemId);
    if (this.gate && pending !== undefined) {
      void pending.then(() => this.onTranscript(itemId, text));
      return;
    }
    this.partialByItem.delete(itemId);
    const addressed =
      !modeRequiresAddress(this.mode) ||
      text.length === 0 ||
      isAddressed(
        text,
        this.init.addressWord ?? DEFAULT_ADDRESS_WORD,
        this.lastSpokeAt === undefined ? undefined : Date.now() - this.lastSpokeAt,
      );
    this.deps.sendAudio({
      type: 'audio.transcript_final',
      sessionId: this.init.sessionId,
      text,
      ...(addressed ? {} : { addressed: false }),
    });
    if (text.length === 0) {
      this.releaseHeldReply();
      if (this.state === 'transcribing') this.setState('listening');
      return;
    }
    if (!addressed) {
      // Heard, not for us: never a turn, and never context either.
      this.heldReply = '';
      this.awaitingUserWords = false;
      this.sendJson({ type: 'conversation.item.delete', item_id: itemId });
      if (this.state === 'transcribing') this.setState('listening');
      this.call.flush();
      return;
    }
    this.turns += 1;
    const recentId = this.recentByItem.get(itemId);
    if (recentId !== undefined) {
      this.recentByItem.delete(itemId);
      this.deps.device?.recent?.setText(recentId, text);
    } else if (this.tape) {
      this.wordsByItem.set(itemId, text);
    }
    this.deps.timeline.userSaid(
      this.call.chatId,
      this.gate ? `${this.speaker?.name ?? 'Unrecognised voice'}: ${text}` : text,
    );
    // spec/07 § Permission prompts during voice — a spoken yes / no answers a waiting permission.
    this.deps.link.answerPermission(this.call.chatId, text);
    this.releaseHeldReply();
    if (modeRequiresAddress(this.mode)) {
      // hands-free: the server VAD was told not to answer on its own.
      this.sendJson({ type: 'response.create' });
    }
    if (this.state === 'transcribing') this.setState('thinking');
  }

  private onResponseDone(response: NonNullable<RealtimeServerEvent['response']>): void {
    const hadAudio = this.responseHadAudio;
    const hadTool =
      this.responseHadToolCall || (response.output ?? []).some((o) => o.type === 'function_call');
    this.responseHadAudio = false;
    this.responseHadToolCall = false;
    const wasCut = this.replyCut;
    this.replyCut = false;
    if (response.usage) this.tokens = addTokens(this.tokens, realtimeUsageTokens(response.usage));
    // Reply text still held for words that never settled is written anyway,
    // rather than lost.
    if (!this.awaitingUserWords) this.finishReply();
    if (response.status === 'failed') {
      const detail =
        response.status_details?.error?.message ?? response.status_details?.reason ?? 'no detail';
      this.reportError(`OpenAI Realtime reply failed: ${detail}`);
    } else if (response.status === 'completed' && !hadAudio && !hadTool) {
      // NO SILENT FAILURES: a reply the user can't hear is a lost reply.
      this.reportError('OpenAI Realtime reply produced no audio for the surface');
    } else if (response.status === 'incomplete') {
      this.reportError(
        `OpenAI Realtime reply cut short: ${response.status_details?.reason ?? 'no detail'}`,
      );
    }
    // A cancelled response was barged in on — tts_end already went out.
    if (hadAudio && response.status !== 'cancelled' && !wasCut) {
      this.deps.sendAudio({ type: 'audio.tts_end', sessionId: this.init.sessionId });
    }
    this.setState('listening');
  }

  /** The voice agent's own tools (voiceAgent.ts), answered through the shared call. */
  private async handleVoiceTool(callId: string, name: string, rawArgs: string): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      /* the tool reports the missing arguments itself */
    }
    let result: string;
    if (
      name === PASS_TO_AGENT_TOOL_NAME ||
      name === SEND_TO_CHAT_TOOL_NAME ||
      name === SWITCH_CHAT_TOOL_NAME
    ) {
      // The chat reads in order: what the user said, what the voice said, then the hand-off.
      this.finishReply();
    }
    if (name === PASS_TO_AGENT_TOOL_NAME && this.gate && !mayUseAgent(this.speaker)) {
      // Decided here, not by the model: the tool is withdrawn for such a
      // speaker, and a call that arrives anyway (a race with a speaker change)
      // never reaches the agent.
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, args },
        'openai-realtime: hand-off refused, speaker not recognised',
      );
      result = HANDOFF_REFUSED;
    } else {
      if (name === PASS_TO_AGENT_TOOL_NAME && this.gate && this.speaker !== null) {
        args = {
          ...args,
          request: handoffSpeakerLine(this.speaker) + String(args['request'] ?? ''),
        };
      }
      result = await this.call.runTool(name, args);
    }
    if (this.closed || this.fatal) return;
    this.sendJson({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ result }) },
    });
    this.askForReply();
  }

  /** Where a quick tool is being called from: the device this conversation is on, if it is one. */
  private quickContext(): { deviceId?: string } {
    return this.init.deviceId !== undefined ? { deviceId: this.init.deviceId } : {};
  }

  /**
   * A Manager call's own quick tools (spec/07 § A call to the Manager), answered at once.
   */
  private async handleManagerTool(
    manager: ManagerVoiceTools,
    callId: string,
    name: string,
    rawArgs: string,
  ): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      /* the tool reports the missing arguments itself */
    }
    this.deps.logger.info(
      { sessionId: this.init.sessionId, tool: name, args },
      'openai-realtime: manager tool',
    );
    let result: string;
    try {
      result = await manager.quick(name, stringArgs(args), this.quickContext());
    } catch (err) {
      const reason = (err as Error).message;
      result = reason;
      if (!(err instanceof ChatLookupError)) {
        this.reportError(`${name} failed: ${reason}`);
      }
    }
    if (this.closed || this.fatal) return;
    this.sendJson({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ result }) },
    });
    this.askForReply();
  }

  private onWsClose(code: number, reason: Buffer | string): void {
    if (this.closed) return;
    const why = typeof reason === 'string' ? reason : reason?.toString('utf8');
    const message = `OpenAI Realtime closed the session (code ${code}${why ? `: ${why}` : ''})`;
    if (this.setupWaiter) {
      const w = this.setupWaiter;
      this.setupWaiter = undefined;
      w.reject(new Error(message));
      return;
    }
    this.die(message);
  }

  /** Not a note engine — this class only backs `role: 'voice-call'` (audio/server.ts). */
  async finalizeNote(): Promise<boolean> {
    return false;
  }

  async injectTranscript(text: string): Promise<void> {
    if (this.closed || !this.setupDone) return;
    this.sendJson({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    this.sendJson({ type: 'response.create' });
  }

  /** An out-of-band reply that reads `text` out and is not kept as conversation. */
  async speak(text: string): Promise<void> {
    if (this.closed || !this.setupDone) return;
    this.sendJson({
      type: 'response.create',
      response: {
        conversation: 'none',
        instructions: `Say exactly the following out loud, verbatim, and nothing else: ${text}`,
      },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.releaseHeldReply();
    this.reply?.flush();
    this.lastReply?.flush();
    this.call.close();
    this.closed = true;
    const w = this.setupWaiter;
    this.setupWaiter = undefined;
    w?.reject(new Error('session closed'));
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}

/** One of the voice agent's tools in Realtime's function shape. */
function realtimeTool(t: VoiceToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: openaiSchema(t.schema),
  };
}

/** Text added to the conversation from the user's side: context, or a push to speak about. */
function userText(text: string): Record<string, unknown> {
  return {
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  };
}
