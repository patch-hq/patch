// One voice agent call's link to its chat, shared by every provider (spec/07 §
// The voice agent and the chat's agent, § Keeping voice and text as one
// conversation, § A call stays on its chat).
//
// A provider session (gemini-live.ts, openai-realtime.ts, elevenlabs-agent.ts)
// owns its socket and its audio; this owns everything about the chat:
//
//   - which chat the call is on, and the start context its instructions end
//     with, including the catch-up, which is added to the conversation when
//     the small job writing it finishes (the call never waits for it);
//   - the voice agent's tools that the host answers (pass to agent, check
//     status, look back, switch chat);
//   - the pushes: what the host has for the voice agent to speak about (a
//     hand-off's answer, a chat reply that ends a turn, a chat's reply on a
//     Manager call), held until nobody is talking and sent in the order they
//     arrived.
//
// A provider gives it a {@link VoiceAgentEngine}: how to add text to the
// conversation silently, how to add it and have the voice agent speak, and
// whether the line is quiet. Everything else is the same on every provider.

import type { Logger } from 'pino';
import type { AudioEvent } from '@patch/wire/audio';
import type { VoiceTurnSource } from './session.js';
import {
  callOpening,
  catchUpMessage,
  CHECK_STATUS_TOOL_NAME,
  HANDOFF_RECEIVED,
  LOOK_BACK_TOOL_NAME,
  PASS_TO_AGENT_TOOL_NAME,
  SWITCH_CHAT_TOOL_NAME,
  END_CALL_TOOL_NAME,
  switchedMessage,
  type StartContext,
  type VoiceAgentLink,
} from './voiceAgent.js';

/** What a provider session does for its call. */
export interface VoiceAgentEngine {
  /** Add `text` to the voice agent's conversation without asking it to speak. */
  addContext(text: string): void;
  /** Add `text` and have the voice agent speak about it. Only called when {@link isIdle}. */
  speakAbout(text: string): void;
  /** The session is open, nobody is talking, and the voice agent is not mid-reply. */
  isIdle(): boolean;
  /** How long the surface has still to play of what the voice agent has said. */
  playbackLeftMs(): number;
}

export interface VoiceAgentCallOptions {
  link: VoiceAgentLink;
  sessionId: string;
  chatId: string;
  /** Where a hand-off came from, for its tag in the chat. */
  source: VoiceTurnSource;
  logger: Logger;
  sendAudio: (ev: AudioEvent) => void;
  /** The call answers an agent's ring: why it rang (spec/07 § Agent-initiated voice). */
  callReason?: string;
}

/**
 * The longest a goodbye is waited for before the call is ended anyway: far
 * longer than any spoken goodbye, short enough that a call asked to end does.
 */
export const GOODBYE_MAX_MS = 15_000;

/** A pushed message waiting for a quiet moment. */
interface Push {
  text: string;
  handoffSettled: boolean;
  queuedAt: number;
}

export class VoiceAgentCall {
  private readonly opts: VoiceAgentCallOptions;
  private chat: string;
  private engine?: VoiceAgentEngine;
  /** The session is set up: context and pushes can be sent. */
  private live = false;
  private closed = false;
  /** Waiting for the line to go quiet after the voice's goodbye (`untilGoodbyeHeard`). */
  private goodbyeWaiter: (() => void) | null = null;
  /** Catch-ups that arrived before the session was set up. */
  private pendingContext: string[] = [];
  private readonly pushes: Push[] = [];
  /** Hand-offs passed on whose answer has not been pushed yet. */
  private open = 0;

  constructor(opts: VoiceAgentCallOptions) {
    this.opts = opts;
    this.chat = opts.chatId;
  }

  /** The chat the call is on now. */
  get chatId(): string {
    return this.chat;
  }

  /** The call moved (switch chat, or the host retargeting it). */
  setChat(chatId: string): void {
    this.chat = chatId;
  }

  /** Hand-offs passed on and not answered yet. */
  openHandoffs(): number {
    return this.open;
  }

  /** A hand-off went out whose answer will be pushed (pass to agent, or a Manager call's send). */
  handoffOpened(): void {
    this.open += 1;
  }

  /** A hand-off ended with nothing to push (never taken, or its answer stays in another chat). */
  handoffClosed(): void {
    this.open = Math.max(0, this.open - 1);
  }

  /** Pushes not yet sent. */
  pendingPushes(): number {
    return this.pushes.length;
  }

  /**
   * The start context for the instructions, read now; its catch-up is added
   * to the conversation when it is written. Throws when the chat cannot be
   * read: the session fails loudly rather than opening on nothing.
   */
  startContext(): string {
    const context = this.opts.link.startContext(this.chat);
    this.log('start context', { chars: context.text.length, catchUp: context.catchUp !== null });
    this.followCatchUp(context, this.chat);
    // An agent's call: the reason it rang ends the start context, and is what the voice opens with.
    if (this.opts.callReason === undefined) return context.text;
    return `${context.text}\nThe chat's agent called the user: ${this.opts.callReason.trim()}`;
  }

  /** The provider session is set up: from here context and pushes can be sent. */
  attach(engine: VoiceAgentEngine): void {
    this.engine = engine;
    this.live = true;
    const pending = this.pendingContext;
    this.pendingContext = [];
    for (const text of pending) engine.addContext(text);
    if (this.opts.callReason !== undefined)
      this.pushes.unshift({
        text: callOpening(this.opts.callReason),
        handoffSettled: false,
        queuedAt: Date.now(),
      });
    this.flush();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pushes.length > 0 || this.open > 0) {
      this.opts.logger.warn(
        { sessionId: this.opts.sessionId, pushes: this.pushes.length, openHandoffs: this.open },
        'voice: call closing with answers not yet spoken; they are in the chat',
      );
    }
  }

  /**
   * Something for the voice agent to speak about. Held until the line is
   * quiet; sent in the order pushes arrived.
   */
  push(text: string, opts: { handoffSettled?: boolean } = {}): void {
    if (this.closed) return;
    this.pushes.push({ text, handoffSettled: opts.handoffSettled === true, queuedAt: Date.now() });
    this.flush();
  }

  /** Send the oldest push if the line is quiet. Providers call this whenever it may have gone quiet. */
  flush(): void {
    if (this.closed || !this.live || !this.engine) return;
    if (this.goodbyeWaiter && this.engine.isIdle()) {
      const w = this.goodbyeWaiter;
      this.goodbyeWaiter = null;
      w();
      return;
    }
    const next = this.pushes[0];
    if (!next || !this.engine.isIdle()) return;
    this.pushes.shift();
    if (next.handoffSettled) this.open = Math.max(0, this.open - 1);
    this.log('push spoken', { waitedMs: Date.now() - next.queuedAt, chars: next.text.length });
    this.engine.speakAbout(next.text);
  }

  /** True for the tools this class answers; anything else is the provider's own (Manager tools). */
  handles(name: string): boolean {
    return (
      name === PASS_TO_AGENT_TOOL_NAME ||
      name === CHECK_STATUS_TOOL_NAME ||
      name === LOOK_BACK_TOOL_NAME ||
      name === SWITCH_CHAT_TOOL_NAME ||
      name === END_CALL_TOOL_NAME
    );
  }

  /**
   * Run one of the voice agent's tools and resolve with what it answers. A
   * tool that fails answers with the failure, which is also shown on the call
   * bar; nothing is answered as if it had worked.
   */
  async runTool(name: string, args: Record<string, unknown>): Promise<string> {
    const arg = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '');
    const { link, sessionId } = this.opts;
    this.log('tool', { tool: name, args });
    try {
      switch (name) {
        case PASS_TO_AGENT_TOOL_NAME: {
          link.passToAgent({
            sessionId,
            chatId: this.chat,
            request: arg('request'),
            source: this.opts.source,
          });
          this.handoffOpened();
          // The device plays the passed to agent sound (spec/07 § Call sounds).
          this.opts.sendAudio({ type: 'audio.passed_to_agent', sessionId });
          return HANDOFF_RECEIVED;
        }
        case CHECK_STATUS_TOOL_NAME:
          return link.checkStatus(sessionId, this.chat);
        case LOOK_BACK_TOOL_NAME:
          return link.lookBack(this.chat, arg('query'));
        case SWITCH_CHAT_TOOL_NAME: {
          const outcome = await link.switchChat(sessionId, this.chat, arg('chat'));
          if (!outcome.ok) return outcome.message;
          this.chat = outcome.chatId;
          this.followCatchUp(outcome.context, outcome.chatId, outcome.name);
          return switchedMessage(outcome.name, outcome.context.text);
        }
        case END_CALL_TOOL_NAME:
          await this.untilGoodbyeHeard();
          link.endCall(sessionId);
          return 'The call has ended.';
        default:
          throw new Error(`there is no tool called ${name} on this call`);
      }
    } catch (err) {
      const reason = (err as Error).message;
      this.opts.logger.error({ sessionId, tool: name, err: reason }, 'voice: a tool failed');
      this.opts.sendAudio({
        type: 'audio.error',
        code: 'voice_tool_failed',
        message: `${name} failed: ${reason}`,
        sessionId,
      });
      return name === PASS_TO_AGENT_TOOL_NAME
        ? `Not passed on: ${reason}. Tell the user it was not passed on.`
        : `That failed: ${reason}`;
    }
  }

  /**
   * The voice says goodbye, then hangs up: wait until its reply has ended (the
   * provider's own end of reply, which every engine reports by calling `flush`)
   * and the surface has played what was sent, which the audio's length says.
   * Bounded, so a provider that never goes quiet cannot hold open a call the
   * voice asked to end: past the bound it ends anyway, and says so.
   */
  private async untilGoodbyeHeard(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    const deadline = Date.now() + GOODBYE_MAX_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = (ms: number): Promise<'bound'> =>
      new Promise((r) => (timer = setTimeout(() => r('bound'), Math.max(0, ms))));
    const quiet = new Promise<'quiet'>((resolve) => {
      if (engine.isIdle()) resolve('quiet');
      else this.goodbyeWaiter = () => resolve('quiet');
    });
    let outcome = await Promise.race([quiet, bound(GOODBYE_MAX_MS)]);
    clearTimeout(timer);
    this.goodbyeWaiter = null;
    if (outcome === 'quiet') {
      const left = engine.playbackLeftMs();
      if (left > 0) {
        outcome = left > deadline - Date.now() ? 'bound' : 'quiet';
        await bound(Math.min(left, deadline - Date.now()));
      }
    }
    if (outcome === 'bound') {
      this.opts.logger.warn(
        { sessionId: this.opts.sessionId },
        'voice: the goodbye did not finish in time; ending the call anyway',
      );
    }
  }

  /** Add a start context's catch-up once it is written; show its failure on the call bar. */
  private followCatchUp(context: StartContext, chatId: string, name?: string): void {
    if (context.catchUp === null) return;
    const startedAt = Date.now();
    context.catchUp.then(
      (text) => {
        if (this.closed) return;
        this.log('catch-up written', { chatId, ms: Date.now() - startedAt, chars: text.length });
        const message = catchUpMessage(text, name ?? null);
        if (this.live && this.engine) this.engine.addContext(message);
        else this.pendingContext.push(message);
      },
      (err: Error) => {
        if (this.closed) return;
        this.opts.logger.error(
          { sessionId: this.opts.sessionId, chatId, err: err.message },
          'voice: the catch-up for the call could not be written',
        );
        this.opts.sendAudio({
          type: 'audio.error',
          code: 'catch_up_failed',
          message: `The catch-up on this chat could not be written, so the call has only its last messages: ${err.message}`,
          sessionId: this.opts.sessionId,
        });
      },
    );
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    this.opts.logger.info(
      { sessionId: this.opts.sessionId, chatId: this.chat, ...fields },
      `voice: ${event}`,
    );
  }
}
