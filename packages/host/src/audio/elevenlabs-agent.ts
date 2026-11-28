// Hosted voice tier: ElevenLabs Agents (spec/07 § Voice — a config matrix,
// `backend: elevenlabs`). The third hosted tier beside gemini-live.ts and
// openai-realtime.ts, built the same way: the HOST relays the surface's mic PCM
// to one ElevenLabs Agents conversation over a server-side WebSocket and
// streams the agent's audio back down the surface's existing audio WSS. No
// surface talks to ElevenLabs or holds a key.
//
// The agent IS the voice agent and passes work to the chat's agent with the
// voice agent's tools (voiceAgent.ts), registered as CLIENT tools and answered
// here by the host with `client_tool_result` through the shared
// VoiceAgentCall, exactly as on the other providers.
//
// An ElevenLabs agent is a stored object (prompt, LLM, tools, voice), not
// something a WebSocket configures on the fly, and its tools cannot be
// overridden per conversation. So each session PROVISIONS a throwaway agent
// from the account's voice agent setup — its LLM, voice and sound, the user's
// voice instructions with the chat's start context after them, the client
// tools — opens a conversation
// on a signed URL, and DELETES the agent and tools when the session ends. No
// agent ids are kept on disk; nothing drifts from the code. A failed delete is
// logged as an error, never swallowed.
//
// Audio: the agent is created with 16 kHz PCM in (what surfaces send, so no
// resampling) and 24 kHz PCM out (what the surfaces' TTS sinks play). The
// formats the conversation reports back are checked; a mismatch fails the
// session rather than playing garbled audio.
//
// Hands-free is enforced on the OUTPUT side only. ElevenLabs gives no way to
// stop its agent answering by itself, so in `hands-free` a finished transcript
// that is not addressed (the same `isAddressed` rule as the other tiers) is
// reported as heard-but-not-sent and the agent's reply to it is DROPPED — its
// audio never reaches the surface and its words never reach the chat. The agent
// still heard it (it is in its context and billed), unlike the OpenAI tier
// where the item is deleted.
//
// Barge-in (spec/07 § Barge-in): ElevenLabs keeps the agent's record of its
// own reply on its side and cuts it there when the user interrupts (it reports
// the cut as `agent_response_correction`); there is no client message to set
// where. The reply written into the chat is cut on the host to what the user
// heard: the time since its first audio chunk went to the surface.
//
// NO SILENT FALLBACK. Provisioning failure, a failed connect, a provider error
// or close, a format mismatch: reported as `audio.error {code:
// 'elevenlabs_unavailable'}`; a closed or never-opened conversation is fatal
// and ends the surface session (`onFatal`).

import type { Logger } from 'pino';
import { WebSocket as WsImpl, type WebSocket as WsSocket } from 'ws';
import type { AudioEvent, AudioSessionMode, VoiceHandoff } from '@patch/wire/audio';
import { mergeConfig, modeRequiresAddress } from '@patch/wire/audio';
import type { VoiceTimeline, VoiceSessionLike } from './voice-session-like.js';
import { SpokenReply } from './spokenReply.js';
import { MicLevelWatch, micSilentMessage } from './micLevel.js';
import { ZERO_TOKENS, type EngineCosting } from './voiceCost.js';
import {
  DEFAULT_ADDRESS_WORD,
  isAddressed,
  type SessionInit,
  type SessionState,
} from './session.js';
import {
  isNoiseTranscript,
  voiceAgentInstructions,
  voiceAgentTools,
  type VoiceAgentLink,
} from './voiceAgent.js';
import { VoiceAgentCall } from './voiceAgentCall.js';
import { ChatLookupError } from './chatLookup.js';
import {
  managerHostedInstruction,
  MANAGER_QUICK_TOOLS,
  MANAGER_QUICK_TOOL_NAMES,
  stringArgs,
  type ManagerVoiceTools,
} from './managerVoice.js';

export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';
const INPUT_FORMAT = 'pcm_16000';
const OUTPUT_FORMAT = 'pcm_24000';

/**
 * Longest a call may run. Set explicitly: left unset, ElevenLabs applies its own
 * default cap (about 10 minutes) and cuts longer calls off. One hour bounds the
 * spend at the $0.08/min billing rate (about $4.80) if a call is left open.
 */
export const ELEVENLABS_MAX_CALL_SECONDS = 3600;

/**
 * The server events the call is sent. Naming them replaces ElevenLabs' default
 * set, so this is every event the session handles. `agent_response_complete` is
 * the end of a reply and is only sent when asked for here; it is the only event
 * that marks the end of a reply's audio (`agent_response` arrives once the text is
 * done, usually while its audio is still streaming).
 */
export const CLIENT_EVENTS = [
  'conversation_initiation_metadata',
  'ping',
  'audio',
  'interruption',
  'user_transcript',
  'agent_response',
  'agent_response_correction',
  'agent_response_complete',
  'client_tool_call',
] as const;

/**
 * How long the agent has to be provisioned, connected and initiated before the
 * call is declared failed. Kept under the phone's 15s connect timeout so the
 * user is told which stage stalled instead of "no answer from the host".
 */
export const SETUP_TIMEOUT_MS = 12_000;

/** Expressive audio tags the voice model writes into its text (`[happy] Banana!`). */
const AUDIO_TAG = /\[[a-z][a-z ]*\]\s*/gi;

export type ElevenLabsWsCtor = new (url: string) => WsSocket;
export type ElevenLabsFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ElevenLabsAgentDeps {
  logger: Logger;
  /** A voice device's session: what it is told about speaking aloud (spec/16 § Speaking aloud). */
  spokenAloud?: string;
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
  /** How it sounds, as `conversation_config` fields (`soundConfig` of the ElevenLabs engine description). */
  soundConfig?: Record<string, unknown>;
  /** ELEVEN_LABS_API_KEY. The caller refuses to construct this class without one. */
  apiKey: string;
  /** The agent's LLM, from the voice agent setup. */
  llm: string;
  /** Who does the work (spec/07 § The fast voice and the chat's agent). Defaults to `auto`. */
  handoff?: VoiceHandoff;
  /** Set only on a call to the Manager (spec/07 § A call to the Manager); see gemini-live.ts. */
  manager?: ManagerVoiceTools;
  /** An ElevenLabs voice id; absent uses the platform default voice. */
  voice?: string;
  /** The conversation is gone for good; the audio server ends the surface session. */
  onFatal?: (message: string) => void;
  /** Test seams. */
  /** Override of {@link SETUP_TIMEOUT_MS}. */
  setupTimeoutMs?: number;
  wsCtor?: ElevenLabsWsCtor;
  fetchImpl?: ElevenLabsFetch;
  apiBase?: string;
}

interface AgentEvent {
  type?: string;
  conversation_initiation_metadata_event?: {
    conversation_id?: string;
    agent_output_audio_format?: string;
    user_input_audio_format?: string;
  };
  user_transcription_event?: { user_transcript?: string };
  agent_response_event?: { agent_response?: string };
  audio_event?: { audio_base_64?: string; event_id?: number };
  interruption_event?: { event_id?: number };
  agent_response_correction_event?: {
    original_agent_response?: string;
    corrected_agent_response?: string;
  };
  ping_event?: { event_id?: number; ping_ms?: number };
  client_tool_call?: { tool_name?: string; tool_call_id?: string; parameters?: unknown };
  // Tolerated spellings of a provider-side error.
  message?: string;
  error?: string | { message?: string };
}

export class ElevenLabsAgentSession implements VoiceSessionLike {
  private readonly init: SessionInit;
  private readonly deps: ElevenLabsAgentDeps;
  private state: SessionState = 'connecting';
  /** The call's chat, tools and pushes (spec/07 § The voice agent and the chat's agent). */
  private readonly call: VoiceAgentCall;
  private mode: AudioSessionMode;
  private ws?: WsSocket;
  private setupDone = false;
  private closed = false;
  private fatal = false;
  private micQueue: Buffer[] = [];
  private setupStage = 'reading the chat';
  private setupTimer?: ReturnType<typeof setTimeout>;
  private setupWaiter?: { resolve: () => void; reject: (err: Error) => void };
  private lastSpokeAt?: number;
  private agentId?: string;
  private toolIds: string[] = [];
  private cleanedUp = false;
  private openedAt?: number;
  private conversationId?: string;
  private closedAt?: number;
  /** Hands-free: the agent's reply to a heard-but-not-addressed transcript is dropped. */
  private suppressReply = false;
  private audioOpen = false;
  /** The chat as it stood when the call started; at the end of the agent's prompt. */
  private startContext = '';
  // --- the reply as the user hears it (spec/07 § Barge-in) ---
  /** The reply being spoken now. */
  private reply?: SpokenReply;
  /** The reply before it: over for ElevenLabs, maybe still playing on the surface. */
  private lastReply?: SpokenReply;
  private micFrames = 0;
  private micSamples = 0;
  private turns = 0;
  private readonly micLevel = new MicLevelWatch();

  constructor(init: SessionInit, deps: ElevenLabsAgentDeps) {
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
      sendAudio: deps.sendAudio,
      ...(init.callReason !== undefined ? { callReason: init.callReason } : {}),
    });
  }

  getMode(): AudioSessionMode {
    return this.mode;
  }

  setMode(next: AudioSessionMode): void {
    if (this.mode === next) return;
    this.mode = next;
    this.deps.logger.info(
      { sessionId: this.init.sessionId, mode: next },
      'elevenlabs-agent: mode changed',
    );
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
      vadEvents: 0,
      turns: this.turns,
      micPeakDbfs: this.micLevel.peakDbfs(),
    };
  }

  engineCosting(): EngineCosting {
    const end = this.closedAt ?? Date.now();
    return {
      backend: 'elevenlabs',
      model: this.deps.llm,
      tokens: ZERO_TOKENS,
      stt: null,
      agentSeconds: this.openedAt === undefined ? 0 : Math.max(0, (end - this.openedAt) / 1000),
      ...(this.conversationId !== undefined ? { conversationId: this.conversationId } : {}),
    };
  }

  private setState(next: SessionState): void {
    if (this.state === next) return;
    if (this.state === 'speaking') this.lastSpokeAt = Date.now();
    this.state = next;
    this.deps.sendAudio({ type: 'audio.state', sessionId: this.init.sessionId, state: next });
  }

  private reportError(message: string): void {
    this.deps.logger.error({ sessionId: this.init.sessionId, message }, 'elevenlabs-agent: error');
    this.deps.sendAudio({
      type: 'audio.error',
      code: 'elevenlabs_unavailable',
      message,
      sessionId: this.init.sessionId,
    });
  }

  private die(message: string): void {
    if (this.fatal || this.closed) return;
    this.fatal = true;
    this.reportError(message);
    void this.cleanup();
    this.deps.onFatal?.(message);
  }

  // --- REST: the throwaway agent -------------------------------------------

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const doFetch: ElevenLabsFetch = this.deps.fetchImpl ?? ((u, i) => fetch(u, i));
    const res = await doFetch(`${this.deps.apiBase ?? ELEVENLABS_API_BASE}${path}`, {
      method,
      headers: {
        'xi-api-key': this.deps.apiKey,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`ElevenLabs ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return text === '' ? {} : JSON.parse(text);
  }

  private clientTool(
    name: string,
    description: string,
    params: Record<string, string>,
    required: string[] = Object.keys(params),
  ) {
    return {
      tool_config: {
        type: 'client',
        name,
        description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(params).map(([k, d]) => [k, { type: 'string', description: d }]),
          ),
          required,
        },
        // The agent waits for the host's answer — a dispatch can take minutes.
        expects_response: true,
        response_timeout_secs: -1,
      },
    };
  }

  private async provision(): Promise<string> {
    const manager = this.deps.manager;
    const tools: Array<ReturnType<ElevenLabsAgentSession['clientTool']>> = [];
    if (manager) {
      // A Manager call (spec/07 § A call to the Manager): its own tools, no agent behind it.
      tools.push(
        ...MANAGER_QUICK_TOOLS.map((t) =>
          this.clientTool(t.name, t.description, t.params, t.required),
        ),
      );
    }
    for (const t of voiceAgentTools({
      handoff: manager ? 'never' : (this.deps.handoff ?? 'auto'),
      lookBack: true,
      switchChat: !manager,
    })) {
      tools.push(this.clientTool(t.name, t.description, t.params, t.required));
    }
    const prompt = voiceAgentInstructions({
      instructions: manager
        ? managerHostedInstruction(manager.voicePrompt?.())
        : this.deps.instructions,
      extra: this.deps.spokenAloud ? [this.deps.spokenAloud] : [],
      ...(this.deps.tone !== undefined ? { tone: this.deps.tone } : {}),
      startContext: this.startContext,
    });
    // The full text, so what the voice was told can be read back from the log.
    this.deps.logger.info({ sessionId: this.init.sessionId, prompt }, 'elevenlabs-agent: prompt');
    for (const t of tools) {
      const made = (await this.api('POST', '/v1/convai/tools', t)) as { id?: string };
      if (!made.id) throw new Error('ElevenLabs created a tool but returned no id');
      this.toolIds.push(made.id);
    }
    const created = (await this.api('POST', '/v1/convai/agents/create', {
      name: `patch-voice-${this.init.sessionId}`,
      conversation_config: mergeConfig(
        {
          agent: {
            // Empty: the agent waits for the user to speak first. An agent's call opens
            // with its reason as the call's first push (VoiceAgentCall), as on every provider.
            first_message: '',
            language: 'en',
            prompt: {
              prompt,
              llm: this.deps.llm,
              tool_ids: this.toolIds,
            },
          },
          conversation: {
            max_duration_seconds: ELEVENLABS_MAX_CALL_SECONDS,
            client_events: [...CLIENT_EVENTS],
          },
          asr: { user_input_audio_format: INPUT_FORMAT },
          tts: {
            agent_output_audio_format: OUTPUT_FORMAT,
            ...(this.deps.voice ? { voice_id: this.deps.voice } : {}),
          },
        },
        this.deps.soundConfig ?? {},
      ),
    })) as { agent_id?: string };
    if (!created.agent_id) throw new Error('ElevenLabs created an agent but returned no agent_id');
    this.agentId = created.agent_id;
    const signed = (await this.api(
      'GET',
      `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(created.agent_id)}`,
    )) as { signed_url?: string };
    if (!signed.signed_url) throw new Error('ElevenLabs returned no signed_url');
    return signed.signed_url;
  }

  /** Delete the throwaway agent and its tools. Idempotent; a failure is logged loudly, never hidden. */
  private async cleanup(): Promise<void> {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    const targets = [
      ...(this.agentId ? [`/v1/convai/agents/${this.agentId}`] : []),
      // A deleted agent's stored versions still reference its tools, so a plain
      // DELETE is refused (409 "still in use by: Unknown / Main"); only force works.
      ...this.toolIds.map((id) => `/v1/convai/tools/${id}?force=true`),
    ];
    for (const path of targets) {
      try {
        await this.api('DELETE', path);
      } catch (err) {
        this.deps.logger.error(
          { sessionId: this.init.sessionId, path, err: (err as Error).message },
          'elevenlabs-agent: could not delete the throwaway agent — remove it in the ElevenLabs dashboard',
        );
      }
    }
  }

  // --- session lifecycle -----------------------------------------------------

  onSessionStart(): void {
    if (this.state !== 'connecting') return;
    const limit = this.deps.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
    this.setupTimer = setTimeout(() => {
      this.die(
        `ElevenLabs agent did not start within ${Math.round(limit / 1000)}s (stalled ${this.setupStage})`,
      );
    }, limit);
    void this.connect()
      .catch((err: Error) => {
        this.die(`ElevenLabs Agents session failed to open: ${err.message}`);
      })
      .finally(() => clearTimeout(this.setupTimer));
  }

  private async connect(): Promise<void> {
    // spec/07 § Keeping voice and text as one conversation — the chat as it stands goes at the
    // end of the agent's prompt. A chat that cannot be read fails the session.
    this.startContext = this.call.startContext();
    this.setupStage = 'creating the agent';
    const url = await this.provision();
    if (this.closed) return;
    this.setupStage = 'opening the conversation socket';
    const Ctor = this.deps.wsCtor ?? (WsImpl as unknown as ElevenLabsWsCtor);
    const ws = new Ctor(url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err: Error) => reject(err));
    });
    this.openedAt = Date.now();
    ws.on('message', (data: Buffer | string) => this.onWsMessage(data));
    ws.on('close', (code: number, reason: Buffer | string) => this.onWsClose(code, reason));
    ws.on('error', (err: Error) => {
      this.deps.logger.warn(
        { sessionId: this.init.sessionId, err: err.message },
        'elevenlabs-agent: ws error',
      );
    });
    const configured = new Promise<void>((resolve, reject) => {
      this.setupWaiter = { resolve, reject };
    });
    this.setupStage = 'waiting for the agent to initiate';
    this.sendJson({ type: 'conversation_initiation_client_data' });
    await configured;
    if (this.closed) return;
    this.setupDone = true;
    this.setState('listening');
    const queued = this.micQueue;
    this.micQueue = [];
    for (const b of queued) this.sendMic(b);
    this.call.attach({
      // `contextual_update` informs the agent without prompting a reply.
      addContext: (text) => this.sendJson({ type: 'contextual_update', text }),
      // `user_message` is a turn the agent answers.
      speakAbout: (text) => this.sendJson({ type: 'user_message', text }),
      isIdle: () => this.setupDone && !this.audioOpen && this.state === 'listening',
      playbackLeftMs: () => Math.max(this.reply?.leftMs() ?? 0, this.lastReply?.leftMs() ?? 0),
    });
  }

  private sendJson(msg: unknown): void {
    if (!this.ws || this.closed) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.reportError(`send to ElevenLabs Agents failed: ${(err as Error).message}`);
    }
  }

  private sendMic(b: Buffer): void {
    this.sendJson({ user_audio_chunk: b.toString('base64') });
  }

  async onMicFrame(pcm: Int16Array): Promise<void> {
    if (this.closed || this.fatal) return;
    this.micFrames += 1;
    this.micSamples += pcm.length;
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
    // Copy now — `pcm` may be a view onto a pooled buffer.
    const b = Buffer.from(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
    if (!this.setupDone) {
      this.micQueue.push(b);
      return;
    }
    this.sendMic(b);
  }

  // --- provider events -------------------------------------------------------

  private onWsMessage(data: Buffer | string): void {
    let ev: AgentEvent;
    try {
      ev = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')) as AgentEvent;
    } catch (err) {
      this.reportError(`unparseable frame from ElevenLabs Agents: ${(err as Error).message}`);
      return;
    }
    switch (ev.type) {
      case 'conversation_initiation_metadata': {
        const m = ev.conversation_initiation_metadata_event ?? {};
        if (m.conversation_id) this.conversationId = m.conversation_id;
        const w = this.setupWaiter;
        this.setupWaiter = undefined;
        if (
          m.agent_output_audio_format !== OUTPUT_FORMAT ||
          m.user_input_audio_format !== INPUT_FORMAT
        ) {
          w?.reject(
            new Error(
              `ElevenLabs conversation audio is ${m.user_input_audio_format ?? '?'} in / ` +
                `${m.agent_output_audio_format ?? '?'} out, expected ${INPUT_FORMAT} / ${OUTPUT_FORMAT}`,
            ),
          );
          return;
        }
        w?.resolve();
        return;
      }
      case 'ping':
        this.sendJson({ type: 'pong', event_id: ev.ping_event?.event_id });
        return;
      case 'user_transcript':
        this.onTranscript((ev.user_transcription_event?.user_transcript ?? '').trim());
        return;
      case 'agent_response':
        this.onAgentResponse(ev.agent_response_event?.agent_response ?? '');
        return;
      case 'audio':
        this.onAudio(ev.audio_event ?? {});
        return;
      case 'agent_response_complete':
        this.endAudio(false);
        return;
      case 'interruption':
        this.onInterruption();
        return;
      case 'agent_response_correction':
        // ElevenLabs' own record of the interrupted reply, cut on its side.
        this.deps.logger.info(
          {
            sessionId: this.init.sessionId,
            corrected: ev.agent_response_correction_event?.corrected_agent_response,
          },
          'elevenlabs-agent: the provider cut its record of the interrupted reply',
        );
        return;
      case 'client_tool_call': {
        const call = ev.client_tool_call ?? {};
        if (!call.tool_call_id) return;
        if (this.deps.manager && call.tool_name && MANAGER_QUICK_TOOL_NAMES.has(call.tool_name)) {
          void this.handleManagerTool(
            this.deps.manager,
            call.tool_call_id,
            call.tool_name,
            call.parameters,
          );
        } else if (call.tool_name !== undefined && this.call.handles(call.tool_name)) {
          void this.handleVoiceTool(call.tool_call_id, call.tool_name, call.parameters);
        } else {
          this.toolResult(call.tool_call_id, `Unknown tool ${call.tool_name ?? ''}`, true);
          this.reportError(`ElevenLabs agent called an unknown tool: ${call.tool_name ?? '?'}`);
        }
        return;
      }
      case 'error': {
        const detail =
          typeof ev.error === 'string' ? ev.error : (ev.error?.message ?? ev.message ?? 'unknown');
        const message = `ElevenLabs Agents error: ${detail}`;
        if (this.setupWaiter) {
          const w = this.setupWaiter;
          this.setupWaiter = undefined;
          w.reject(new Error(message));
          return;
        }
        this.reportError(message);
        return;
      }
      default:
        return;
    }
  }

  private onTranscript(text: string): void {
    // A new turn begins: whatever the last one suppressed is over.
    this.suppressReply = false;
    this.endAudio(false);
    if (isNoiseTranscript(text)) {
      // ElevenLabs transcribes noise as "..." — not a turn, not a bubble, and the voice's
      // answer to it is dropped (as in gemini-live.ts).
      this.suppressReply = true;
      this.call.flush();
      return;
    }
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
    if (!addressed) {
      // Heard, not for us: never a turn, and the agent's answer to it is dropped.
      this.suppressReply = true;
      this.call.flush();
      return;
    }
    this.turns += 1;
    this.deps.timeline.userSaid(this.call.chatId, text);
    // spec/07 § Permission prompts during voice — a spoken yes / no answers a waiting permission.
    this.deps.link.answerPermission(this.call.chatId, text);
    this.setState('thinking');
  }

  private onAgentResponse(raw: string): void {
    const text = raw.replace(AUDIO_TAG, '').trim();
    if (this.suppressReply || isNoiseTranscript(text)) return;
    // What the voice said is written into the chat, apart from the agent's own messages,
    // once the user has heard it.
    const reply = this.spokenReply();
    reply.append(reply.hasText() ? ` ${text}` : text);
  }

  /** The reply being spoken now, begun on its first words or audio. */
  private spokenReply(): SpokenReply {
    this.reply ??= new SpokenReply(() => this.deps.timeline.beginReply(this.call.chatId));
    return this.reply;
  }

  private onAudio(a: NonNullable<AgentEvent['audio_event']>): void {
    if (this.suppressReply) return;
    if (a.audio_base_64) {
      const buf = Buffer.from(a.audio_base_64, 'base64');
      const pcm = new Int16Array(buf.byteLength >>> 1);
      new Uint8Array(pcm.buffer).set(buf.subarray(0, pcm.byteLength));
      if (pcm.length > 0) {
        this.spokenReply().audio(pcm.length);
        this.audioOpen = true;
        if (this.state !== 'speaking') this.setState('speaking');
        this.deps.sendAudio({
          type: 'audio.tts_chunk',
          sessionId: this.init.sessionId,
          samples: pcm.length,
        });
        this.deps.sendBinary(pcm);
      }
    }
  }

  /**
   * The reply is over for ElevenLabs (or, `bargedIn`, cut off): close the
   * surface's playback of it, and hand it to the chat — whole once it has
   * played out, or as far as the user heard.
   */
  private endAudio(bargedIn: boolean): void {
    if (bargedIn) {
      const target = this.reply ?? this.lastReply;
      this.lastReply = undefined;
      const heardMs = target?.cut() ?? null;
      if (heardMs !== null) {
        this.deps.logger.info(
          {
            sessionId: this.init.sessionId,
            heardMs: Math.round(heardMs),
            audioMs: Math.round(target!.audioMs()),
          },
          'elevenlabs-agent: reply cut off',
        );
      }
    } else if (this.reply) {
      this.reply.end();
      this.lastReply = this.reply;
    }
    this.reply = undefined;
    if (!this.audioOpen) return;
    this.audioOpen = false;
    this.deps.sendAudio({
      type: 'audio.tts_end',
      sessionId: this.init.sessionId,
      ...(bargedIn ? { bargedIn: true } : {}),
    });
    this.setState('listening');
    this.call.flush();
  }

  private onInterruption(): void {
    // Barge-in: the agent has stopped; stop what the surface is still playing.
    this.suppressReply = false;
    if (this.state === 'speaking' || this.lastReply?.playing() === true) {
      this.deps.sendAudio({
        type: 'audio.barge_in',
        sessionId: this.init.sessionId,
        at: Date.now(),
      });
    }
    this.endAudio(true);
    if (this.state === 'speaking') this.setState('listening');
  }

  // --- tools -------------------------------------------------------------------

  private toolResult(callId: string, result: string, isError: boolean): void {
    this.sendJson({
      type: 'client_tool_result',
      tool_call_id: callId,
      result,
      is_error: isError,
    });
  }

  private argOf(params: unknown, key: string): string {
    if (typeof params === 'object' && params !== null) {
      const v = (params as Record<string, unknown>)[key];
      if (typeof v === 'string') return v;
    }
    return typeof params === 'string' ? params : '';
  }

  /** The voice agent's own tools (voiceAgent.ts), answered through the shared call. */
  private async handleVoiceTool(callId: string, name: string, params: unknown): Promise<void> {
    const args =
      typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
    const result = await this.call.runTool(name, args);
    if (this.closed || this.fatal) return;
    this.toolResult(callId, result, false);
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
    params: unknown,
  ): Promise<void> {
    this.deps.logger.info(
      { sessionId: this.init.sessionId, tool: name, params },
      'elevenlabs-agent: manager tool',
    );
    let result: string;
    let isError = false;
    try {
      result = await manager.quick(name, stringArgs(params), this.quickContext());
    } catch (err) {
      result = (err as Error).message;
      if (!(err instanceof ChatLookupError)) {
        isError = true;
        this.reportError(`${name} failed: ${result}`);
      }
    }
    if (this.closed || this.fatal) return;
    this.toolResult(callId, result, isError);
  }

  // --- other VoiceSessionLike surface ------------------------------------------

  pushMessage(text: string, opts: { handoffSettled?: boolean } = {}): void {
    this.call.push(text, opts);
  }

  /** Not a note engine — this class only backs `role: 'voice-call'` (audio/server.ts). */
  async finalizeNote(): Promise<boolean> {
    return false;
  }

  async injectTranscript(text: string): Promise<void> {
    if (this.closed || !this.setupDone) return;
    this.sendJson({ type: 'user_message', text });
  }

  /** ElevenLabs Agents have no say-this-verbatim message; refuse loudly rather than paraphrase. */
  async speak(): Promise<void> {
    this.reportError('speak() is not supported on the ElevenLabs Agents backend');
  }

  private onWsClose(code: number, reason: Buffer | string): void {
    if (this.closed) return;
    const why = typeof reason === 'string' ? reason : reason?.toString('utf8');
    const hitLimit = code === 1000 && /max call duration/i.test(why ?? '');
    const message = hitLimit
      ? 'The call reached its time limit. Retry to continue.'
      : `ElevenLabs Agents closed the session (code ${code}${why ? `: ${why}` : ''})`;
    if (this.setupWaiter) {
      const w = this.setupWaiter;
      this.setupWaiter = undefined;
      w.reject(new Error(message));
      return;
    }
    this.die(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.reply?.flush();
    this.lastReply?.flush();
    this.call.close();
    this.closed = true;
    this.closedAt = Date.now();
    const w = this.setupWaiter;
    this.setupWaiter = undefined;
    w?.reject(new Error('session closed'));
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    await this.cleanup();
  }
}
