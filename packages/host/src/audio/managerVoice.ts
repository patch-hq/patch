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
import { DEFAULT_MANAGER_VOICE_PROMPT } from '@patch/wire';
import { CHAT_STATUS_TOOL_NAME, FIND_CHATS_TOOL_NAME } from './voiceAgent.js';
import {
  ChatLookupError,
  LIST_LIMIT,
  MANAGER_CHAT_ID,
  displayName,
  words,
  type ChatLookup,
} from './chatLookup.js';

const READ_LIMIT = 25;

export const SEND_TO_CHAT_TOOL_NAME = 'send_to_chat';

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
export const COMPLETE_TASK_TOOL_NAME = 'complete_task';
export const REMOVE_TASK_TOOL_NAME = 'remove_task';
export const READ_PROJECT_TOOL_NAME = 'read_project';
export const CALENDAR_AGENDA_TOOL_NAME = 'calendar_agenda';
export const ADD_EVENT_TOOL_NAME = 'add_event';
export const ASK_AGENT_TOOL_NAME = 'ask_agent';
export const SET_TIMER_TOOL_NAME = 'set_timer';
export const CANCEL_TIMER_TOOL_NAME = 'cancel_timer';
export const CHANGE_TIMER_TOOL_NAME = 'change_timer';
export const LIST_TIMERS_TOOL_NAME = 'list_timers';

export const MANAGER_QUICK_TOOLS: readonly ManagerQuickTool[] = [
  {
    name: ADD_TASK_TOOL_NAME,
    description:
      "Add a task to the user's to-do list (Todoist). Answers at once. Use it for anything like " +
      '"log a task", "remind me to", "add to my list".',
    params: {
      content: 'The task, as a short phrase.',
      due: 'When it is due, in plain words ("tomorrow", "friday", "2026-12-01"); empty for none.',
      project: 'The list it belongs on ("Groceries"), as the user said it; empty for the Inbox.',
    },
    required: ['content'],
  },
  {
    name: COMPLETE_TASK_TOOL_NAME,
    description:
      "Tick off a task in the user's to-do list (Todoist) by a few words of its text. Answers at " +
      'once. If several tasks match it says so: ask the user which.',
    params: {
      task: 'A few words of the task text.',
      project: 'The list it is on, as the user said it; empty to look in every list.',
    },
    required: ['task'],
  },
  {
    name: REMOVE_TASK_TOOL_NAME,
    description:
      "Delete a task from the user's to-do list (Todoist) by a few words of its text, when the " +
      'user asks to remove it. A finished task is complete_task instead. Answers at once.',
    params: {
      task: 'A few words of the task text.',
      project: 'The list it is on, as the user said it; empty to look in every list.',
    },
    required: ['task'],
  },
  {
    name: READ_PROJECT_TOOL_NAME,
    description:
      "Read out the open tasks on one of the user's to-do lists (Todoist), such as Groceries. " +
      'Answers at once.',
    params: { project: 'The list name, as the user said it.' },
    required: ['project'],
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
    name: SET_TIMER_TOOL_NAME,
    description:
      'Start a timer ("ten minutes") or set an alarm ("for 7am"). Patch keeps it and rings it ' +
      'when it is done, even after this conversation ends. Give seconds for a timer, or at for ' +
      'an alarm. Never use it to ask how a timer is going: that is list_timers.',
    params: {
      seconds: 'How long, in whole seconds (ten minutes is 600); empty for an alarm.',
      at: 'For an alarm: the time, London local, ISO (2026-12-01T07:00:00); empty for a timer.',
      label: 'What it is for ("pasta"); empty if the user did not say.',
    },
    required: [],
  },
  {
    name: LIST_TIMERS_TOOL_NAME,
    description:
      'Read the timers and alarms that are set and how long each has left. Answers at once. ' +
      'Use it for "how are my timers", "how long is left", "what timers do I have". It sets nothing.',
    params: {},
    required: [],
  },
  {
    name: CANCEL_TIMER_TOOL_NAME,
    description:
      'Cancel a timer or alarm, or stop one that is ringing. Say which by its label or id; ' +
      'empty when there is only one.',
    params: { timer: "The timer's label or id; empty when there is only one." },
    required: [],
  },
  {
    name: CHANGE_TIMER_TOOL_NAME,
    description:
      'Change a running timer: add or take off time, or set a new time left. Give add_seconds ' +
      'or set_seconds.',
    params: {
      timer: "The timer's label or id; empty when there is only one.",
      add_seconds: 'Seconds to add; negative to take off ("two more minutes" is 120).',
      set_seconds: 'Make it this many seconds from now, replacing the time left.',
    },
    required: [],
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

export const SEND_TO_CHAT_DESCRIPTION =
  "Send a message to another chat, by its name or id. The chat's agent receives it as if the user " +
  'had typed it and works on it. Its reply comes back to you later as a message; meanwhile carry ' +
  'on the conversation.';

/** The same, for an engine whose tool call stays open until the chat has replied. */
export const SEND_TO_CHAT_BLOCKING_DESCRIPTION =
  "Send a message to another chat, by its name or id. The chat's agent receives it as if the user " +
  "had typed it and works on it; the call returns that chat's reply once it has answered.";

export const MANAGER_TOOL_PARAMS = {
  chat: "The chat's name (as the user said it, or from find_chats) or its id.",
  message: 'What to tell the chat, written as the user would put it to that chat.',
} as const;

/** The built-in voice prompt; Settings → Manager can replace it (`managerVoicePrompt`). */
/**
 * The Manager voice's rule for a speaker who pauses mid-sentence. (An ordinary
 * call's voice agent is told only the user's voice instructions; spec/07 §
 * Voice instructions.)
 */
export const FRAGMENT_RULE =
  'The user often pauses mid-sentence ("uh", "um", "so basically"). If what you heard is an ' +
  'unfinished sentence, a fragment, or ends on a filler word or a dangling clause, it is not a ' +
  'full request yet: say nothing and wait for the rest. Only respond once the request is ' +
  'complete, and never ask "what do you mean?" about half a sentence.\n\n';

/**
 * The brief acknowledgement before a Manager tool that takes a while. Useful
 * when the answer is a while coming, grating when it is the same two words
 * every time or comes in front of an answer that was going to be instant.
 */
export const ACKNOWLEDGEMENT_RULE =
  'A brief acknowledgement before a hand-off is optional. Skip it when the answer will be quick — ' +
  'a short look-up, or a tool that answers at once — and just give the answer. When you do say ' +
  'one, keep it to a few words and vary it: never the same words twice in a row, and not always ' +
  '"one sec" (for instance "let me check", "on it", "I\'ll find out", "give me a moment", or just ' +
  '"okay"). ';

export const MANAGER_VOICE_PREAMBLE = `${DEFAULT_MANAGER_VOICE_PROMPT}\n\n`;

export const MANAGER_TOOLS_RULE =
  `To add a to-do call ${ADD_TASK_TOOL_NAME} (with the list when the user names one); to tick one ` +
  `off call ${COMPLETE_TASK_TOOL_NAME}; to delete one call ${REMOVE_TASK_TOOL_NAME}; to hear a ` +
  `list call ${READ_PROJECT_TOOL_NAME}; to read the diary call ${CALENDAR_AGENDA_TOOL_NAME}; ` +
  `to book something call ${ADD_EVENT_TOOL_NAME}; for a timer or alarm call ${SET_TIMER_TOOL_NAME}, ` +
  `and to hear how the timers are going call ${LIST_TIMERS_TOOL_NAME} — asking about a timer never ` +
  `sets a new one. A request to log, add or remind is one of these ` +
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
  'not the whole text, and let them ask for more. If the reply is only a receipt — the chat saying ' +
  'it has passed the request on or sent it to another chat, with no answer in it — say nothing: ' +
  'you have already told the user it has gone. Several chats can be working at once. Never say ' +
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
    `Its reply, to tell the user now, in your own words (if it is only a receipt that the request ` +
    `was passed on or sent elsewhere, with no answer, say nothing): ${reply}`
  );
}

// ---------------------------------------------------------------------------
// The host side.

/** What the send tells the voice once the chat has the message. */
export interface ManagerSendAccepted {
  name: string;
}

/** Where a quick tool was called from. */
export interface ManagerQuickContext {
  /** The voice device the conversation is on; absent for an app call. */
  deviceId?: string;
}

/** A timer action as the host asks the server to carry it out (the server keeps the state). */
export interface ManagerTimerRequest {
  action: 'set' | 'cancel' | 'change' | 'list';
  deviceId?: string;
  label?: string;
  seconds?: number;
  at?: number;
  timer?: string;
  setSeconds?: number;
  addSeconds?: number;
}

export interface ManagerVoiceTools {
  /** Who the voice is told it is (`host.settings` → `managerVoicePrompt`). Absent: the built-in text. */
  voicePrompt?: () => string;
  /** Run one of {@link MANAGER_QUICK_TOOLS}; rejects when the action failed or is not set up. */
  quick(name: string, args: Record<string, string>, ctx?: ManagerQuickContext): Promise<string>;
  /**
   * Deliver `message` to the chat named by `chat`. `onAccepted` fires once the
   * chat has it (queued or started); the promise resolves with the chat's reply
   * once its turn settles, whichever host the chat is on. Rejects with
   * {@link ChatLookupError} when
   * the name does not pick out one chat, and with a plain error when the
   * message was not delivered or the chat's turn failed.
   */
  sendToChat(req: {
    chat: string;
    message: string;
    onAccepted?: (info: ManagerSendAccepted) => void;
  }): Promise<{ name: string; reply: string }>;
}

export interface ManagerVoiceHostDeps {
  logger: Logger;
  /** Finding and resolving chats: the lookup every call shares (chatLookup.ts). */
  lookup: ChatLookup;
  /** Deliver a message as `patch_send_to` does; resolves once the chat has it. */
  deliver(req: { chatId: string; message: string; localId: string }): Promise<void>;
  /** The chat's reply to the message delivered as `localId`, read by the server from its record. */
  awaitReply(req: { chatId: string; localId: string }): Promise<string>;
  /** Add a to-do; resolves with the task as it was filed. Rejects when Todoist is unreachable. */
  addTask(req: { content: string; due: string; project: string }): Promise<string>;
  /** Open to-dos, on one project or (empty name) across all. Rejects when the project is unknown. */
  listTasks(project: string): Promise<Array<{ id: string; content: string }>>;
  /** Tick one to-do off, or delete it; resolve once Todoist has done it. */
  closeTask(id: string): Promise<void>;
  deleteTask(id: string): Promise<void>;
  /** Run the calendar tool with these arguments; resolves with its output. */
  calendar(args: string[]): Promise<string>;
  /** Timers and alarms live on the server; resolves with what to tell the user, rejects on a refusal. */
  timers(req: ManagerTimerRequest): Promise<string>;
  /** Hand a request to the Manager chat's own agent; resolves once it has it. */
  askAgent(request: string): Promise<void>;
  /** A quiet `[call]` line in the Manager chat. */
  recordNote(line: string): void;
  /** The account's Manager voice prompt, read at the start of each call. */
  voicePrompt?: () => string;
  now?: () => number;
}

/** The day after a YYYY-MM-DD date: Google's all-day end is exclusive. */
function nextDay(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new ChatLookupError(`"${date}" is not a date.`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** A number the voice passed as text; a lookup error when it is not one. */
function seconds(args: Record<string, string>, key: string): number | undefined {
  const raw = (args[key] ?? '').trim();
  if (raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ChatLookupError(`"${raw}" is not a number of seconds.`);
  return n;
}

function timerRequest(
  name: string,
  args: Record<string, string>,
  deviceId: string | undefined,
): ManagerTimerRequest {
  const timer = (args['timer'] ?? '').trim();
  if (name === LIST_TIMERS_TOOL_NAME) return { action: 'list' };
  if (name === CANCEL_TIMER_TOOL_NAME) return { action: 'cancel', timer };
  if (name === CHANGE_TIMER_TOOL_NAME) {
    const add = seconds(args, 'add_seconds');
    const set = seconds(args, 'set_seconds');
    if (add === undefined && set === undefined) {
      throw new ChatLookupError('Say how much to add, or the new time left.');
    }
    return {
      action: 'change',
      timer,
      ...(add !== undefined ? { addSeconds: add } : {}),
      ...(set !== undefined ? { setSeconds: set } : {}),
    };
  }
  const secs = seconds(args, 'seconds');
  const atRaw = (args['at'] ?? '').trim();
  let at: number | undefined;
  if (atRaw !== '') {
    // London local time; Date.parse of a zone-less ISO string would use the host's zone.
    at = londonToEpoch(atRaw);
  }
  if (secs === undefined && at === undefined) {
    throw new ChatLookupError('Say how long the timer is, or what time the alarm is for.');
  }
  const label = (args['label'] ?? '').trim();
  return {
    action: 'set',
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(label !== '' ? { label } : {}),
    ...(at !== undefined ? { at } : { seconds: secs! }),
  };
}

/** An ISO date-time with no zone, read as Europe/London. */
export function londonToEpoch(iso: string): number {
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(iso)) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) throw new ChatLookupError(`"${iso}" is not a time.`);
    return t;
  }
  const asUtc = Date.parse(`${iso}Z`);
  if (Number.isNaN(asUtc)) throw new ChatLookupError(`"${iso}" is not a time.`);
  // London's offset at that wall-clock moment (0 or 1 hour): format the UTC guess in London and diff.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(asUtc));
  const get = (t: string): string => parts.find((p) => p.type === t)!.value;
  const shown = Date.parse(
    `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`,
  );
  return asUtc - (shown - asUtc);
}

export function createManagerVoiceTools(deps: ManagerVoiceHostDeps): ManagerVoiceTools {
  const now = deps.now ?? Date.now;
  /** Targets with a message out and no reply yet: a second send would cut the first off. */
  const awaiting = new Set<string>();

  return {
    ...(deps.voicePrompt ? { voicePrompt: deps.voicePrompt } : {}),
    async quick(name, args, ctx) {
      const need = (k: string): string => {
        const v = (args[k] ?? '').trim();
        if (v === '') throw new ChatLookupError(`Say the ${k.replace('_', ' ')}.`);
        return v;
      };
      if (name === ADD_TASK_TOOL_NAME) {
        const content = need('content');
        const out = await deps.addTask({
          content,
          due: (args['due'] ?? '').trim(),
          project: (args['project'] ?? '').trim(),
        });
        deps.recordNote(`task added: ${content}`);
        return out;
      }
      if (name === COMPLETE_TASK_TOOL_NAME || name === REMOVE_TASK_TOOL_NAME) {
        const wanted = need('task');
        const project = (args['project'] ?? '').trim();
        const tasks = await deps.listTasks(project);
        const where = project === '' ? '' : ` on "${project}"`;
        const lower = wanted.toLowerCase();
        const exact = tasks.filter((t) => t.content.toLowerCase() === lower);
        const terms = words(wanted);
        const found =
          exact.length > 0
            ? exact
            : tasks.filter((t) => {
                const hay = words(t.content);
                return terms.every((w) => hay.some((h) => h.startsWith(w)));
              });
        if (found.length === 0)
          throw new ChatLookupError(`No open task${where} matches "${wanted}".`);
        if (found.length > 1) {
          throw new ChatLookupError(
            `Several tasks${where} match "${wanted}": ${found
              .slice(0, LIST_LIMIT)
              .map((t) => `"${t.content}"`)
              .join(', ')}. Ask the user which one.`,
          );
        }
        const task = found[0]!;
        if (name === COMPLETE_TASK_TOOL_NAME) {
          await deps.closeTask(task.id);
          deps.recordNote(`task ticked off: ${task.content}`);
          return `Ticked off "${task.content}".`;
        }
        await deps.deleteTask(task.id);
        deps.recordNote(`task removed: ${task.content}`);
        return `Removed "${task.content}".`;
      }
      if (name === READ_PROJECT_TOOL_NAME) {
        const project = need('project');
        const tasks = await deps.listTasks(project);
        if (tasks.length === 0) return `"${project}" has no open tasks.`;
        const shown = tasks.slice(0, READ_LIMIT).map((t) => t.content);
        const more = tasks.length > READ_LIMIT ? ` (and ${tasks.length - READ_LIMIT} more)` : '';
        return `"${project}" has ${tasks.length} open: ${shown.join('; ')}${more}.`;
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
          throw new ChatLookupError('Say when the event ends, or make it all day.');
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
      if (
        name === SET_TIMER_TOOL_NAME ||
        name === LIST_TIMERS_TOOL_NAME ||
        name === CANCEL_TIMER_TOOL_NAME ||
        name === CHANGE_TIMER_TOOL_NAME
      ) {
        return deps.timers(timerRequest(name, args, ctx?.deviceId));
      }
      if (name === ASK_AGENT_TOOL_NAME) {
        const request = need('request');
        await deps.askAgent(request);
        deps.recordNote(`-> agent: ${request}`);
        return 'Passed to the agent. Its result will be in the Manager chat, not read out here.';
      }
      throw new Error(`There is no tool called ${name} on this call.`);
    },

    async sendToChat({ chat, message, onAccepted }) {
      const target = await deps.lookup.resolve(chat, MANAGER_CHAT_ID);
      const name = displayName(target);
      if (message.trim() === '') throw new ChatLookupError('Say what to tell the chat.');
      if (awaiting.has(target.chatId)) {
        throw new ChatLookupError(
          `"${name}" has not answered the last message yet. Tell the user, and send this once it has.`,
        );
      }
      const localId = `manager-voice-${now()}-${randomUUID().slice(0, 8)}`;
      awaiting.add(target.chatId);
      try {
        await deps.deliver({ chatId: target.chatId, message, localId });
      } catch (err) {
        awaiting.delete(target.chatId);
        throw err;
      }
      deps.recordNote(
        target.status === 'archived'
          ? `-> "${name}" (was archived; this brings it back): ${message}`
          : `-> "${name}": ${message}`,
      );
      onAccepted?.({ name });
      try {
        // Read from the server's record by the message's own id, so it is this
        // message's reply even when the chat was busy and took it later.
        const reply = await deps.awaitReply({ chatId: target.chatId, localId });
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

/**
 * The voice's instructions on a call to the Manager (spec/07 § A call to the
 * Manager). `asyncResult`: a chat's reply arrives later as a message (Gemini)
 * rather than as the send tool's own return (OpenAI Realtime, ElevenLabs).
 */
export function managerHostedInstruction(asyncResult: boolean, voicePrompt?: string): string {
  const preamble = voicePrompt?.trim() ? `${voicePrompt.trim()}\n\n` : MANAGER_VOICE_PREAMBLE;
  return (
    preamble +
    FRAGMENT_RULE +
    MANAGER_TOOLS_RULE +
    ACKNOWLEDGEMENT_RULE +
    '\n\n' +
    (asyncResult ? MANAGER_ASYNC_REPLY_RULE : MANAGER_BLOCKING_REPLY_RULE)
  ).trimEnd();
}

/** Added to a chat's reply on a Manager call so the voice gives the gist rather than reading it out. */
export const RESULT_GIST_NOTE =
  '(Give the user the gist of this in one short sentence; do not read it out.)\n\n';
