// spec/07 § A call to the Manager — the host side of the Manager voice's tools
// (find a chat, read where it stands, send it a message and wait for its reply)
// and the prompt text the engines are given.

import { describe, test, expect, vi } from 'vitest';
import pino from 'pino';
import {
  createManagerVoiceTools,
  isManagerCall,
  ManagerChatLookupError,
  MANAGER_CHAT_ID,
  SEND_TO_CHAT_TOOL_NAME,
  FIND_CHATS_TOOL_NAME,
  CHAT_STATUS_TOOL_NAME,
  type ManagerChatEntry,
  type ManagerVoiceHostDeps,
} from '../src/audio/managerVoice.js';
import {
  ACKNOWLEDGEMENT_RULE,
  ASYNC_WAIT_RULE,
  DISPATCH_TOOL_NAME,
  WAIT_RULE,
  hostedVoiceInstruction,
  managerHostedInstruction,
} from '../src/audio/gemini-live.js';

const logger = pino({ level: 'silent' });
const NOW = 1_000_000_000_000;

const CHATS: ManagerChatEntry[] = [
  { chatId: MANAGER_CHAT_ID, name: 'Manager', folder: '/t/manager', status: 'active' },
  {
    chatId: 'c-garden',
    name: 'Garden planning',
    folder: '/p/garden',
    status: 'active',
    chatStatus: 'running',
    lastUpdated: NOW - 5 * 60_000,
  },
  {
    chatId: 'c-bus',
    name: 'Bus watcher',
    folder: '/p/bus',
    status: 'active',
    chatStatus: 'idle',
    lastUpdated: NOW - 2 * 3_600_000,
  },
  {
    chatId: 'c-bus2',
    name: 'Bus timetable import',
    folder: '/p/bus-import',
    status: 'active',
    chatStatus: 'idle',
    lastUpdated: NOW - 60_000,
  },
  { chatId: 'c-old', name: 'Old thing', folder: '/p/old', status: 'archived' },
  {
    chatId: 'c-remote',
    name: 'Laptop build',
    folder: '/p/build',
    status: 'active',
    chatStatus: 'idle',
    lastUpdated: NOW - 60_000,
  },
];

function makeHost(overrides: Partial<ManagerVoiceHostDeps> = {}) {
  const notes: string[] = [];
  const order: string[] = [];
  const replies = new Map<string, { resolve: (s: string) => void; reject: (e: Error) => void }>();
  const deps: ManagerVoiceHostDeps = {
    logger,
    now: () => NOW,
    listChats: async () => CHATS,
    isLocal: (id) => id !== 'c-remote',
    chatDetail: () => ({
      name: 'Garden planning',
      status: 'Drafting the planting plan',
      goal: 'A plan for spring',
      openTodos: ['order seeds', 'measure beds'],
      turns: [
        { role: 'user', text: 'what should go in the north bed?' },
        { role: 'model', text: 'Ferns and hostas do well in shade.' },
      ],
    }),
    submitInput: vi.fn(async ({ chatId, localId }) => {
      order.push(`submit:${chatId}:${localId.startsWith('manager-voice-')}`);
    }),
    awaitReply: vi.fn(
      (chatId: string) =>
        new Promise<string>((resolve, reject) => {
          order.push(`await:${chatId}`);
          replies.set(chatId, { resolve, reject });
        }),
    ),
    abandonReply: vi.fn(),
    sendRemote: vi.fn(async () => undefined),
    addTask: vi.fn(async ({ content }) => `Added "${content}".`),
    listTasks: vi.fn(async () => [
      { id: 't1', content: 'salt' },
      { id: 't2', content: 'olive oil' },
      { id: 't3', content: 'sea salt flakes' },
    ]),
    closeTask: vi.fn(async () => undefined),
    deleteTask: vi.fn(async () => undefined),
    calendar: vi.fn(async () => '[{"title":"Dentist"}]'),
    askAgent: vi.fn(async () => undefined),
    timers: vi.fn(async () => 'ok'),
    recordNote: (line) => notes.push(line),
    ...overrides,
  };
  return { deps, notes, order, replies, tools: createManagerVoiceTools(deps) };
}

describe('timer tools', () => {
  test('set_timer asks the server for a timer on the device the call is on', async () => {
    const { deps, tools } = makeHost();
    await tools.quick('set_timer', { seconds: '600', label: 'pasta' }, { deviceId: 'dev-1' });
    expect(deps.timers).toHaveBeenCalledWith({
      action: 'set',
      deviceId: 'dev-1',
      label: 'pasta',
      seconds: 600,
    });
  });

  test('list_timers only reads: it never sets a timer', async () => {
    const { deps, tools } = makeHost();
    await tools.quick('list_timers', {}, { deviceId: 'dev-1' });
    expect(deps.timers).toHaveBeenCalledWith({ action: 'list' });
  });

  test('an alarm time is read as London time, in winter and in summer', async () => {
    const { deps, tools } = makeHost();
    await tools.quick('set_timer', { at: '2026-12-01T07:00:00' }, {});
    await tools.quick('set_timer', { at: '2026-07-01T07:00:00' }, {});
    const calls = (deps.timers as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { at: number }).at,
    );
    expect(new Date(calls[0]!).toISOString()).toBe('2026-12-01T07:00:00.000Z');
    expect(new Date(calls[1]!).toISOString()).toBe('2026-07-01T06:00:00.000Z');
  });

  test('change_timer needs an amount, and cancel_timer passes the name through', async () => {
    const { deps, tools } = makeHost();
    await expect(tools.quick('change_timer', { timer: 'pasta' })).rejects.toThrow(
      /how much to add/,
    );
    await tools.quick('change_timer', { timer: 'pasta', add_seconds: '120' });
    await tools.quick('cancel_timer', { timer: 'pasta' });
    expect(deps.timers).toHaveBeenCalledWith({ action: 'change', timer: 'pasta', addSeconds: 120 });
    expect(deps.timers).toHaveBeenCalledWith({ action: 'cancel', timer: 'pasta' });
  });

  test('set_timer with no time is refused before the server is asked', async () => {
    const { deps, tools } = makeHost();
    await expect(tools.quick('set_timer', { label: 'x' })).rejects.toBeInstanceOf(
      ManagerChatLookupError,
    );
    expect(deps.timers).not.toHaveBeenCalled();
  });
});

describe('isManagerCall', () => {
  test('only the Manager chat', () => {
    expect(isManagerCall(MANAGER_CHAT_ID)).toBe(true);
    expect(isManagerCall('thread_speakers')).toBe(false);
    expect(isManagerCall('c-garden')).toBe(false);
  });
});

describe('find_chats', () => {
  test('an empty query lists the most recent chats, never the Manager or archived ones', async () => {
    const { tools } = makeHost();
    const out = await tools.findChats('');
    expect(out).not.toContain(MANAGER_CHAT_ID);
    expect(out).not.toContain('Old thing');
    const lines = out.split('\n');
    expect(lines[0]).toContain('Bus timetable import');
    expect(out).toContain('"Garden planning" (id c-garden) — working, last active 5 min ago');
    expect(out).toContain('"Bus watcher" (id c-bus) — idle, last active 2 h ago');
  });

  test('a query keeps the chats whose name or folder matches', async () => {
    const { tools } = makeHost();
    const out = await tools.findChats('bus');
    expect(out.split('\n')).toHaveLength(2);
    expect(out).not.toContain('Garden');
    expect(await tools.findChats('zebra')).toBe('No chat matches "zebra".');
  });

  test('a list the host cannot get is an error, not an empty answer', async () => {
    const { tools } = makeHost({
      listChats: async () => {
        throw new Error('the server link is offline');
      },
    });
    await expect(tools.findChats('')).rejects.toThrow('offline');
  });
});

describe('chat_status', () => {
  test('a chat on this host: status, goal, to-dos and the last messages', async () => {
    const { tools } = makeHost();
    const out = await tools.chatStatus('garden');
    expect(out).toContain('Where it stands: Drafting the planting plan');
    expect(out).toContain('Goal: A plan for spring');
    expect(out).toContain('Still to do: order seeds; measure beds');
    expect(out).toContain('Agent: Ferns and hostas do well in shade.');
  });

  test('a chat on another host says what can and cannot be read', async () => {
    const { tools } = makeHost();
    const out = await tools.chatStatus('c-remote');
    expect(out).toContain('"Laptop build"');
    expect(out).toContain('on another computer');
  });

  test('a name that fits several chats asks which, naming them', async () => {
    const { tools } = makeHost();
    const err = await tools.chatStatus('bus').catch((e: Error) => e);
    expect(err).toBeInstanceOf(ManagerChatLookupError);
    expect((err as Error).message).toContain('"Bus watcher"');
    expect((err as Error).message).toContain('"Bus timetable import"');
  });

  test('an exact name wins over a partial match', async () => {
    const { tools } = makeHost();
    expect(await tools.chatStatus('Bus watcher')).toContain('(id c-bus)');
  });

  test('no match is a lookup error', async () => {
    const { tools } = makeHost();
    await expect(tools.chatStatus('zebra')).rejects.toBeInstanceOf(ManagerChatLookupError);
  });
});

describe('send_to_chat', () => {
  test('registers for the reply before the message goes in, then returns the reply and records both', async () => {
    const { tools, notes, order, replies, deps } = makeHost();
    const accepted = vi.fn();
    const p = tools.sendToChat({
      chat: 'garden',
      message: 'use ferns in the north bed',
      onAccepted: accepted,
    });
    await vi.waitFor(() => expect(accepted).toHaveBeenCalled());
    expect(order).toEqual(['await:c-garden', 'submit:c-garden:true']);
    expect(accepted).toHaveBeenCalledWith({ name: 'Garden planning', replyComing: true });
    const sent = vi.mocked(deps.submitInput).mock.calls[0]![0];
    const awaited = vi.mocked(deps.awaitReply).mock.calls[0]!;
    expect(awaited[1]).toBe(sent.localId);
    expect(sent.message).toBe('use ferns in the north bed');
    expect(notes).toEqual(['-> "Garden planning": use ferns in the north bed']);
    replies.get('c-garden')!.resolve('Done, ferns are in the plan.');
    await expect(p).resolves.toEqual({
      name: 'Garden planning',
      reply: 'Done, ferns are in the plan.',
    });
    expect(notes[1]).toBe('<- "Garden planning": Done, ferns are in the plan.');
  });

  test('a second message to a chat still answering the first is refused, not lost', async () => {
    const { tools, replies, deps } = makeHost();
    const first = tools.sendToChat({ chat: 'garden', message: 'one' });
    await vi.waitFor(() => expect(replies.has('c-garden')).toBe(true));
    await expect(tools.sendToChat({ chat: 'garden', message: 'two' })).rejects.toBeInstanceOf(
      ManagerChatLookupError,
    );
    replies.get('c-garden')!.resolve('ok');
    await first;
    replies.delete('c-garden');
    // Once answered, the chat can be sent to again.
    const third = tools.sendToChat({ chat: 'garden', message: 'three' });
    await vi.waitFor(() => expect(replies.get('c-garden')).toBeDefined());
    replies.get('c-garden')!.resolve('ok again');
    await expect(third).resolves.toMatchObject({ reply: 'ok again' });
    expect(deps.submitInput).toHaveBeenCalledTimes(2);
  });

  test('a message the chat never took drops the waiter and fails loudly, recording nothing', async () => {
    const { tools, notes, deps } = makeHost({
      submitInput: vi.fn(async () => {
        throw new Error('chat is moving');
      }),
    });
    const accepted = vi.fn();
    await expect(
      tools.sendToChat({ chat: 'garden', message: 'x', onAccepted: accepted }),
    ).rejects.toThrow('chat is moving');
    expect(accepted).not.toHaveBeenCalled();
    expect(deps.abandonReply).toHaveBeenCalledWith('c-garden', expect.any(Error));
    expect(notes).toEqual([]);
  });

  test('a chat whose turn fails is recorded as failed in the Manager chat', async () => {
    const { tools, notes, replies } = makeHost();
    const p = tools.sendToChat({ chat: 'garden', message: 'x' });
    await vi.waitFor(() => expect(notes).toHaveLength(1));
    replies.get('c-garden')!.reject(new Error('rate limited'));
    await expect(p).rejects.toThrow('rate limited');
    expect(notes[1]).toBe('<- "Garden planning": failed: rate limited');
  });

  test('a chat on another host is sent to, and says no reply will come back', async () => {
    const { tools, notes, deps } = makeHost();
    const accepted = vi.fn();
    await expect(
      tools.sendToChat({ chat: 'laptop build', message: 'run the tests', onAccepted: accepted }),
    ).resolves.toEqual({ name: 'Laptop build', reply: null });
    expect(deps.sendRemote).toHaveBeenCalledWith({ chatId: 'c-remote', message: 'run the tests' });
    expect(deps.submitInput).not.toHaveBeenCalled();
    expect(accepted).toHaveBeenCalledWith({ name: 'Laptop build', replyComing: false });
    expect(notes[0]).toContain('on another computer');
  });

  test('an ambiguous name sends nothing', async () => {
    const { tools, deps } = makeHost();
    await expect(tools.sendToChat({ chat: 'bus', message: 'x' })).rejects.toBeInstanceOf(
      ManagerChatLookupError,
    );
    expect(deps.submitInput).not.toHaveBeenCalled();
    expect(deps.awaitReply).not.toHaveBeenCalled();
  });
});

describe('prompts', () => {
  test('the Manager instruction names its tools and never the hand-off tool', () => {
    for (const asyncResult of [true, false]) {
      const text = managerHostedInstruction(asyncResult);
      expect(text).toContain(SEND_TO_CHAT_TOOL_NAME);
      expect(text).toContain(FIND_CHATS_TOOL_NAME);
      expect(text).toContain(CHAT_STATUS_TOOL_NAME);
      expect(text).not.toContain(DISPATCH_TOOL_NAME);
    }
    expect(managerHostedInstruction(true)).toContain('arrives as a message');
    expect(managerHostedInstruction(false)).toContain('returns once the chat has answered');
  });

  test('the account’s voice prompt replaces the built-in one; the tool rules stay', () => {
    const custom = 'You are my assistant. Answer questions yourself when you can.';
    for (const asyncResult of [true, false]) {
      const text = managerHostedInstruction(asyncResult, custom);
      expect(text.startsWith(custom)).toBe(true);
      expect(text).not.toContain('You are the Manager');
      expect(text).toContain(SEND_TO_CHAT_TOOL_NAME);
    }
    // Blank falls back to the built-in text rather than leaving the voice with no identity.
    expect(managerHostedInstruction(false, '  ')).toContain('You are the Manager');
  });

  test('the acknowledgement before a hand-off varies and is skipped when the answer is quick', () => {
    expect(ACKNOWLEDGEMENT_RULE).toMatch(/vary/);
    expect(ACKNOWLEDGEMENT_RULE).toMatch(/Skip it when the answer will be quick/);
    expect(ACKNOWLEDGEMENT_RULE).toMatch(/not always "one sec"/);
    expect(WAIT_RULE).toContain(ACKNOWLEDGEMENT_RULE);
    expect(ASYNC_WAIT_RULE).toContain(ACKNOWLEDGEMENT_RULE);
    expect(hostedVoiceInstruction('auto')).toContain(ACKNOWLEDGEMENT_RULE);
    expect(hostedVoiceInstruction('auto', true)).toContain(ACKNOWLEDGEMENT_RULE);
    // The old fixed phrase is no longer the instruction.
    expect(WAIT_RULE).not.toMatch(/Say at most one brief acknowledgement out loud \("one sec"\)/);
  });
});

describe('quick tools (a Manager call acts directly)', () => {
  test('add_task files the task with its due date and records it', async () => {
    const { deps, tools, notes } = makeHost();
    const out = await tools.quick('add_task', { content: 'take the bins out', due: 'tomorrow' });
    expect(deps.addTask).toHaveBeenCalledWith({
      content: 'take the bins out',
      due: 'tomorrow',
      project: '',
    });
    expect(out).toContain('take the bins out');
    expect(notes).toContain('task added: take the bins out');
  });

  test('add_task without content asks rather than filing an empty task', async () => {
    const { deps, tools } = makeHost();
    await expect(tools.quick('add_task', { content: '  ' })).rejects.toBeInstanceOf(
      ManagerChatLookupError,
    );
    expect(deps.addTask).not.toHaveBeenCalled();
  });

  test('add_task passes the list it belongs on', async () => {
    const { deps, tools } = makeHost();
    await tools.quick('add_task', { content: 'salt', project: 'Groceries' });
    expect(deps.addTask).toHaveBeenCalledWith({ content: 'salt', due: '', project: 'Groceries' });
  });

  test('complete_task ticks off the one task that matches, by id', async () => {
    const { deps, tools, notes } = makeHost();
    const out = await tools.quick('complete_task', { task: 'olive', project: 'Groceries' });
    expect(deps.listTasks).toHaveBeenCalledWith('Groceries');
    expect(deps.closeTask).toHaveBeenCalledWith('t2');
    expect(out).toContain('olive oil');
    expect(notes).toContain('task ticked off: olive oil');
  });

  test('an exact name wins over a longer one that also matches', async () => {
    const { deps, tools } = makeHost();
    await tools.quick('complete_task', { task: 'Salt' });
    expect(deps.closeTask).toHaveBeenCalledWith('t1');
  });

  test('a task name that matches several asks which, and changes nothing', async () => {
    const { deps, tools } = makeHost({
      listTasks: async () => [
        { id: 'a', content: 'sea salt' },
        { id: 'b', content: 'salt and vinegar crisps' },
      ],
    });
    await expect(tools.quick('remove_task', { task: 'salt' })).rejects.toThrow(/Several tasks/);
    expect(deps.deleteTask).not.toHaveBeenCalled();
    expect(deps.closeTask).not.toHaveBeenCalled();
  });

  test('a task name that matches nothing says so', async () => {
    const { deps, tools } = makeHost();
    await expect(tools.quick('complete_task', { task: 'caviar' })).rejects.toBeInstanceOf(
      ManagerChatLookupError,
    );
    expect(deps.closeTask).not.toHaveBeenCalled();
  });

  test('remove_task deletes the matching task by id and records it', async () => {
    const { deps, tools, notes } = makeHost();
    const out = await tools.quick('remove_task', { task: 'olive oil' });
    expect(deps.deleteTask).toHaveBeenCalledWith('t2');
    expect(out).toContain('Removed');
    expect(notes).toContain('task removed: olive oil');
  });

  test('read_project reads the open tasks, and says so when there are none', async () => {
    const { tools } = makeHost();
    expect(await tools.quick('read_project', { project: 'Groceries' })).toBe(
      '"Groceries" has 3 open: salt; olive oil; sea salt flakes.',
    );
    const empty = makeHost({ listTasks: async () => [] });
    expect(await empty.tools.quick('read_project', { project: 'Groceries' })).toContain('no open');
    await expect(tools.quick('read_project', { project: ' ' })).rejects.toBeInstanceOf(
      ManagerChatLookupError,
    );
  });

  test('a failing task add is an error, not a silent success', async () => {
    const { tools, notes } = makeHost({
      addTask: async () => {
        throw new Error('The to-do list did not answer: offline');
      },
    });
    await expect(tools.quick('add_task', { content: 'x' })).rejects.toThrow('offline');
    expect(notes).toEqual([]);
  });

  test('calendar_agenda lists with the range, and says so when empty', async () => {
    const { deps, tools } = makeHost();
    await tools.quick('calendar_agenda', { from: '2026-12-01', to: '2026-12-02', query: 'dent' });
    expect(deps.calendar).toHaveBeenCalledWith([
      'list',
      '--from',
      '2026-12-01',
      '--to',
      '2026-12-02',
      '--q',
      'dent',
    ]);
    const empty = makeHost({ calendar: async () => '[]' });
    expect(await empty.tools.quick('calendar_agenda', {})).toBe('Nothing in the calendar.');
  });

  test('add_event creates a timed event, and an all-day one ends the next day', async () => {
    const { deps, tools } = makeHost();
    await tools.quick('add_event', {
      title: 'Dentist',
      start: '2026-12-01T14:00:00',
      end: '2026-12-01T15:00:00',
    });
    expect(deps.calendar).toHaveBeenLastCalledWith([
      'create',
      '--title',
      'Dentist',
      '--start',
      '2026-12-01T14:00:00',
      '--end',
      '2026-12-01T15:00:00',
    ]);
    await tools.quick('add_event', { title: 'Holiday', start: '2026-12-31', all_day: 'true' });
    expect(deps.calendar).toHaveBeenLastCalledWith([
      'create',
      '--title',
      'Holiday',
      '--start',
      '2026-12-31',
      '--end',
      '2027-01-01',
      '--all-day',
    ]);
    await expect(
      tools.quick('add_event', { title: 'Dentist', start: '2026-12-01T14:00:00' }),
    ).rejects.toBeInstanceOf(ManagerChatLookupError);
  });

  test('ask_agent hands the request to the Manager agent and returns at once', async () => {
    const { deps, tools } = makeHost();
    const out = await tools.quick('ask_agent', { request: 'research heat pumps' });
    expect(deps.askAgent).toHaveBeenCalledWith('research heat pumps');
    expect(out).toContain('Passed to the agent');
  });

  test('an unknown tool is refused', async () => {
    const { tools } = makeHost();
    await expect(tools.quick('nope', {})).rejects.toThrow('no tool called nope');
  });
});
