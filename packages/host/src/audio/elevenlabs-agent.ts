// Hosted voice tier: ElevenLabs Agents (spec/07 § Voice — a config matrix,
// `backend: elevenlabs`). The third hosted tier beside gemini-live.ts and
// openai-realtime.ts, built the same way: the HOST relays the surface's mic PCM
// to one ElevenLabs Agents conversation over a server-side WebSocket and
// streams the agent's audio back down the surface's existing audio WSS. No
// surface talks to ElevenLabs or holds a key.
//
// The agent IS the light layer and hands real work to the chat through the one
// `dispatch_to_patch` tool (and `look_back`), registered as CLIENT tools and
// answered here by the host with `client_tool_result` — the same
// `submitUserTurn` callback the other tiers use, so a dispatched turn lands in
// the real chat.
//
// An ElevenLabs agent is a stored object (prompt, LLM, tools, voice), not
// something a WebSocket configures on the fly, and its tools cannot be
// overridden per conversation. So each session PROVISIONS a throwaway agent
// from this host's current settings — front LLM from the layer, instructions
// with the chat briefing in them, the two client tools — opens a conversation
// on a signed URL, and DELETES the agent and tools when the session ends. No
// agent ids are kept on disk; nothing drifts from the code. A failed delete is
// logged as an error, never swallowed.
//
// `layer` picks the front LLM: `light` → Claude Haiku, `heavy` → Claude Sonnet
// (`DEFAULT_ELEVENLABS_AGENT_LLMS`, overridable per host). `direct` has no
// hosted meaning and runs as `light`.
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
// NO SILENT FALLBACK. Provisioning failure, a failed connect, a provider error
// or close, a format mismatch: reported as `audio.error {code:
// 'elevenlabs_unavailable'}`; a closed or never-opened conversation is fatal
// and ends the surface session (`onFatal`).

import type { Logger } from 'pino';
import { WebSocket as WsImpl, type WebSocket as WsSocket } from 'ws';
import type { AudioEvent, AudioSessionMode, VoiceHandoff, VoiceLayer } from '@patch/wire/audio';
import { modeRequiresAddress } from '@patch/wire/audio';
import type { VoiceReplyWriter, VoiceTimeline, VoiceSessionLike } from './voice-session-like.js';
import { MicLevelWatch, micSilentMessage } from './micLevel.js';
import { ZERO_TOKENS, type EngineCosting } from './voiceCost.js';
import {
  DEFAULT_ADDRESS_WORD,
  isAddressed,
  type SessionInit,
  type SessionDeps,
  type SessionState,
  type VoiceTurnSource,
} from './session.js';
import {
  chatBriefing,
  liveNote,
  withBriefing,
  LOOK_BACK_DESCRIPTION,
  LOOK_BACK_RULE,
  LOOK_BACK_TOOL_NAME,
} from './chatBriefing.js';
import {
  DISPATCH_TOOL_DESCRIPTION,
  DISPATCH_TOOL_NAME,
  hostedVoiceInstruction,
  type GeminiContextTurn,
} from './gemini-live.js';

/**
 * Front LLMs per layer. Ids are ElevenLabs' (elevenlabs.io/docs/eleven-agents,
 * checked 2026-10-29). Override per host for any other model they list.
 */
export const DEFAULT_ELEVENLABS_AGENT_LLMS = {
  light: 'claude-haiku-4-5',
  heavy: 'claude-sonnet-4-5',
} as const;

export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';
const INPUT_FORMAT = 'pcm_16000';
const OUTPUT_FORMAT = 'pcm_24000';

/** The LLM a hosted layer runs. `direct` has no hosted meaning and runs as `light`. */
export function elevenLabsAgentLlmFor(
  layer: VoiceLayer,
  overrides: { light?: string | undefined; heavy?: string | undefined } = {},
): string {
  if (layer === 'heavy') return overrides.heavy ?? DEFAULT_ELEVENLABS_AGENT_LLMS.heavy;
  return overrides.light ?? DEFAULT_ELEVENLABS_AGENT_LLMS.light;
}

export type ElevenLabsWsCtor = new (url: string) => WsSocket;
export type ElevenLabsFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ElevenLabsAgentDeps {
  logger: Logger;
  sendAudio: (ev: AudioEvent) => void;
  sendBinary: (pcm: Int16Array) => void;
  submitUserTurn: SessionDeps['submitUserTurn'];
  /** Where this session's spoken exchanges are written into the chat. */
  timeline: VoiceTimeline;
  /** ELEVEN_LABS_API_KEY. The caller refuses to construct this class without one. */
  apiKey: string;
  /** The agent's front LLM — resolved from the layer by the caller (`elevenLabsAgentLlmFor`). */
  llm: string;
  /** Who does the work (spec/07 § The fast voice and the chat's agent). Defaults to `auto`. */
  handoff?: VoiceHandoff;
  /** The `look_back` tool's search over this chat. Absent means the voice is not given the tool. */
  lookBack?: (chatId: string, query: string) => string;
  /** An ElevenLabs voice id; absent uses the platform default voice. */
  voiceId?: string;
  getChatContext?: (chatId: string) => Promise<GeminiContextTurn[]> | GeminiContextTurn[];
  /** The conversation is gone for good; the audio server ends the surface session. */
  onFatal?: (message: string) => void;
  /** Test seams. */
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
  audio_event?: { audio_base_64?: string; event_id?: number; is_final?: boolean };
  interruption_event?: { event_id?: number };
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
  private currentChatId: string;
  private mode: AudioSessionMode;
  private ws?: WsSocket;
  private setupDone = false;
  private closed = false;
  private fatal = false;
  private micQueue: Buffer[] = [];
  private setupWaiter?: { resolve: () => void; reject: (err: Error) => void };
  private lastSpokeAt?: number;
  private agentId?: string;
  private toolIds: string[] = [];
  private cleanedUp = false;
  private openedAt?: number;
  private closedAt?: number;
  /** Hands-free: the agent's reply to a heard-but-not-addressed transcript is dropped. */
  private suppressReply = false;
  private audioOpen = false;
  private dispatchesInFlight = 0;
  private briefing = '';
  private micFrames = 0;
  private micSamples = 0;
  private turns = 0;
  private readonly micLevel = new MicLevelWatch();

  constructor(init: SessionInit, deps: ElevenLabsAgentDeps) {
    this.init = init;
    this.deps = deps;
    this.currentChatId = init.chatId;
    this.mode = init.mode ?? 'call';
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
    return this.currentChatId;
  }

  setFocus(chatId: string): void {
    this.currentChatId = chatId;
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
    };
  }

  isAwaitingHandoff(): boolean {
    return this.dispatchesInFlight > 0;
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

  private clientTool(name: string, description: string, param: string, paramDescription: string) {
    return {
      tool_config: {
        type: 'client',
        name,
        description,
        parameters: {
          type: 'object',
          properties: { [param]: { type: 'string', description: paramDescription } },
          required: [param],
        },
        // The agent waits for the host's answer — a dispatch can take minutes.
        expects_response: true,
        response_timeout_secs: -1,
      },
    };
  }

  private async provision(): Promise<string> {
    const handoff = this.deps.handoff ?? 'auto';
    const tools: Array<ReturnType<ElevenLabsAgentSession['clientTool']>> = [];
    if (handoff !== 'never') {
      tools.push(
        this.clientTool(
          DISPATCH_TOOL_NAME,
          DISPATCH_TOOL_DESCRIPTION,
          'request',
          'What Patch should do or look up, in plain language.',
        ),
      );
    }
    if (this.deps.lookBack !== undefined) {
      tools.push(
        this.clientTool(
          LOOK_BACK_TOOL_NAME,
          LOOK_BACK_DESCRIPTION,
          'query',
          'A few key words to search the chat for.',
        ),
      );
    }
    for (const t of tools) {
      const made = (await this.api('POST', '/v1/convai/tools', t)) as { id?: string };
      if (!made.id) throw new Error('ElevenLabs created a tool but returned no id');
      this.toolIds.push(made.id);
    }
    const created = (await this.api('POST', '/v1/convai/agents/create', {
      name: `patch-voice-${this.init.sessionId}`,
      conversation_config: {
        agent: {
          // Empty: the agent waits for the user to speak first.
          first_message: '',
          language: 'en',
          prompt: {
            prompt: withBriefing(
              hostedVoiceInstruction(handoff) +
                (this.deps.lookBack !== undefined ? `\n\n${LOOK_BACK_RULE}` : ''),
              this.briefing,
            ),
            llm: this.deps.llm,
            tool_ids: this.toolIds,
          },
        },
        asr: { user_input_audio_format: INPUT_FORMAT },
        tts: {
          agent_output_audio_format: OUTPUT_FORMAT,
          ...(this.deps.voiceId ? { voice_id: this.deps.voiceId } : {}),
        },
      },
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
      ...this.toolIds.map((id) => `/v1/convai/tools/${id}`),
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
    void this.connect().catch((err: Error) => {
      this.die(`ElevenLabs Agents session failed to open: ${err.message}`);
    });
  }

  private async connect(): Promise<void> {
    // spec/07 § Keeping voice and text as one conversation — the chat's briefing goes
    // in the agent's prompt. A chat whose history cannot be read fails the session.
    const context = (await this.deps.getChatContext?.(this.currentChatId)) ?? [];
    this.briefing = chatBriefing(context);
    this.deps.logger.info(
      {
        sessionId: this.init.sessionId,
        messages: context.length,
        chars: this.briefing.length,
        briefing: this.briefing,
      },
      'elevenlabs-agent: chat briefing',
    );
    const url = await this.provision();
    if (this.closed) return;
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
    this.sendJson({ type: 'conversation_initiation_client_data' });
    await configured;
    if (this.closed) return;
    this.setupDone = true;
    this.setState('listening');
    const queued = this.micQueue;
    this.micQueue = [];
    for (const b of queued) this.sendMic(b);
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
      case 'interruption':
        this.onInterruption();
        return;
      case 'client_tool_call': {
        const call = ev.client_tool_call ?? {};
        if (!call.tool_call_id) return;
        if (call.tool_name === DISPATCH_TOOL_NAME) {
          void this.handleDispatch(call.tool_call_id, call.parameters);
        } else if (call.tool_name === LOOK_BACK_TOOL_NAME && this.deps.lookBack) {
          this.handleLookBack(call.tool_call_id, call.parameters);
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
    if (text.length === 0) return;
    if (!addressed) {
      // Heard, not for us: never a turn, and the agent's answer to it is dropped.
      this.suppressReply = true;
      return;
    }
    this.turns += 1;
    this.deps.timeline.userSaid(this.currentChatId, text);
    this.setState('thinking');
  }

  private onAgentResponse(text: string): void {
    if (this.suppressReply || text.trim() === '') return;
    // What the voice said is written too, apart from the agent's own message in the chat.
    const reply: VoiceReplyWriter = this.deps.timeline.beginReply(this.currentChatId);
    reply.append(text);
    reply.finish();
  }

  private onAudio(a: NonNullable<AgentEvent['audio_event']>): void {
    if (this.suppressReply) return;
    if (a.audio_base_64) {
      const buf = Buffer.from(a.audio_base_64, 'base64');
      const pcm = new Int16Array(buf.byteLength >>> 1);
      new Uint8Array(pcm.buffer).set(buf.subarray(0, pcm.byteLength));
      if (pcm.length > 0) {
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
    if (a.is_final === true) this.endAudio(false);
  }

  /** Close the surface's playback of the current reply, if one is open. */
  private endAudio(bargedIn: boolean): void {
    if (!this.audioOpen) return;
    this.audioOpen = false;
    this.deps.sendAudio({
      type: 'audio.tts_end',
      sessionId: this.init.sessionId,
      ...(bargedIn ? { bargedIn: true } : {}),
    });
    this.setState(this.dispatchesInFlight > 0 ? 'thinking' : 'listening');
  }

  private onInterruption(): void {
    // Barge-in: the agent has stopped; stop what the surface is still playing.
    this.suppressReply = false;
    if (this.state === 'speaking') {
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

  /** The `look_back` tool: search the chat on the host and answer at once; no model, no wait. */
  private handleLookBack(callId: string, params: unknown): void {
    const query = this.argOf(params, 'query');
    let result: string;
    let isError = false;
    try {
      result = this.deps.lookBack!(this.currentChatId, query);
    } catch (err) {
      result = `Looking back failed: ${(err as Error).message}`;
      isError = true;
      this.deps.logger.error(
        { sessionId: this.init.sessionId, err: (err as Error).message, query },
        'elevenlabs-agent: look_back failed',
      );
    }
    this.deps.logger.info(
      { sessionId: this.init.sessionId, query, chars: result.length, result },
      'elevenlabs-agent: look_back',
    );
    this.toolResult(callId, result, isError);
  }

  private async handleDispatch(callId: string, params: unknown): Promise<void> {
    const request = this.argOf(params, 'request');
    this.dispatchesInFlight += 1;
    this.deps.logger.info(
      { sessionId: this.init.sessionId, chatId: this.currentChatId, request },
      'elevenlabs-agent: dispatching to the heavy agent',
    );
    const source: VoiceTurnSource = {
      kind: 'voice-app',
      surfaceKind: this.init.surfaceKind as 'web' | 'desktop' | 'mobile',
      sessionId: this.init.sessionId,
    };
    let result: string;
    let isError = false;
    try {
      result = await this.deps.submitUserTurn({
        chatId: this.currentChatId,
        message: request,
        source,
        handoff: true,
      });
    } catch (err) {
      result = `That failed: ${(err as Error).message}`;
      isError = true;
      this.deps.logger.error(
        { sessionId: this.init.sessionId, err: (err as Error).message },
        'elevenlabs-agent: dispatch failed',
      );
    } finally {
      this.dispatchesInFlight -= 1;
    }
    if (this.closed || this.fatal) return;
    // The agent speaks the answer once it has this.
    this.toolResult(callId, result, isError);
  }

  // --- other VoiceSessionLike surface ------------------------------------------

  pushContext(role: 'user' | 'assistant', text: string): void {
    if (this.closed || !this.setupDone) return;
    // `contextual_update` informs the agent without prompting a reply.
    this.sendJson({ type: 'contextual_update', text: liveNote(role, text) });
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
    const message = `ElevenLabs Agents closed the session (code ${code}${why ? `: ${why}` : ''})`;
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
