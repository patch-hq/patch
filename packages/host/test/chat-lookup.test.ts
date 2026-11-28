// spec/07 § The voice agent and the chat's agent — finding and reading other
// chats from any call: one lookup, server-routed, hidden, snoozed and archived chats included.

import { describe, test, expect, vi } from 'vitest';
import {
  ChatLookupError,
  createChatLookup,
  MANAGER_CHAT_ID,
  resolveChat,
  type ChatEntry,
} from '../src/audio/chatLookup.js';

const NOW = 1_000_000_000_000;

const CHATS: ChatEntry[] = [
  { chatId: MANAGER_CHAT_ID, name: 'Manager', folder: '/t/manager', status: 'active' },
  {
    chatId: 'c-garden',
    name: 'Garden planning',
    folder: '/p/garden',
    status: 'active',
    hidden: false,
    snoozed: false,
    chatStatus: 'running',
    lastUpdated: NOW - 5 * 60_000,
  },
  {
    chatId: 'c-bus',
    name: 'Bus watcher',
    folder: '/p/bus',
    status: 'active',
    hidden: false,
    snoozed: false,
    chatStatus: 'idle',
    lastUpdated: NOW - 2 * 3_600_000,
  },
  {
    chatId: 'c-bus2',
    name: 'Bus timetable import',
    folder: '/p/bus-import',
    status: 'active',
    hidden: false,
    snoozed: false,
    chatStatus: 'idle',
    lastUpdated: NOW - 60_000,
  },
  { chatId: 'c-old', name: 'Old thing', folder: '/p/old', status: 'archived' },
  {
    chatId: 'c-hidden',
    name: 'Quarterly invoices',
    folder: '/p/invoices',
    status: 'active',
    hidden: true,
    snoozed: false,
    chatStatus: 'idle',
    lastUpdated: NOW - 3_600_000,
  },
  {
    chatId: 'c-snoozed',
    name: 'Passport renewal',
    folder: '/p/passport',
    status: 'active',
    hidden: false,
    snoozed: true,
    chatStatus: 'idle',
    lastUpdated: NOW - 3_600_000,
  },
  {
    chatId: 'c-remote',
    name: 'Laptop build',
    folder: '/p/build',
    status: 'active',
    hidden: false,
    snoozed: false,
    chatStatus: 'idle',
    lastUpdated: NOW - 60_000,
  },
];

// `chat_state` as the server's patch_peek builds it, whichever host the chat is on.
const peekChat = vi.fn(async (chatId: string, _caller: string) => ({
  chatId,
  hostId: chatId === 'c-remote' ? 'host-laptop' : 'host-here',
  statusSummary: 'Drafting the planting plan',
  goal: 'A plan for spring',
  todos: [
    { text: 'order seeds', status: 'pending' },
    { text: 'sow peas', status: 'completed' },
    { text: 'measure beds', status: 'in_progress' },
  ],
  lastMessages: [
    { role: 'user', content: '[voice • phone] what should go in the north bed?', seq: 4 },
    { role: 'assistant', content: 'Ferns and hostas do well in shade.', seq: 5 },
  ],
}));

const CALLER = 'c-caller';
const makeLookup = (listChats: () => Promise<ChatEntry[]> = async () => CHATS) => ({
  peekChat,
  tools: createChatLookup({ now: () => NOW, listChats, peekChat }),
});

describe('find_chats', () => {
  test('an empty query lists the most recent chats, never the Manager', async () => {
    const { tools } = makeLookup();
    const out = await tools.findChats('', CALLER);
    expect(out).not.toContain(MANAGER_CHAT_ID);
    const lines = out.split('\n');
    expect(lines[0]).toContain('Bus timetable import');
    expect(out).toContain('"Garden planning" (id c-garden) — working, last active 5 min ago');
    expect(out).toContain('"Bus watcher" (id c-bus) — idle, last active 2 h ago');
  });

  test('a query keeps the chats whose name or folder matches', async () => {
    const { tools } = makeLookup();
    const out = await tools.findChats('bus', CALLER);
    expect(out.split('\n')).toHaveLength(2);
    expect(out).not.toContain('Garden');
    expect(await tools.findChats('zebra', CALLER)).toBe('No chat matches "zebra".');
  });

  test('archived chats are found too, and say they are archived', async () => {
    const { tools } = makeLookup();
    expect(await tools.findChats('old', CALLER)).toBe('"Old thing" (id c-old) — archived');
  });

  test('hidden and snoozed chats are found too, and say so', async () => {
    const { tools } = makeLookup();
    expect(await tools.findChats('invoices', CALLER)).toBe(
      '"Quarterly invoices" (id c-hidden) — hidden, last active 1 h ago',
    );
    expect(await tools.findChats('passport', CALLER)).toBe(
      '"Passport renewal" (id c-snoozed) — snoozed, last active 1 h ago',
    );
  });

  test('a hidden chat resolves as a send/switch/status target', async () => {
    const { tools } = makeLookup();
    expect((await tools.resolve('quarterly invoices', CALLER)).chatId).toBe('c-hidden');
  });

  test('a list the host cannot get is an error, not an empty answer', async () => {
    const { tools } = makeLookup(async () => {
      throw new Error('the server link is offline');
    });
    await expect(tools.findChats('', CALLER)).rejects.toThrow('offline');
  });
});

describe('chat_status', () => {
  test('status, goal, open to-dos and the last messages, read from the server', async () => {
    const { tools, peekChat: peek } = makeLookup();
    const out = await tools.chatStatus('garden', CALLER);
    expect(peek).toHaveBeenCalledWith('c-garden', CALLER);
    expect(out).toContain('Where it stands: Drafting the planting plan');
    expect(out).toContain('Goal: A plan for spring');
    expect(out).toContain('Still to do: order seeds; measure beds');
    expect(out).toContain('User: what should go in the north bed?');
    expect(out).toContain('Agent: Ferns and hostas do well in shade.');
  });

  test('a chat on another host reads the same: its last messages come from the server', async () => {
    const { tools, peekChat: peek } = makeLookup();
    const out = await tools.chatStatus('c-remote', CALLER);
    expect(peek).toHaveBeenCalledWith('c-remote', CALLER);
    expect(out).toContain('"Laptop build"');
    expect(out).toContain('Agent: Ferns and hostas do well in shade.');
    expect(out).not.toMatch(/another (computer|host)/);
  });

  test('a server that cannot be read is an error, not a shorter answer', async () => {
    const tools = createChatLookup({
      listChats: async () => CHATS,
      peekChat: async () => {
        throw new Error('the link to the Patch server is down');
      },
    });
    await expect(tools.chatStatus('garden', CALLER)).rejects.toThrow(
      'link to the Patch server is down',
    );
  });

  test('a name that fits several chats asks which, naming them', async () => {
    const { tools } = makeLookup();
    const err = await tools.chatStatus('bus', CALLER).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ChatLookupError);
    expect((err as Error).message).toContain('"Bus watcher"');
    expect((err as Error).message).toContain('"Bus timetable import"');
  });

  test('an exact name wins over a partial match', async () => {
    const { tools } = makeLookup();
    expect(await tools.chatStatus('Bus watcher', CALLER)).toContain('(id c-bus)');
  });

  test('no match is a lookup error', async () => {
    const { tools } = makeLookup();
    await expect(tools.chatStatus('zebra', CALLER)).rejects.toBeInstanceOf(ChatLookupError);
  });
});

describe('resolveChat (a chat named on a call)', () => {
  const chats: ChatEntry[] = [
    { chatId: 'c1', name: 'Garden planning', folder: '/home/garden', status: 'active' },
    { chatId: 'c2', name: 'Garden shed', folder: '/home/shed', status: 'active' },
    { chatId: 'c3', name: 'Tax return', folder: '/home/tax', status: 'archived' },
    { chatId: MANAGER_CHAT_ID, name: 'Manager', folder: '/', status: 'active' },
  ];
  test('an id or an exact name wins; words must pick out one chat', () => {
    expect(resolveChat(chats, 'c2').chatId).toBe('c2');
    expect(resolveChat(chats, 'garden planning').chatId).toBe('c1');
    expect(resolveChat(chats, 'shed').chatId).toBe('c2');
  });
  test('none or several is a lookup error naming the choices; the Manager is not a name', () => {
    expect(() => resolveChat(chats, 'garden')).toThrow(/Several chats match "garden"/);
    expect(() => resolveChat(chats, 'manager')).toThrow(/No chat matches/);
  });
  test('an archived chat is a name like any other', () => {
    expect(resolveChat(chats, 'tax').chatId).toBe('c3');
    expect(resolveChat(chats, 'c3').chatId).toBe('c3');
  });
  test('an active chat beats a hidden, snoozed or archived one of the same name', () => {
    const dup: ChatEntry[] = [
      {
        chatId: 'h',
        name: 'Invoices',
        folder: '/a',
        status: 'active',
        hidden: true,
        snoozed: false,
      },
      {
        chatId: 's',
        name: 'Invoices',
        folder: '/b',
        status: 'active',
        hidden: false,
        snoozed: true,
      },
      {
        chatId: 'x',
        name: 'Invoices',
        folder: '/c',
        status: 'archived',
        hidden: false,
        snoozed: false,
      },
      {
        chatId: 'a',
        name: 'Invoices',
        folder: '/d',
        status: 'active',
        hidden: false,
        snoozed: false,
      },
    ];
    expect(resolveChat(dup, 'invoices').chatId).toBe('a');
    expect(resolveChat(dup, 'inv').chatId).toBe('a');
    // With no active one, the choices are named with where they are kept.
    expect(() => resolveChat(dup.slice(0, 3), 'invoices')).toThrow(/\(hidden\).*\(snoozed\)/);
  });

  test('of several chats a name fits, the only one not archived is meant', () => {
    const withOld: ChatEntry[] = [
      ...chats,
      { chatId: 'c4', name: 'Tax return', folder: '/home/tax-2025', status: 'active' },
      { chatId: 'c5', name: 'Garden old', folder: '/home/garden-old', status: 'archived' },
    ];
    expect(resolveChat(withOld, 'tax return').chatId).toBe('c4');
    expect(resolveChat(withOld, 'tax').chatId).toBe('c4');
    // Two current ones still ask, and name the archived one as such.
    expect(() => resolveChat(withOld, 'garden')).toThrow(/"Garden old" \(archived\)/);
  });
});
