// spec/07 § The voice agent and the chat's agent / § Keeping voice and text as
// one conversation / § A call stays on its chat / § Call cost — the glue
// between open voice sessions and the chats they are on:
//
//   - the timeline a voice agent writes its exchanges into,
//   - the voice agent's tools that need the host (VoiceAgentLink): pass to
//     agent, check status, look back, switch chat, and the start context,
//   - hand-offs tracked from the host's own events, and the chat agent's
//     answers pushed into the call when they land: the answer to a hand-off
//     to the call that made it, and any other reply that ends a turn to every
//     call on that chat. Progress messages mid-turn are not pushed, and
//     nothing else the chat's agent writes reaches a call,
//   - costing a call when it ends.

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { ChatActivity, ChatVoiceHandoffEvent, WireEvent } from '@patch/wire';
import { parseYesNo, type SessionInit, type VoiceTurnSource } from './session.js';
import type { VoiceSessionLike, VoiceTimeline } from './voice-session-like.js';
import {
  callSummaryLine,
  costCall,
  type CallCosting,
  type EngineCosting,
  type RealCharge,
} from './voiceCost.js';
import type { VoiceLedger } from './voiceLedger.js';
import {
  ageWords,
  ANSWER_LABEL,
  START_RECENT_MESSAGES,
  startContextText,
  type StartContext,
  type StartFacts,
  type StartMessage,
  type SwitchOutcome,
  type VoiceAgentLink,
} from './voiceAgent.js';
import { ChatLookupError, MANAGER_CHAT_ID, type ChatEntry, type ChatLookup } from './chatLookup.js';

/** How a spoken turn is tagged in the chat: its ingress, and whether the voice agent handed it off. */
export function voiceTag(source: VoiceTurnSource, handoff: boolean): string {
  return source.kind === 'voice-device'
    ? `[voice${handoff ? ' hand-off' : ''} • device:${source.deviceId}] `
    : `[voice${handoff ? ' hand-off' : ''} • ${source.surfaceKind}] `;
}

/** A spoken turn's localId: unique per turn, so its own message and turn can be recognised. */
export function voiceLocalId(source: VoiceTurnSource): string {
  // Every live audio session carries a sessionId; a device is named by its own id.
  const suffix =
    source.kind === 'voice-device'
      ? `device:${source.deviceId}`
      : (source.sessionId ?? source.surfaceKind);
  return `voice-${suffix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/** Where a hand-off stands, as recorded in the chat (spec/14 § Hand-off rows). */
export type VoiceHandoffRecord = Omit<ChatVoiceHandoffEvent, 'type' | 'seq' | 'branchId'>;

/** What the glue needs from the chat host. */
export interface ChatVoiceHost {
  recordVoiceMessage(req: {
    chatId: string;
    role: 'user' | 'assistant';
    content: string;
    seq?: number;
    /** False for a line the agent is about to be given itself (a hand-off). */
    owed?: boolean;
  }): number;
  /** Queue a turn for the chat's agent; rejects when it could not be given to the agent. */
  sendInput(req: {
    chatId: string;
    message: string;
    localId: string;
    voicePrefix: string;
    fromUser: true;
    deliverDrawn: number;
  }): Promise<void>;
  reserveVoiceSeq(chatId: string): number;
  emitVoiceDelta(chatId: string, messageSeq: number, delta: string): void;
  recordCallSummary(chatId: string, line: string): void;
  /** A quiet `[call]` line in the chat (a resumed call). */
  recordCallNote(chatId: string, line: string): void;
  /** Record where a hand-off stands (`chat.voice_handoff`): every surface draws it on its row. */
  recordVoiceHandoff(handoff: VoiceHandoffRecord): void;
  /** The chat as it stands, for a start context (`START_RECENT_MESSAGES` in full). Throws for an unknown chat. */
  voiceStartFacts(chatId: string, recent: number): StartFacts;
  /** The chat agent's last message, from the chat's own record. */
  lastAgentMessage(chatId: string): { text: string; at: number } | null;
  /** What the chat is doing now; null for a chat this host does not have. */
  chatActivity(chatId: string): ChatActivity | null;
  /** A call's `look_back`: the chat's messages that match a few words. */
  searchChat(chatId: string, query: string): string;
  /** The permission the chat is waiting on, if any. */
  getPendingPermissionForChat(chatId: string): string | undefined;
  submitPermissionResponse(r: { requestId: string; decision: 'approve' | 'deny' }): unknown;
}

export interface ChatVoice {
  makeTimeline(init: SessionInit): VoiceTimeline;
  /** The voice agent's tools that the host answers. */
  link: VoiceAgentLink;
  /** A hand-off's own turn has started on its chat (the chat's agent took it). */
  handoffStarted(info: { chatId: string; handoffId: string }): void;
  /** Feed every outbound wire event through here. */
  observe(event: WireEvent): void;
  callEnded(info: {
    init: SessionInit;
    chatId: string;
    startedAt: number;
    endedAt: number;
    engine: EngineCosting;
  }): void;
  /**
   * A direct call ended on its device (spec/07 § Call cost): kept on the
   * ledger, and its one line written into the chat, as every call's is.
   */
  directCallEnded(costing: CallCosting): void;
}

/** A hand-off: where it stands, as recorded in the chat, and the call that made it. */
interface Handoff {
  record: VoiceHandoffRecord;
  sessionId: string;
}

/** What the chat's agent is doing now, from the host's own events. */
interface ChatNow {
  turnStartedAt?: number;
  step?: { label: string; since: number };
  /** The last message the agent wrote in the running turn: what ends it, when it ends. */
  lastReply?: string;
  /** Every message the agent wrote in the running turn: a hand-off's row holds them all. */
  replySeqs: number[];
  /**
   * Hand-offs the running turn has taken, each with how many of its messages
   * came before: one taken at a tool boundary mid-turn is answered only by
   * what the agent wrote after it.
   */
  handoffs: Map<string, number>;
}

/** The longest pushed answer: the voice says the gist, and the whole text is in the chat. */
const PUSH_MAX_CHARS = 6_000;

const cap = (text: string, max: number): string => {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()} … (the rest is in the chat)` : t;
};

export function createChatVoice(deps: {
  daemon: ChatVoiceHost;
  /** The open sessions on a chat; empty before the audio server is up. */
  sessionsOnChat: (chatId: string) => VoiceSessionLike[];
  /** One open session by id; undefined once it has closed. */
  sessionById?: (sessionId: string) => VoiceSessionLike | undefined;
  /** The catch-up small job: everything before the last messages, summarised. */
  catchUp?: (chatId: string, earlier: StartMessage[]) => Promise<string>;
  /** Finding, reading and naming the account's chats: find chats, chat status and switch chat. */
  lookup: ChatLookup;
  /** True when `chatId` lives on this host. */
  isLocal?: (chatId: string) => boolean;
  /** Hang an open call up as the agent ending it: ended sound, bar cleared, no redial. */
  endCall?: (sessionId: string) => void;
  /** Move an open call to another chat: the session, its announcement and its surface's bar. */
  retargetCall?: (sessionId: string, chatId: string) => void;
  ledger: VoiceLedger;
  logger: Logger;
  /** A call was costed: the host's totals changed. */
  onCosted: () => void;
  /** What ElevenLabs charged for a conversation; absent when the host has no ElevenLabs key. */
  lookupRealCharge?: (conversationId: string) => Promise<RealCharge>;
  now?: () => number;
}): ChatVoice {
  const { daemon, logger } = deps;
  const now = deps.now ?? Date.now;
  // Hand-offs made so far, per call session; read and cleared when the call is costed.
  const handoffCounts = new Map<string, number>();
  /** Every hand-off of every open call, by the localId its turn carries. */
  const handoffs = new Map<string, Handoff>();
  const chats = new Map<string, ChatNow>();
  const chatNow = (chatId: string): ChatNow => {
    let c = chats.get(chatId);
    if (!c) chats.set(chatId, (c = { handoffs: new Map(), replySeqs: [] }));
    return c;
  };
  /** The chat each open call started on: a hand-off made after a switch says where from. */
  const callChats = new Map<string, string>();
  /** Record a hand-off's new state in the chat, where its row shows it. */
  const publish = (h: Handoff, next: VoiceHandoffRecord): void => {
    h.record = next;
    try {
      daemon.recordVoiceHandoff(next);
    } catch (err) {
      logger.error(
        { chatId: next.chatId, handoffId: next.handoffId, err: (err as Error).message },
        `voice: could not record the hand-off as ${next.state}`,
      );
    }
  };
  // Set while a call writes its own exchange into the chat, so that write is
  // not taken for the chat's agent speaking.
  let writing = false;
  const asVoice = (fn: () => void): void => {
    writing = true;
    try {
      fn();
    } finally {
      writing = false;
    }
  };

  /** The chat's name for a label; its id when it has none. */
  const chatLabel = (chatId: string): string => {
    try {
      return daemon.voiceStartFacts(chatId, 0).name ?? chatId;
    } catch {
      return chatId;
    }
  };
  /** " (from the chat "X")" when the call has moved away from the chat a push is about. */
  const fromChat = (session: VoiceSessionLike, chatId: string): string =>
    session.getCurrentChatId() === chatId ? '' : ` (from the chat "${chatLabel(chatId)}")`;

  const settleHandoff = (
    h: Handoff,
    outcome: { answer: string; seqs: number[] } | { error: string },
  ): void => {
    const r = h.record;
    if (r.state === 'answered' || r.state === 'failed') return;
    const session = deps.sessionById?.(h.sessionId);
    const where = session ? fromChat(session, r.chatId) : '';
    const answer = 'answer' in outcome ? cap(outcome.answer, PUSH_MAX_CHARS) : '';
    publish(
      h,
      'answer' in outcome
        ? { ...r, state: 'answered', endedAt: now(), answer, answerSeqs: outcome.seqs }
        : { ...r, state: 'failed', endedAt: now(), error: outcome.error },
    );
    if (!session) {
      logger.warn(
        { sessionId: h.sessionId, chatId: r.chatId, state: h.record.state },
        'voice: the call ended before its hand-off was answered; the answer is in the chat',
      );
      return;
    }
    const push =
      'answer' in outcome
        ? `${ANSWER_LABEL} to "${r.request}"${where}: ${answer}`
        : `The request "${r.request}"${where} was not answered: it failed (${outcome.error}). Tell the user.`;
    logger.info(
      { sessionId: h.sessionId, chatId: r.chatId, state: h.record.state },
      'voice: hand-off settled, pushing it into the call',
    );
    session.pushMessage(push, { handoffSettled: true });
  };

  /** A turn on `chatId` ended: settle the hand-offs it carried, or push its reply to the calls on it. */
  const turnEnded = (chatId: string, failed: string | null): void => {
    const c = chatNow(chatId);
    const reply = c.lastReply;
    const seqs = c.replySeqs;
    const carried = [...c.handoffs].flatMap(([id, from]) => {
      const h = handoffs.get(id);
      return h ? [{ h, seqs: seqs.slice(from) }] : [];
    });
    c.turnStartedAt = undefined;
    c.step = undefined;
    c.lastReply = undefined;
    c.replySeqs = [];
    c.handoffs.clear();
    if (carried.length > 0) {
      for (const { h, seqs: answerSeqs } of carried) {
        settleHandoff(
          h,
          failed !== null
            ? { error: failed }
            : { answer: reply ?? 'It finished without writing a reply.', seqs: answerSeqs },
        );
      }
      return;
    }
    // Not in answer to a hand-off (a typed message, a job, another surface): a
    // reply that ends a turn is pushed to every call on the chat. A Manager
    // call's chat is the Manager's own; its agent's results stay in the chat
    // (spec/07 § A call to the Manager).
    if (failed !== null || reply === undefined || chatId === MANAGER_CHAT_ID) return;
    for (const session of deps.sessionsOnChat(chatId)) {
      session.pushMessage(
        `Message from the chat's agent, ending its turn (not an answer to anything you passed on): ${cap(reply, PUSH_MAX_CHARS)}`,
      );
    }
  };

  function startContext(chatId: string): StartContext {
    const facts = daemon.voiceStartFacts(chatId, START_RECENT_MESSAGES);
    const text = startContextText(facts, now());
    if (facts.earlier.length === 0) return { text, catchUp: null };
    if (!deps.catchUp) {
      return { text, catchUp: Promise.reject(new Error('this host cannot write a catch-up')) };
    }
    const catchUp = deps.catchUp(chatId, facts.earlier);
    // Observed here so an unawaited failure never takes the host down; the
    // session reports it on the call bar.
    catchUp.catch(() => undefined);
    return { text, catchUp };
  }

  function chatNowLines(chatId: string): string[] {
    const t = now();
    const activity = daemon.chatActivity(chatId);
    const c = chats.get(chatId);
    const lines: string[] = [];
    if (activity === null) {
      lines.push(`The chat's agent: unknown (the chat ${chatId} is not on this computer).`);
      return lines;
    }
    if (activity === 'idle' || activity === 'errored') {
      lines.push(
        activity === 'errored'
          ? "The chat's agent now: idle; its last turn stopped on an error."
          : "The chat's agent now: idle.",
      );
    } else {
      const since = c?.turnStartedAt !== undefined ? ` for ${ageWords(t - c.turnStartedAt)}` : '';
      lines.push(
        activity === 'awaiting-permission'
          ? `The chat's agent now: working${since}, stopped waiting for the user to approve or answer something.`
          : `The chat's agent now: working${since}.`,
      );
      if (c?.step) lines.push(`Current step: ${c.step.label}, for ${ageWords(t - c.step.since)}.`);
    }
    const last = daemon.lastAgentMessage(chatId);
    lines.push(
      last === null
        ? 'It has not written a message yet.'
        : `Its last message, ${ageWords(t - last.at)} ago: ${cap(last.text, 600)}`,
    );
    return lines;
  }

  /**
   * A voice agent's hand-off: written into the chat now, in order with what was
   * said around it, and delivered under that line when the chat's agent gets to
   * it; nothing interrupts what the agent is doing. `done` rejects when the
   * request could not be given to the agent.
   */
  const sendHandoff = (req: {
    chatId: string;
    message: string;
    source: VoiceTurnSource;
  }): { localId: string; rowSeq: number; done: Promise<void> } => {
    const voicePrefix = voiceTag(req.source, true);
    const localId = voiceLocalId(req.source);
    const drawn = daemon.recordVoiceMessage({
      chatId: req.chatId,
      role: 'user',
      content: `${voicePrefix}${req.message}`,
      owed: false,
    });
    const done = daemon.sendInput({
      chatId: req.chatId,
      message: req.message,
      localId,
      voicePrefix,
      fromUser: true,
      deliverDrawn: drawn,
    });
    return { localId, rowSeq: drawn, done };
  };

  const link: VoiceAgentLink = {
    startContext,

    answerPermission(chatId, words) {
      const requestId = deps.daemon.getPendingPermissionForChat(chatId);
      if (requestId === undefined) return false;
      const approve = parseYesNo(words);
      if (approve === null) return false;
      deps.daemon.submitPermissionResponse({ requestId, decision: approve ? 'approve' : 'deny' });
      return true;
    },

    passToAgent({ sessionId, chatId, request, source }) {
      const { localId, rowSeq, done } = sendHandoff({ chatId, message: request, source });
      // Made by a call that moved here from another chat: the row says where from.
      const callChat = callChats.get(sessionId);
      const record: VoiceHandoffRecord = {
        chatId,
        handoffId: localId,
        rowSeq,
        request,
        state: 'waiting',
        sentAt: now(),
        ...(callChat !== undefined && callChat !== chatId
          ? { from: `the call from "${chatLabel(callChat)}"` }
          : {}),
      };
      const h: Handoff = { sessionId, record };
      handoffs.set(localId, h);
      publish(h, record);
      handoffCounts.set(sessionId, (handoffCounts.get(sessionId) ?? 0) + 1);
      // `done` resolves as soon as the message is queued behind a running turn, so
      // only its failure says anything: the request never reached the agent.
      done.catch((err: Error) => {
        logger.error({ sessionId, chatId, err: err.message }, 'voice: hand-off failed');
        settleHandoff(h, { error: err.message });
      });
    },

    checkStatus(sessionId, chatId) {
      const t = now();
      const mine = [...handoffs.values()].filter((h) => h.sessionId === sessionId);
      const lines: string[] = [];
      if (mine.length === 0) {
        lines.push('Nothing has been passed to the agent on this call.');
      } else {
        lines.push('Requests passed to the agent on this call, oldest first:');
        for (const { record: r } of mine) {
          const where = r.chatId === chatId ? '' : ` (in the chat "${chatLabel(r.chatId)}")`;
          const state =
            r.state === 'waiting'
              ? 'waiting: the agent has not taken it yet; it is finishing what it was doing'
              : r.state === 'working'
                ? `being worked on for ${ageWords(t - (r.startedAt ?? r.sentAt))}`
                : r.state === 'answered'
                  ? `answered ${ageWords(t - (r.endedAt ?? t))} ago; the answer was given to you`
                  : `failed ${ageWords(t - (r.endedAt ?? t))} ago (${r.error ?? 'no reason given'})`;
          lines.push(`- "${r.request}"${where}: ${state}; sent ${ageWords(t - r.sentAt)} ago.`);
        }
      }
      lines.push(...chatNowLines(chatId));
      return lines.join('\n');
    },

    lookBack(chatId, query) {
      return daemon.searchChat(chatId, query);
    },

    findChats(chatId, query) {
      return deps.lookup.findChats(query, chatId);
    },

    chatStatus(chatId, chat) {
      return deps.lookup.chatStatus(chat, chatId);
    },

    endCall(sessionId) {
      if (!deps.endCall) throw new Error('this host cannot hang a call up');
      logger.info({ sessionId }, 'voice: the voice agent ended the call');
      deps.endCall(sessionId);
    },

    async switchChat(sessionId, fromChatId, chat): Promise<SwitchOutcome> {
      if (!deps.isLocal || !deps.retargetCall) {
        throw new Error('this host cannot move a call to another chat');
      }
      let target: ChatEntry;
      try {
        target = await deps.lookup.resolve(chat, fromChatId);
      } catch (err) {
        if (err instanceof ChatLookupError) return { ok: false, message: err.message };
        throw err;
      }
      const name = target.name?.trim() || target.chatId;
      if (target.chatId === fromChatId) {
        return { ok: false, message: `The call is already on "${name}".` };
      }
      if (!deps.isLocal(target.chatId)) {
        return {
          ok: false,
          message: `"${name}" is on another computer, so the call cannot move there.`,
        };
      }
      // The start context first: a chat that cannot be read is not moved to.
      const context = startContext(target.chatId);
      deps.retargetCall(sessionId, target.chatId);
      logger.info(
        { sessionId, from: fromChatId, to: target.chatId },
        'voice: the call moved to another chat',
      );
      return { ok: true, chatId: target.chatId, name, context };
    },
  };

  /**
   * Cost a call and leave its one line in the chat. Only the voice engine is
   * costed: the agent turns a hand-off runs are the chat's own and are not a
   * call's expense, so there is nothing to wait for and the line lands at hang-up.
   */
  async function cost(info: Parameters<ChatVoice['callEnded']>[0]): Promise<void> {
    const { init, chatId, startedAt, endedAt, engine } = info;
    // A voice agent that never opened was never a call: no conversation, nothing
    // billed. A "Call 0:12 … cost unavailable" line would read as a live call.
    if (
      engine.backend === 'elevenlabs' &&
      engine.conversationId === undefined &&
      engine.agentSeconds === 0
    ) {
      logger.warn(
        { sessionId: init.sessionId },
        'voice: the ElevenLabs agent never opened, no call line written',
      );
      handoffCounts.delete(init.sessionId);
      return;
    }
    const costing = costCall({
      sessionId: init.sessionId,
      chatId,
      surfaceKind: init.surfaceKind,
      startedAt,
      endedAt,
      engine,
      handoffs: handoffCounts.get(init.sessionId) ?? 0,
    });
    handoffCounts.delete(init.sessionId);
    if (engine.backend === 'elevenlabs') {
      if (engine.conversationId === undefined || !deps.lookupRealCharge) {
        const error = 'no conversation id or ElevenLabs key to look the charge up with';
        logger.error({ sessionId: init.sessionId }, `voice: ${error}`);
        costing.real = { error };
      } else {
        try {
          costing.real = await deps.lookupRealCharge(engine.conversationId);
        } catch (err) {
          logger.error(
            { sessionId: init.sessionId, err: (err as Error).message },
            'voice: could not get the real call charge from ElevenLabs',
          );
          costing.real = { error: (err as Error).message };
        }
      }
    }
    settle(costing);
  }

  /** Keep a costed call on the ledger and leave its line in the chat. */
  function settle(costing: CallCosting): void {
    deps.ledger.record(costing);
    logger.info({ costing }, 'voice: call costed');
    try {
      daemon.recordCallSummary(costing.chatId, callSummaryLine(costing));
    } catch (err) {
      logger.error(
        { chatId: costing.chatId, err: (err as Error).message },
        'voice: could not write the call summary into the chat',
      );
    }
    deps.onCosted();
  }

  return {
    link,

    handoffStarted({ chatId, handoffId }) {
      const h = handoffs.get(handoffId);
      if (!h || h.record.state !== 'waiting') return;
      publish(h, { ...h.record, state: 'working', startedAt: now() });
      const c = chatNow(chatId);
      c.handoffs.set(handoffId, c.replySeqs.length);
    },

    makeTimeline(init) {
      callChats.set(init.sessionId, init.chatId);
      const tag =
        init.surfaceKind === 'device'
          ? `[voice • device:${init.deviceId ?? 'unknown'}] `
          : `[voice • ${init.surfaceKind}] `;
      // A timeline write runs inside a provider socket's message handler, so a
      // failure is logged loudly here rather than thrown into the socket.
      const guard = (what: string, chatId: string, fn: () => void): void => {
        try {
          fn();
        } catch (err) {
          logger.error(
            { sessionId: init.sessionId, chatId, err: (err as Error).message },
            `voice: could not write ${what} into the chat`,
          );
        }
      };
      return {
        userSaid(chatId, text) {
          // Silence and noise transcribe as '' or '…': not something the user said.
          if (!/[\p{L}\p{N}]/u.test(text)) return;
          guard('the spoken words', chatId, () =>
            asVoice(() =>
              daemon.recordVoiceMessage({ chatId, role: 'user', content: `${tag}${text}` }),
            ),
          );
        },
        beginReply(chatId) {
          let seq: number | undefined;
          let text = '';
          return {
            append(delta) {
              guard('the spoken reply', chatId, () => {
                seq ??= daemon.reserveVoiceSeq(chatId);
                text += delta;
                daemon.emitVoiceDelta(chatId, seq, delta);
              });
            },
            finish(heard) {
              const said = (heard ?? text).trim();
              if (seq === undefined || said === '') return;
              const at = seq;
              guard('the spoken reply', chatId, () =>
                asVoice(() =>
                  daemon.recordVoiceMessage({
                    chatId,
                    role: 'assistant',
                    // Tagged like the user's words, so every surface can mark it as spoken.
                    content: `${tag}${said}`,
                    seq: at,
                  }),
                ),
              );
            },
            text: () => text,
          };
        },
      };
    },

    observe(event) {
      switch (event.type) {
        case 'chat.turn_started': {
          const c = chatNow(event.chatId);
          c.turnStartedAt = event.at;
          c.step = undefined;
          c.lastReply = undefined;
          c.replySeqs = [];
          return;
        }
        case 'chat.tool_call':
          chatNow(event.chatId).step = { label: event.tool, since: event.startedAt ?? now() };
          return;
        case 'chat.tool_run_summary': {
          // A live summary narrates the step in words ("Looking at the logs").
          const c = chats.get(event.chatId);
          if (event.live === true && event.summary !== null && c?.step) {
            c.step = { label: event.summary, since: c.step.since };
          }
          return;
        }
        case 'chat.tool_result':
          chatNow(event.chatId).step = { label: 'thinking about what it found', since: now() };
          return;
        case 'chat.message':
          // The voice's own words, and the hand-off rows, are not the chat's agent speaking.
          if (writing || event.role !== 'assistant' || event.content.startsWith('[voice')) return;
          chatNow(event.chatId).lastReply = event.content;
          chatNow(event.chatId).replySeqs.push(event.seq);
          return;
        case 'chat.turn_ended':
          turnEnded(
            event.chatId,
            event.outcome === 'failed' || event.outcome === 'interrupted'
              ? (event.error?.message ?? `the turn ended ${event.outcome}`)
              : null,
          );
          return;
        default:
          return;
      }
    },

    directCallEnded(costing) {
      settle(costing);
    },

    callEnded(info) {
      for (const [id, h] of handoffs) {
        if (h.sessionId === info.init.sessionId) handoffs.delete(id);
      }
      callChats.delete(info.init.sessionId);
      void cost(info).catch((err: Error) =>
        logger.error({ err: err.message }, 'voice: costing the call failed'),
      );
    },
  };
}
