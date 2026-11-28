// The voice agent's side of a call, the same on every provider (spec/07 § The
// voice agent and the chat's agent, § Voice instructions, § Keeping voice and
// text as one conversation, § A call stays on its chat).
//
// The voice agent (Gemini Live, OpenAI Realtime or ElevenLabs Agents) is told
// the user's own voice instructions, then the voice's tone, then the chat's
// start context, and nothing else. Everything it needs to know about a tool is
// in that tool's description below. Its tools:
//
//   - pass_to_agent: answers "received" at once; the request becomes a message
//     in the chat for the chat's agent, and the agent's answer is pushed into
//     the call when it lands (chatVoice.ts).
//   - check_status: where the hand-offs and the chat's agent stand, read from
//     the host's own state; no model.
//   - look_back: the chat's older messages that match a few words; no model.
//   - find_chats / chat_status: find any chat of the account (any host, archived
//     included, labelled) and read where one stands; no model (chatLookup.ts).
//   - send_to_chat: sends a message to another chat (any host, archived included)
//     and answers "received" at once; that chat's reply is pushed into the call
//     when its turn ends, labelled with the chat's name (chatVoice.ts).
//   - switch_chat: moves the call to another chat on this host.
//
// The provider modules turn these into their own tool shapes and answer them
// through a {@link VoiceAgentLink}, which the host implements (chatVoice.ts).

import type { VoiceHandoff } from '@patch/wire/audio';
import type { VoiceTurnSource } from './session.js';

export const PASS_TO_AGENT_TOOL_NAME = 'pass_to_agent';
export const CHECK_STATUS_TOOL_NAME = 'check_status';
export const LOOK_BACK_TOOL_NAME = 'look_back';
export const SWITCH_CHAT_TOOL_NAME = 'switch_chat';
export const END_CALL_TOOL_NAME = 'end_call';
export const FIND_CHATS_TOOL_NAME = 'find_chats';
export const CHAT_STATUS_TOOL_NAME = 'chat_status';
export const SEND_TO_CHAT_TOOL_NAME = 'send_to_chat';

/** What pass_to_agent answers, at once. */
export const HANDOFF_RECEIVED = 'received';

/** How a pushed answer starts, so the voice can tell it from anything else. */
export const ANSWER_LABEL = "Answer from the chat's agent";

export const PASS_TO_AGENT_DESCRIPTION =
  "Pass a request to the chat's agent, which has the user's files, data and tools and can do " +
  'real work. Use it for anything you cannot answer from the chat and your own knowledge, and ' +
  'for every action. It answers "received" at once: say in a few words of your own that you ' +
  'have passed it on, then carry on talking and answer anything else the user says. The agent ' +
  `takes it when it is free. Its answer arrives later as a message starting "${ANSWER_LABEL}": ` +
  'then tell the user the gist in a sentence or two, not the whole text. Until that message ' +
  'arrives the request is not done, so never say it is, and never pass the same request on twice.';

export const CHECK_STATUS_DESCRIPTION =
  'Where the work you passed on stands, read from Patch at once: each request on this call ' +
  '(what was asked; waiting, being worked on or answered; how long ago it was sent) and what ' +
  "the chat's agent is doing now (idle or working, the step it is in and for how long, its last " +
  'message and how old it is). Call it only when the user asks how something is going or you ' +
  'need to know; answers arrive by themselves.';

export const LOOK_BACK_DESCRIPTION =
  'Search this chat for earlier messages about something the chat context does not cover. Give ' +
  'a few key words from the question. It returns the matching messages at once; no work is ' +
  'done. Use it before saying you do not know something about earlier in the chat.';

export const SWITCH_CHAT_DESCRIPTION =
  'Move this call to another chat, when the user asks to talk to a different chat. Give the ' +
  'chat as the user named it, or its id. The call carries on there and that chat as it stands ' +
  'arrives as a message; answers still owed from this chat arrive as before, labelled with ' +
  'their chat. If the name fits no chat or several, the result says so: ask the user which.';

export const FIND_CHATS_DESCRIPTION =
  "List the user's chats, or find the ones matching a few words of a name or folder. Answers at " +
  "once with each chat's name, id, whether it is working, and when it was last active. Archived " +
  'chats are included and marked archived; a message to one brings it back. An empty query ' +
  'lists the most recently active chats.';

export const CHAT_STATUS_DESCRIPTION =
  'Where one chat stands now: its status line, goal, open to-dos and the last few messages. ' +
  "Pass the chat's name or id. Answers at once.";

export const SEND_TO_CHAT_DESCRIPTION =
  'Send a message to another chat, by its name or id, to tell or ask it something. Its agent ' +
  'receives it as if the user had typed it and works on it. It answers "received" at once: say ' +
  'in a few words of your own that it has gone, then carry on. When that chat has replied, the ' +
  `reply arrives as a message naming the chat: tell the user the gist in a sentence or two, ` +
  'not the whole text. If the reply is only a receipt (the chat saying it has passed the request ' +
  'on, with no answer in it), say nothing. Until a reply arrives the question is not answered, ' +
  'so never say it is. A message to an archived chat brings it back. If the name fits no chat ' +
  'or several, the result says so: ask the user which.';

export const END_CALL_DESCRIPTION =
  'Hang up. Use it only when the user says goodbye or asks you to hang up, or, on a call an ' +
  'agent made to the user, once they have answered and anything they asked for has been passed ' +
  'on. Never hang up because the user is quiet: silence is not the end of a call, and the user ' +
  'may be busy or listening. Say a short goodbye first; the call ends once it has been heard.';

/** A chat's reply as it is pushed into a call that sent it a message. */
export function chatReplyMessage(name: string, message: string, reply: string): string {
  return (
    `The chat "${name}" has answered the message you sent it ("${message}"). Its reply, to tell ` +
    `the user now, in your own words (if it is only a receipt that the request was passed on or ` +
    `sent elsewhere, with no answer, say nothing): ${reply}`
  );
}

/** One tool as every provider declares it: string parameters, described. */
export interface VoiceToolSpec {
  name: string;
  description: string;
  params: Record<string, string>;
  required: string[];
}

/** The tools every voice agent call is given; a Manager call adds its own (managerVoice.ts). */
export function voiceAgentTools(opts: {
  handoff: VoiceHandoff;
  lookBack: boolean;
  switchChat: boolean;
}): VoiceToolSpec[] {
  const tools: VoiceToolSpec[] = [];
  // `never` has no agent behind the voice, so nothing to pass to or ask about.
  if (opts.handoff !== 'never') {
    tools.push(
      {
        name: PASS_TO_AGENT_TOOL_NAME,
        description: PASS_TO_AGENT_DESCRIPTION,
        params: {
          request:
            'What the user wants, in plain words, with anything the agent needs to know to do it.',
        },
        required: ['request'],
      },
      {
        name: CHECK_STATUS_TOOL_NAME,
        description: CHECK_STATUS_DESCRIPTION,
        params: {},
        required: [],
      },
    );
  }
  if (opts.lookBack) {
    tools.push({
      name: LOOK_BACK_TOOL_NAME,
      description: LOOK_BACK_DESCRIPTION,
      params: { query: 'A few key words to search the chat for.' },
      required: ['query'],
    });
  }
  // Every call can look at other chats, on any host (chatLookup.ts).
  tools.push(
    {
      name: FIND_CHATS_TOOL_NAME,
      description: FIND_CHATS_DESCRIPTION,
      params: { query: 'A few words of the chat name or folder; empty to list recent chats.' },
      required: [],
    },
    {
      name: CHAT_STATUS_TOOL_NAME,
      description: CHAT_STATUS_DESCRIPTION,
      params: { chat: "The chat's name (as the user said it, or from find_chats) or its id." },
      required: ['chat'],
    },
  );
  tools.push({
    name: SEND_TO_CHAT_TOOL_NAME,
    description: SEND_TO_CHAT_DESCRIPTION,
    params: {
      chat: "The chat's name (as the user said it, or from find_chats) or its id.",
      message: 'What to tell the chat, written as the user would put it to that chat.',
    },
    required: ['chat', 'message'],
  });
  tools.push({
    name: END_CALL_TOOL_NAME,
    description: END_CALL_DESCRIPTION,
    params: {},
    required: [],
  });
  if (opts.switchChat) {
    tools.push({
      name: SWITCH_CHAT_TOOL_NAME,
      description: SWITCH_CHAT_DESCRIPTION,
      params: { chat: 'The chat to move to, as the user named it, or its id.' },
      required: ['chat'],
    });
  }
  return tools;
}

/**
 * The voice agent's instructions: the user's voice instructions, then any
 * other text the user set for this kind of session (a voice device's
 * speaking-aloud prompt, who is speaking), then the tone, then the start
 * context. Nothing else is added.
 */
export function voiceAgentInstructions(parts: {
  instructions: string;
  extra?: string[];
  tone?: string;
  startContext?: string;
}): string {
  return [parts.instructions, ...(parts.extra ?? []), parts.tone ?? '', parts.startContext ?? '']
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .join('\n\n');
}

/** The start context of a call, or of a chat the call switched to. */
export interface StartContext {
  /** Everything known at once: name, goal, open questions, the last messages. */
  text: string;
  /**
   * The catch-up on everything before the last messages, written by a small
   * job while the call connects. Null when there is nothing before them.
   * Rejects when the job failed; the call says so and carries on without it.
   */
  catchUp: Promise<string> | null;
}

export type SwitchOutcome =
  | { ok: true; chatId: string; name: string; context: StartContext }
  | { ok: false; message: string };

export type SendToChatOutcome =
  | { ok: true; name: string; reply: Promise<string> }
  | { ok: false; message: string };

/** What a provider session asks of the host to run the voice agent's tools. */
export interface VoiceAgentLink {
  /**
   * The chat as it stands, for the start of a call. Throws when the chat
   * cannot be read: a voice that knows nothing of its chat is a failure.
   */
  startContext(chatId: string): StartContext;
  /**
   * Pass a request to the chat's agent. Returns at once, once the request is
   * written into the chat and queued; throws when it could not be.
   */
  passToAgent(req: {
    sessionId: string;
    chatId: string;
    request: string;
    source: VoiceTurnSource;
  }): void;
  checkStatus(sessionId: string, chatId: string): string;
  lookBack(chatId: string, query: string): string;
  /** Find chats of the account by a few words of name or folder (chatLookup.ts). */
  findChats(chatId: string, query: string): Promise<string>;
  /**
   * Send `message` to another chat for the call on `chatId`, as `patch_send_to`
   * does. Resolves once that chat has it; `reply` settles with its reply when
   * its turn ends. Rejects when the message was not delivered.
   */
  sendToChat(req: { chatId: string; chat: string; message: string }): Promise<SendToChatOutcome>;
  /** Where another chat stands, read for the call on `chatId`. */
  chatStatus(chatId: string, chat: string): Promise<string>;
  /**
   * The user's finished words on a call (spec/07 § Permission prompts during
   * voice): when the chat waits on a permission and the words are a plain yes
   * or no, answer it. Returns whether they did.
   */
  answerPermission(chatId: string, words: string): boolean;
  /** Hang the call up as the agent ending it (`ended_by_agent`): a clean end, not a drop. */
  endCall(sessionId: string): void;
  /** Move the call to another chat on this host; the host re-announces it. */
  switchChat(sessionId: string, fromChatId: string, chat: string): Promise<SwitchOutcome>;
}

/** The longest any one of the last messages is shown, so one giant report cannot swamp a call. */
export const START_MESSAGE_MAX_CHARS = 8_000;

/** How many of the chat's last messages are given in full. */
export const START_RECENT_MESSAGES = 4;

/** One message as the start context shows it. */
export interface StartMessage {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

/** The facts a start context is written from, read from the chat on the host. */
export interface StartFacts {
  name: string | null;
  goal: string | null;
  openQuestions: string[];
  /** The last {@link START_RECENT_MESSAGES} messages, oldest first. */
  recent: StartMessage[];
  /** Everything before them, oldest first: what the catch-up is written from. */
  earlier: StartMessage[];
}

/** A moment as the voice is told it: day and time, in the host's time zone. */
export function spokenTime(at: number): string {
  return new Date(at).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The instant part of the start context. */
export function startContextText(facts: StartFacts, now: number): string {
  const lines = ['THE CHAT AS IT STANDS', `It is now ${spokenTime(now)}.`];
  lines.push(`Chat: ${facts.name ?? 'not named yet'}`);
  if (facts.goal) lines.push(`Goal: ${facts.goal}`);
  if (facts.openQuestions.length > 0) {
    lines.push('Questions to the user still open:', ...facts.openQuestions.map((q) => `- ${q}`));
  }
  if (facts.earlier.length > 0) {
    lines.push(
      'A catch-up on everything before the last messages arrives as a message once it is written.',
    );
  }
  if (facts.recent.length === 0) {
    lines.push('The chat has no messages yet.');
  } else {
    lines.push('The last messages, oldest first:');
    for (const m of facts.recent) {
      const text =
        m.text.length > START_MESSAGE_MAX_CHARS
          ? `${m.text.slice(0, START_MESSAGE_MAX_CHARS).trimEnd()} … (cut; look_back for more)`
          : m.text;
      lines.push(`[${spokenTime(m.at)}] ${m.role === 'user' ? 'User' : 'Agent'}: ${text}`);
    }
  }
  lines.push(`For anything older, use ${LOOK_BACK_TOOL_NAME}.`);
  return lines.join('\n');
}

/**
 * The first push of a call that answers an agent's ring (spec/07 §
 * Agent-initiated voice): the voice opens by telling the user why the agent
 * called, then waits for their answer.
 */
export function callOpening(reason: string): string {
  return (
    "The chat's agent called the user and they have just answered. Open the call by telling " +
    `them why it called, in a sentence or two, then wait for their answer: "${reason.trim()}"`
  );
}

/** The catch-up as it is added to the call. */
export function catchUpMessage(text: string, chatName: string | null): string {
  return `Catch-up on ${chatName ? `the chat "${chatName}"` : 'this chat'}, everything before its last messages: ${text}`;
}

/** What the voice is told when the call has moved to another chat. */
export function switchedMessage(name: string, context: string): string {
  return `The call is now on the chat "${name}".\n${context}`;
}

/** How long ago, in words the voice can say. */
export function ageWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** True when a transcript has no letter or digit in it — "...", ".", "<noise>": silence, not speech. */
export function isNoiseTranscript(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text.replace(/<noise>/gi, ''));
}

/**
 * spec/07 § Barge-in — how much of a reply the user heard when they cut it
 * off: the reply's text cut in proportion to the audio played, at a word
 * boundary. Playback is taken to run in real time from the reply's first
 * audio chunk, which is when the surface starts playing it.
 */
export function heardPart(text: string, heardMs: number, audioMs: number): string {
  if (audioMs <= 0 || heardMs >= audioMs) return text;
  const keep = Math.floor((text.length * Math.max(0, heardMs)) / audioMs);
  if (keep <= 0) return '';
  const cut = text.slice(0, keep);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
