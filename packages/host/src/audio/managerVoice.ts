// The Manager call (spec/07 § A call to the Manager).
//
// On any other chat a hosted voice (Gemini Live, OpenAI Realtime, ElevenLabs
// Agents) is the light layer in front of the chat's own agent: whatever needs
// real work goes to that agent through `dispatch_to_patch`. The Manager's work
// is talking to other chats, so routing a call through it put two heavy hops
// between the user and the chat they meant (voice → Manager agent →
// patch_send_to → the other chat's agent). On a Manager call the voice IS the
// manager: it is given tools to find chats, read where one stands and send it a
// message (the same delivery patch_send_to makes), and the Manager's agent is
// not in the loop. A chat's reply comes back into the call the same way an
// agent's hand-off result does, and both the message and the reply are written
// into the Manager chat.
//
// This module is the shared half: the prompt text (exported constants, so they
// can be overridden later), the tool definitions the three engines declare, and
// `createManagerVoiceTools`, the host-side implementation the engines call.

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

/** The chat a call must be on to be a Manager call. */
export const MANAGER_CHAT_ID = 'thread_manager';

export function isManagerCall(chatId: string): boolean {
  return chatId === MANAGER_CHAT_ID;
}

export const SEND_TO_CHAT_TOOL_NAME = 'send_to_chat';
export const FIND_CHATS_TOOL_NAME = 'find_chats';
export const CHAT_STATUS_TOOL_NAME = 'chat_status';

/**
 * Tools the voice runs itself on the host, answered at once: the common
 * actions a user asks of a Manager that need no agent (a task, the diary).
 * `ask_agent` is the hand-off for real work: it passes the request to the
 * Manager chat's own agent and returns straight away.
 */
export interface ManagerQuickTool {
  name: string;
  description: string;
  params: Record<string, string>;
  required: string[];
}

export const ADD_TASK_TOOL_NAME = 'add_task';
export const CALENDAR_AGENDA_TOOL_NAME = 'calendar_agenda';
export const ADD_EVENT_TOOL_NAME = 'add_event';
export const ASK_AGENT_TOOL_NAME = 'ask_agent';

export const MANAGER_QUICK_TOOLS: readonly ManagerQuickTool[] = [
  {
    name: ADD_TASK_TOOL_NAME,
    description:
      "Add a task to the user's to-do list (Todoist). Answers at once. Use it for anything like " +
      '"log a task", "remind me to", "add to my list".',
    params: {
      content: 'The task, as a short phrase.',
      due: 'When it is due, in plain words ("tomorrow", "friday", "2026-12-01"); empty for none.',
    },
    required: ['content'],
  },
  {
    name: CALENDAR_AGENDA_TOOL_NAME,
    description:
      "Read the user's calendar for a day or a range. Answers at once with each event's title and " +
      'time. Dates are YYYY-MM-DD; with no dates it is today.',
    params: {
      from: 'First day, YYYY-MM-DD; empty for today.',
      to: 'Last day, YYYY-MM-DD; empty for the same day as from.',
      query: 'A few words to search event titles for; empty for all.',
    },
    required: [],
  },
  {
    name: ADD_EVENT_TOOL_NAME,
    description:
      "Put an event in the user's calendar. Answers at once. Times are London local, ISO " +
      '(2026-12-01T14:00:00); for an all-day event pass a plain date as start and set all_day.',
    params: {
      title: 'The event title.',
      start: 'Start, ISO datetime or a date for all-day.',
      end: 'End, ISO datetime; required unless the event is all day.',
      all_day: 'The word "true" for an all-day event, otherwise empty.',
    },
    required: ['title', 'start'],
  },
  {
    name: ASK_AGENT_TOOL_NAME,
    description:
      "Hand real work to the Manager's own agent: research, changes to code or files, anything that " +
      'needs more than a lookup or the tools above. Returns at once to say it was passed on; the ' +
      'result is written in the Manager chat, not read out here.',
    params: { request: 'What the agent should do, in plain language, with the detail it needs.' },
    required: ['request'],
  },
];

export const MANAGER_QUICK_TOOL_NAMES: ReadonlySet<string> = new Set(
  MANAGER_QUICK_TOOLS.map((t) => t.name),
);

export const MANAGER_TOOL_NAMES: ReadonlySet<string> = new Set([
  SEND_TO_CHAT_TOOL_NAME,
  FIND_CHATS_TOOL_NAME,
  CHAT_STATUS_TOOL_NAME,
  ...MANAGER_QUICK_TOOL_NAMES,
]);

/** The string arguments of a tool call, whatever shape the engine gave them. */
export function stringArgs(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );
}

export const FIND_CHATS_DESCRIPTION =
  "List the user's chats, or find the ones matching a few words of a name or folder. Answers at " +
  "once with each chat's name, id, whether it is working, and when it was last active. An empty " +
  'query lists the most recently active chats.';

export const CHAT_STATUS_DESCRIPTION =
  'Where one chat stands now: its status line, goal, open to-dos and the last few messages. ' +
  "Pass the chat's name or id. Answers at once.";

export const SEND_TO_CHAT_DESCRIPTION =
  "Send a message to another chat, by its name or id. The chat's agent receives it as if the user " +
  'had typed it and works on it. Its reply comes back to you later as a message; meanwhile carry ' +
  'on the conversation.';

/** The same, for an engine whose tool call stays open until the chat has replied. */
export const SEND_TO_CHAT_BLOCKING_DESCRIPTION =
  "Send a message to another chat, by its name or id. The chat's agent receives it as if the user " +
  "had typed it and works on it; the call returns that chat's reply once it has answered.";

export const MANAGER_TOOL_PARAMS = {
  query: 'A few words of the chat name or folder; empty to list recent chats.',
  chat: "The chat's name (as the user said it, or from find_chats) or its id.",
  message: 'What to tell the chat, written as the user would put it to that chat.',
} as const;

export const MANAGER_VOICE_PREAMBLE =
  'You are the Manager: the user is talking to you out loud, on a phone-style call, about their ' +
  'work and their chats. Answer questions yourself from what you know — the conversation so far ' +
  'is above as prior turns — and do the common things directly with your tools, without ' +
  'routing them anywhere. Speak the way a person would on a call: concise, warm, direct.\n\n';

export const MANAGER_TOOLS_RULE =
  `To add a to-do call ${ADD_TASK_TOOL_NAME}; to read the diary call ${CALENDAR_AGENDA_TOOL_NAME}; ` +
  `to book something call ${ADD_EVENT_TOOL_NAME}. A request to log, add or remind is one of these ` +
  `— never go looking for a chat for it. To find a chat call ${FIND_CHATS_TOOL_NAME}; to say how ` +
  `one is getting on call ${CHAT_STATUS_TOOL_NAME}; to tell or ask an existing chat something call ` +
  `${SEND_TO_CHAT_TOOL_NAME} with the chat and the message, phrased for that chat. Only when the ` +
  `user names a chat does it go there. Real work that none of these covers — research, changes, ` +
  `anything needing more than a lookup — call ${ASK_AGENT_TOOL_NAME}. If a chat name could mean ` +
  'more than one chat, the tool says so: ask the user which one, naming the choices. Never guess ' +
  'a chat or invent what one is doing, and never say a task or event was added, or a chat or ' +
  'agent told something, unless the tool returned that it was done. If a tool reports it failed ' +
  'or is not set up, say so plainly. Keep every spoken answer to one or two short sentences.\n\n';

/** The async variant (Gemini): the send is answered at once and the reply arrives later. */
export const MANAGER_ASYNC_REPLY_RULE =
  `${SEND_TO_CHAT_TOOL_NAME} answers as soon as the chat has the message. Say in a few words ` +
  'that it has gone — vary how you say it — then carry on. When the chat answers, its reply ' +
  'arrives as a message naming the chat: tell the user the gist in one or two short sentences, ' +
  'not the whole text, and let them ask for more. Several chats can be working at once. Never say ' +
  '"still waiting" unless the user asks how one is going.\n\n';

/** The blocking variant (OpenAI Realtime, ElevenLabs): the call returns the chat's reply. */
export const MANAGER_BLOCKING_REPLY_RULE =
  `${SEND_TO_CHAT_TOOL_NAME} returns once the chat has answered, which can take a while. When it ` +
  'returns, tell the user the gist of the reply in one or two short sentences, not the whole text, ' +
  'and let them ask for more.\n\n';

/** What one chat's reply looks like to the voice when it arrives as a message. */
export function managerReplyMessage(name: string, message: string, reply: string): string {
  return (
    `The chat "${name}" has answered the message you sent it ("${message}"). ` +
    `Its reply, to tell the user now, in your own words: ${reply}`
  );
}

// ---------------------------------------------------------------------------
// The host side.

/** A name that matches no chat, or more than one: the voice asks the user, nothing failed. */
export class ManagerChatLookupError extends Error {}

/** What the send tells the voice once the chat has the message. */
export interface ManagerSendAccepted {
  name: string;
  /** False for a chat on another host: its reply stays in that chat and does not come back. */
  replyComing: boolean;
}

export interface ManagerVoiceTools {
  /** Run one of {@link MANAGER_QUICK_TOOLS}; rejects when the action failed or is not set up. */
  quick(name: string, args: Record<string, string>): Promise<string>;
  findChats(query: string): Promise<string>;
  chatStatus(chat: string): Promise<string>;
  /**
   * Deliver `message` to the chat named by `chat`. `onAccepted` fires once the
   * chat has it (queued or started); the promise resolves with the chat's reply
   * once its turn settles, or with `reply: null` when no reply can come back
   * (a chat on another host). Rejects with {@link ManagerChatLookupError} when
   * the name does not pick out one chat, and with a plain error when the
   * message was not delivered or the chat's turn failed.
   */
  sendToChat(req: {
    chat: string;
    message: string;
    onAccepted?: (info: ManagerSendAccepted) => void;
  }): Promise<{ name: string; reply: string | null }>;
}

/** One chat as the Manager voice sees it in a listing. */
export interface ManagerChatEntry {
  chatId: string;
  name: string | null;
  folder: string;
  status: string;
  activity?: string;
  lastUpdated?: number;
}

export interface ManagerChatDetail {
  name: string | null;
  status: string | null;
  goal: string | null;
  openTodos: string[];
  turns: Array<{ role: 'user' | 'model'; text: string }>;
}

export interface ManagerVoiceHostDeps {
  logger: Logger;
  /** Every chat the account has (all hosts when the server can be asked). */
  listChats(): Promise<ManagerChatEntry[]>;
  /** True when `chatId` lives on this host. */
  isLocal(chatId: string): boolean;
  /** A chat on this host: what it is and where it stands. */
  chatDetail(chatId: string): ManagerChatDetail;
  /** Deliver a message to a chat on this host; resolves once it is accepted. */
  submitInput(req: { chatId: string; message: string; localId: string }): Promise<void>;
  /** Wait for the turn started by `localId` on `chatId` to settle, with its reply text. */
  awaitReply(chatId: string, localId: string): Promise<string>;
  /** Drop a waiter whose message never went in. */
  abandonReply(chatId: string, err: Error): void;
  /** Deliver a message to a chat on another host. */
  sendRemote(req: { chatId: string; message: string }): Promise<void>;
  /** Add a to-do; resolves with the task as it was filed. Rejects when Todoist is unreachable. */
  addTask(req: { content: string; due: string }): Promise<string>;
  /** Run the calendar tool with these arguments; resolves with its output. */
  calendar(args: string[]): Promise<string>;
  /** Hand a request to the Manager chat's own agent; resolves once it has it. */
  askAgent(request: string): Promise<void>;
  /** A quiet `[call]` line in the Manager chat. */
  recordNote(line: string): void;
  now?: () => number;
}

const LIST_LIMIT = 8;

function displayName(c: ManagerChatEntry): string {
  return c.name?.trim() || c.folder.split('/').filter(Boolean).pop() || c.chatId;
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** The day after a YYYY-MM-DD date: Google's all-day end is exclusive. */
function nextDay(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new ManagerChatLookupError(`"${date}" is not a date.`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

export function createManagerVoiceTools(deps: ManagerVoiceHostDeps): ManagerVoiceTools {
  const now = deps.now ?? Date.now;
  /** Targets with a message out and no reply yet: a second send would cut the first off. */
  const awaiting = new Set<string>();

  const candidates = async (): Promise<ManagerChatEntry[]> =>
    (await deps.listChats()).filter(
      (c) => c.chatId !== MANAGER_CHAT_ID && c.status !== 'archived' && c.status !== 'deleted',
    );

  const line = (c: ManagerChatEntry): string => {
    const parts = [
      c.activity === 'running'
        ? 'working'
        : c.activity === 'awaiting-permission'
          ? 'waiting for permission'
          : c.activity === 'errored'
            ? 'stopped on an error'
            : 'idle',
    ];
    if (c.lastUpdated !== undefined) parts.push(`last active ${ago(now() - c.lastUpdated)}`);
    return `"${displayName(c)}" (id ${c.chatId}) — ${parts.join(', ')}`;
  };

  /** One chat for an id or a spoken name; a lookup error when it is none or several. */
  const resolve = async (chat: string): Promise<ManagerChatEntry> => {
    const all = await candidates();
    const wanted = chat.trim();
    if (wanted === '') throw new ManagerChatLookupError('Say which chat.');
    const byId = all.find((c) => c.chatId === wanted);
    if (byId) return byId;
    const lower = wanted.toLowerCase();
    const exact = all.filter((c) => displayName(c).toLowerCase() === lower);
    if (exact.length === 1) return exact[0]!;
    const terms = words(wanted);
    const partial =
      exact.length > 1
        ? exact
        : all.filter((c) => {
            const hay = words(`${displayName(c)} ${c.folder}`);
            return terms.every((t) => hay.some((w) => w.startsWith(t)));
          });
    if (partial.length === 1) return partial[0]!;
    if (partial.length === 0) {
      throw new ManagerChatLookupError(`No chat matches "${wanted}".`);
    }
    throw new ManagerChatLookupError(
      `Several chats match "${wanted}": ${partial
        .slice(0, LIST_LIMIT)
        .map((c) => `"${displayName(c)}"`)
        .join(', ')}. Ask the user which one.`,
    );
  };

  return {
    async quick(name, args) {
      const need = (k: string): string => {
        const v = (args[k] ?? '').trim();
        if (v === '') throw new ManagerChatLookupError(`Say the ${k.replace('_', ' ')}.`);
        return v;
      };
      if (name === ADD_TASK_TOOL_NAME) {
        const content = need('content');
        const out = await deps.addTask({ content, due: (args['due'] ?? '').trim() });
        deps.recordNote(`task added: ${content}`);
        return out;
      }
      if (name === CALENDAR_AGENDA_TOOL_NAME) {
        const from = (args['from'] ?? '').trim();
        const to = (args['to'] ?? '').trim();
        const q = (args['query'] ?? '').trim();
        const out = await deps.calendar([
          'list',
          ...(from ? ['--from', from] : []),
          ...(to ? ['--to', to] : []),
          ...(q ? ['--q', q] : []),
        ]);
        return out.trim() === '' || out.trim() === '[]' ? 'Nothing in the calendar.' : out;
      }
      if (name === ADD_EVENT_TOOL_NAME) {
        const title = need('title');
        const start = need('start');
        const allDay = (args['all_day'] ?? '').trim().toLowerCase() === 'true';
        const end = (args['end'] ?? '').trim();
        if (!allDay && end === '') {
          throw new ManagerChatLookupError('Say when the event ends, or make it all day.');
        }
        const out = await deps.calendar([
          'create',
          '--title',
          title,
          '--start',
          start,
          '--end',
          end || nextDay(start),
          ...(allDay ? ['--all-day'] : []),
        ]);
        deps.recordNote(`event added: ${title} (${start})`);
        return `Added. ${out}`;
      }
      if (name === ASK_AGENT_TOOL_NAME) {
        const request = need('request');
        await deps.askAgent(request);
        deps.recordNote(`-> agent: ${request}`);
        return 'Passed to the agent. Its result will be in the Manager chat, not read out here.';
      }
      throw new Error(`There is no tool called ${name} on this call.`);
    },

    async findChats(query) {
      const all = await candidates();
      const terms = words(query);
      const scored = all
        .map((c) => {
          const hay = words(`${displayName(c)} ${c.folder}`);
          return { c, score: terms.filter((t) => hay.some((w) => w.startsWith(t))).length };
        })
        .filter((x) => terms.length === 0 || x.score > 0)
        .sort((a, b) => b.score - a.score || (b.c.lastUpdated ?? 0) - (a.c.lastUpdated ?? 0));
      if (scored.length === 0) return `No chat matches "${query}".`;
      return scored
        .slice(0, LIST_LIMIT)
        .map((x) => line(x.c))
        .join('\n');
    },

    async chatStatus(chat) {
      const target = await resolve(chat);
      if (!deps.isLocal(target.chatId)) {
        return `${line(target)}. It is on another computer, so its messages cannot be read from this call.`;
      }
      const d = deps.chatDetail(target.chatId);
      const out = [line(target)];
      if (d.status) out.push(`Where it stands: ${d.status}`);
      if (d.goal) out.push(`Goal: ${d.goal}`);
      if (d.openTodos.length > 0) out.push(`Still to do: ${d.openTodos.slice(0, 6).join('; ')}`);
      const recent = d.turns.slice(-4).map((t) => {
        const flat = t.text.replace(/\s+/g, ' ');
        const short = flat.length > 300 ? `${flat.slice(0, 299).trimEnd()}…` : flat;
        return `${t.role === 'user' ? 'User' : 'Agent'}: ${short}`;
      });
      if (recent.length > 0) out.push(`Last messages:\n${recent.join('\n')}`);
      return out.join('\n');
    },

    async sendToChat({ chat, message, onAccepted }) {
      const target = await resolve(chat);
      const name = displayName(target);
      if (message.trim() === '') throw new ManagerChatLookupError('Say what to tell the chat.');
      if (!deps.isLocal(target.chatId)) {
        await deps.sendRemote({ chatId: target.chatId, message });
        deps.recordNote(`-> "${name}" (on another computer; its reply stays there): ${message}`);
        onAccepted?.({ name, replyComing: false });
        return { name, reply: null };
      }
      if (awaiting.has(target.chatId)) {
        throw new ManagerChatLookupError(
          `"${name}" has not answered the last message yet. Tell the user, and send this once it has.`,
        );
      }
      const localId = `manager-voice-${now()}-${randomUUID().slice(0, 8)}`;
      // Registered before the message goes in, so the reply's first message is not missed.
      const replyPromise = deps.awaitReply(target.chatId, localId);
      // A rejection that lands before we await it below is still handled there.
      replyPromise.catch(() => undefined);
      awaiting.add(target.chatId);
      try {
        await deps.submitInput({ chatId: target.chatId, message, localId });
      } catch (err) {
        awaiting.delete(target.chatId);
        deps.abandonReply(target.chatId, err as Error);
        throw err;
      }
      deps.recordNote(`-> "${name}": ${message}`);
      onAccepted?.({ name, replyComing: true });
      try {
        const reply = await replyPromise;
        deps.recordNote(`<- "${name}": ${reply.trim() === '' ? '(no reply text)' : reply.trim()}`);
        return { name, reply };
      } catch (err) {
        const reason = (err as Error).message;
        deps.logger.error(
          { chatId: target.chatId, err: reason },
          'manager voice: the chat failed to answer',
        );
        deps.recordNote(`<- "${name}": failed: ${reason}`);
        throw err;
      } finally {
        awaiting.delete(target.chatId);
      }
    },
  };
}
