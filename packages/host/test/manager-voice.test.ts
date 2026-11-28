// spec/07 § A call to the Manager — the host side of the Manager voice's tools
// (find a chat, read where it stands, quick actions)
// and the prompt text the engines are given.

import { describe, test, expect, vi } from 'vitest';
import pino from 'pino';
import {
  createManagerVoiceTools,
  ACKNOWLEDGEMENT_RULE,
  managerHostedInstruction,
  type ManagerVoiceHostDeps,
} from '../src/audio/managerVoice.js';
import {
  CHAT_STATUS_TOOL_NAME,
  FIND_CHATS_TOOL_NAME,
  PASS_TO_AGENT_TOOL_NAME,
  SEND_TO_CHAT_TOOL_NAME,
} from '../src/audio/voiceAgent.js';
import {
  ChatLookupError,
  createChatLookup,
  isManagerCall,
  MANAGER_CHAT_ID,
  type ChatEntry,
} from '../src/audio/chatLookup.js';

const logger = pino({ level: 'silent' });
const NOW = 1_000_000_000_000;

const CHATS: ChatEntry[] = [
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
  const deps: ManagerVoiceHostDeps = {
    logger,
    lookup: createChatLookup({
      now: () => NOW,
      listChats: async () => CHATS,
      peekChat: async () => ({}),
    }),
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
  return { deps, notes, tools: createManagerVoiceTools(deps) };
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
    await expect(tools.quick('set_timer', { label: 'x' })).rejects.toBeInstanceOf(ChatLookupError);
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

describe('prompts', () => {
  test('the Manager instruction names its tools and never the hand-off tool', () => {
    const text = managerHostedInstruction();
    expect(text).toContain(SEND_TO_CHAT_TOOL_NAME);
    expect(text).toContain(FIND_CHATS_TOOL_NAME);
    expect(text).toContain(CHAT_STATUS_TOOL_NAME);
    expect(text).not.toContain(PASS_TO_AGENT_TOOL_NAME);
    expect(text).toContain('arrives as a message');
    expect(text).toMatch(/only a receipt[^.]*say nothing/i);
  });

  test('the account’s voice prompt replaces the built-in one; the tool rules stay', () => {
    const custom = 'You are my assistant. Answer questions yourself when you can.';
    const text = managerHostedInstruction(custom);
    expect(text.startsWith(custom)).toBe(true);
    expect(text).not.toContain('You are the Manager');
    expect(text).toContain(SEND_TO_CHAT_TOOL_NAME);
    // Blank falls back to the built-in text rather than leaving the voice with no identity.
    expect(managerHostedInstruction('  ')).toContain('You are the Manager');
  });

  test('the acknowledgement before a hand-off varies and is skipped when the answer is quick', () => {
    expect(ACKNOWLEDGEMENT_RULE).toMatch(/vary/);
    expect(ACKNOWLEDGEMENT_RULE).toMatch(/Skip it when the answer will be quick/);
    expect(ACKNOWLEDGEMENT_RULE).toMatch(/not always "one sec"/);
    expect(managerHostedInstruction()).toContain(ACKNOWLEDGEMENT_RULE);
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
      ChatLookupError,
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
      ChatLookupError,
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
      ChatLookupError,
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
    ).rejects.toBeInstanceOf(ChatLookupError);
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
