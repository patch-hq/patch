// The Manager's prompt, folder, Clear and finished-chats delivery (spec/06 §
// Manager prompt and folder, § Bounded context, § Finished chats).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { SPECIAL_THREAD_IDS, type ChatStateEvent, type WireEvent } from '@patch/wire';
import { Daemon, finishedLine, carriedMessages, type HostOptions } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const MANAGER = SPECIAL_THREAD_IDS.manager;
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
const dir = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

function setup(over: Partial<HostOptions> = {}) {
  const home = dir('patch-mgr-home-');
  const folder = dir('patch-mgr-folder-');
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  const ids = [MANAGER, 'c1', 'c2'];
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => ids.shift()!,
    managerContextWindow: 80,
    ...over,
  } satisfies HostOptions);
  return { daemon, sdk, events, folder, metaStore };
}

let n = 0;
async function turn(
  t: ReturnType<typeof setup>,
  chatId: string,
  sessionId = 'native',
  reply?: string,
): Promise<void> {
  n += 1;
  t.sdk.enqueue([{ type: 'assistant', content: reply ?? `reply ${n}`, sessionId }]);
  await t.daemon.sendInput({ chatId, message: `msg ${n}`, localId: `L${n}` });
  await tick();
}

const systemLines = (events: WireEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'chat.message' && e.role === 'system' ? [e.content] : []));

describe('carriedMessages', () => {
  it('is half the window, at least one', () => {
    expect(carriedMessages(80)).toBe(40);
    expect(carriedMessages(5)).toBe(2);
    expect(carriedMessages(1)).toBe(1);
  });
});

describe('finishedLine', () => {
  it('names one chat, counts several, and says the interval of a batch', () => {
    expect(finishedLine([{ name: 'Bus tracker', folder: '/a' }])).toBe('Bus tracker finished.');
    expect(finishedLine([{ name: '', folder: '/w/bus-tracker' }])).toBe('bus-tracker finished.');
    const two = [
      { name: 'A', folder: '/a' },
      { name: 'B', folder: '/b' },
    ];
    expect(finishedLine(two, 30)).toBe('2 chats finished in the last 30 min.');
    expect(finishedLine(two, 60)).toBe('2 chats finished in the last hour.');
    expect(finishedLine(two, 240)).toBe('2 chats finished in the last 4 hours.');
    expect(finishedLine(two, 1440)).toBe('2 chats finished in the last day.');
  });
});

describe('the Manager prompt', () => {
  it('is appended to the Manager’s turns after the tools guidance, and to no other chat', async () => {
    n = 0;
    const t = setup();
    t.daemon.setHarnessConfig({ toolsPrompt: 'TOOLS' });
    t.daemon.setManagerPrompt('You are the Manager.');
    const manager = await t.daemon.spawnChat({ folder: t.folder });
    await turn(t, manager);
    expect(t.sdk.lastOptions()?.toolsPrompt).toBe('TOOLS\n\nYou are the Manager.');
    const other = await t.daemon.spawnChat({ folder: t.folder });
    await turn(t, other);
    expect(t.sdk.lastOptions()?.toolsPrompt).toBe('TOOLS');
  });

  it('is there on the first turn of a fresh session too', async () => {
    n = 0;
    const t = setup();
    t.daemon.setManagerPrompt('You are the Manager.');
    const manager = await t.daemon.spawnChat({ folder: t.folder });
    await turn(t, manager);
    await t.daemon.rotateThread(manager, { carry: false });
    await turn(t, manager, 'native-2');
    expect(t.sdk.lastOptions()?.resumeSessionId).toBeUndefined();
    expect(t.sdk.lastOptions()?.toolsPrompt).toBe('You are the Manager.');
  });
});

describe('the Manager prompt on an ACP agent', () => {
  it('is said not to apply, once per session rather than every turn', async () => {
    n = 0;
    const t = setup();
    t.daemon.setManagerPrompt('You are the Manager.');
    const manager = await t.daemon.spawnChat({ folder: t.folder });
    t.daemon.chatState.get(manager)!.model = 'acp/gemini/gemini-pro';
    const notes = (): string[] =>
      systemLines(t.events).filter((l) => l.startsWith('Manager prompt not applied'));
    await turn(t, manager, 'acp-gemini-r-one');
    expect(notes()).toEqual(['Manager prompt not applied · ACP agent takes no system prompt']);
    await turn(t, manager, 'acp-gemini-r-one').catch(() => undefined);
    expect(notes()).toHaveLength(1);
    // A fresh session is told again.
    await t.daemon.rotateThread(manager, { carry: false });
    await turn(t, manager, 'acp-gemini-r-two');
    expect(notes()).toHaveLength(2);
  });

  it('says nothing on an agent that takes the prompt', async () => {
    n = 0;
    const t = setup();
    t.daemon.setManagerPrompt('You are the Manager.');
    const manager = await t.daemon.spawnChat({ folder: t.folder });
    await turn(t, manager);
    expect(systemLines(t.events).some((l) => l.startsWith('Manager prompt not applied'))).toBe(
      false,
    );
  });
});

describe('Clear', () => {
  it('retires the session with nothing carried, and says so', async () => {
    n = 0;
    const t = setup();
    const manager = await t.daemon.spawnChat({ folder: t.folder });
    await turn(t, manager);
    await turn(t, manager);
    t.events.length = 0;
    await t.daemon.rotateThread(manager, { carry: false });
    expect(systemLines(t.events)).toEqual(['Cleared · new session']);
    expect(t.daemon.chatState.get(manager)?.sessionId).toBeUndefined();
    await turn(t, manager, 'native-2');
    const opts = t.sdk.lastOptions()!;
    expect(opts.resumeSessionId).toBeUndefined();
    expect(opts.prompt).toBe(`msg ${n}`);
    expect(t.events.some((e) => e.type === 'chat.note')).toBe(false);
  });
});

describe('the Manager’s session in chat.state', () => {
  it('counts the messages of the current session and when it started', async () => {
    n = 0;
    const t = setup();
    const manager = await t.daemon.spawnChat({ folder: t.folder });
    expect(t.daemon.currentStateEvent(manager)?.session).toBeNull();
    await turn(t, manager);
    await turn(t, manager);
    expect(t.daemon.currentStateEvent(manager)?.session).toEqual({
      messages: 4,
      startedAt: 1_700_000_000_000,
    });
    await t.daemon.rotateThread(manager, { carry: false });
    expect(t.daemon.currentStateEvent(manager)?.session).toBeNull();
    // An ordinary chat carries no session field.
    const other = await t.daemon.spawnChat({ folder: t.folder });
    expect(t.daemon.currentStateEvent(other)).not.toHaveProperty('session');
  });
});

describe('the Manager folder', () => {
  it('moves the Manager there and starts a fresh session in it', async () => {
    n = 0;
    const t = setup();
    const manager = await t.daemon.spawnChat({ folder: t.folder });
    await turn(t, manager);
    const next = dir('patch-mgr-next-');
    t.daemon.setManagerFolder(next);
    expect(t.daemon.chatState.get(manager)?.folder).toBe(next);
    expect(t.metaStore.read(manager)?.folder).toBe(next);
    expect(systemLines(t.events)).toContain(`Folder changed · ${next} · new session`);
    const state = t.events.filter((e): e is ChatStateEvent => e.type === 'chat.state').at(-1);
    expect(state?.folder).toBe(next);
    await turn(t, manager, 'native-2');
    expect(t.sdk.lastOptions()?.cwd).toBe(next);
    expect(t.sdk.lastOptions()?.resumeSessionId).toBeUndefined();
  });

  it('refuses a path that is not a folder here, in the record, and stays put', async () => {
    n = 0;
    const t = setup();
    const manager = await t.daemon.spawnChat({ folder: t.folder });
    const missing = join(t.folder, 'nope');
    t.daemon.setManagerFolder(missing);
    expect(t.daemon.chatState.get(manager)?.folder).toBe(t.folder);
    expect(systemLines(t.events)).toContain(`Folder not changed: ${missing} is not a folder on d1`);
  });

  it('names the host by name, and says a refusal once, not again at every restart', async () => {
    n = 0;
    const t = setup({ hostName: () => 'Studio Mac' });
    const manager = await t.daemon.spawnChat({ folder: t.folder });
    const missing = join(t.folder, 'nope');
    t.daemon.setManagerFolder(missing);
    const line = `Folder not changed: ${missing} is not a folder on Studio Mac`;
    expect(systemLines(t.events)).toEqual([line]);
    // The host restarts and is given the same setting again.
    const again = new Daemon({
      hostId: 'd1',
      hostName: () => 'Studio Mac',
      metaStore: t.metaStore,
      sdkBackend: t.sdk,
      oauthAccessToken: 'tok',
      emit: (e) => t.events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
    });
    expect(again.chatState.get(manager)).toBeDefined();
    again.setManagerFolder(missing);
    expect(systemLines(t.events)).toEqual([line]);
    // A different path is a new refusal, said once.
    again.setManagerFolder(join(t.folder, 'other'));
    expect(systemLines(t.events)).toHaveLength(2);
  });

  it('waits for a running Manager turn to end, then lands before the next one', async () => {
    n = 0;
    const t = setup();
    const manager = await t.daemon.spawnChat({ folder: t.folder });
    await turn(t, manager);
    const state = t.daemon.chatState.get(manager)!;
    state.activity = 'running';
    const next = dir('patch-mgr-later-');
    t.daemon.setManagerFolder(next);
    expect(state.folder).toBe(t.folder);
    state.activity = 'idle';
    await turn(t, manager, 'native-2');
    expect(t.sdk.lastOptions()?.cwd).toBe(next);
    expect(t.sdk.lastOptions()?.resumeSessionId).toBeUndefined();
  });
});

describe('a change of home', () => {
  it('says the folder went back to the default when it was a path on the old home', async () => {
    const t = setup();
    const manager = await t.daemon.spawnChat({ folder: t.folder });
    t.events.length = 0;
    await t.daemon.handOverThread(manager, {
      nextSeq: 10,
      fromHostName: 'Laptop',
      toHostName: 'Server',
      message: '',
      folderReset: '/Users/me/work',
    });
    expect(systemLines(t.events)).toEqual([
      'Home moved · Laptop to Server',
      'Folder back to the default · /Users/me/work is on Laptop',
    ]);
  });
});

describe('finished chats', () => {
  it('one machine turn into the Manager: a note per chat with its last reply, then the line', async () => {
    n = 0;
    const t = setup();
    const manager = await t.daemon.spawnChat({ folder: t.folder });
    const c1 = await t.daemon.spawnChat({ folder: t.folder });
    await turn(t, c1, 'c1-native', 'Should I use the paid timetable API?');
    t.events.length = 0;
    t.sdk.enqueue([{ type: 'assistant', content: 'ok', sessionId: 'mgr' }]);
    const result = await t.daemon.deliverFinishedChats({
      runId: 'r1',
      chats: [{ chatId: c1, hostId: 'd1', folder: t.folder, name: 'Bus tracker' }],
      windowMinutes: 30,
    });
    await tick();
    expect(result).toEqual({ type: 'manager.finished_result', runId: 'r1', delivered: 1 });
    const prompt = t.sdk.lastOptions()!.prompt;
    expect(prompt).toMatch(/^\[Note: Finished · Bus tracker\]\n/);
    expect(prompt).toContain(`Chat: ${c1}`);
    expect(prompt).toContain(`Link: patch://chats/${c1}`);
    expect(prompt).toContain('Should I use the paid timetable API?');
    expect(prompt.endsWith('Bus tracker finished in the last 30 min.')).toBe(true);
    // The record shows the note as its own entry and the line as Patch's message.
    const note = t.events.find((e) => e.type === 'chat.note' && e.chatId === manager);
    expect(note).toMatchObject({ label: 'Finished · Bus tracker' });
    const msg = t.events.find(
      (e) => e.type === 'chat.message' && e.chatId === manager && e.role === 'user',
    );
    expect(msg).toMatchObject({
      content: 'Bus tracker finished in the last 30 min.',
      origin: 'machine',
    });
  });

  it('the last reply is the latest one, however long the chat', async () => {
    n = 0;
    const t = setup();
    await t.daemon.spawnChat({ folder: t.folder });
    const c1 = await t.daemon.spawnChat({ folder: t.folder });
    // Far more than the ten 50-event pages a forward read used to stop at.
    const replies = Array.from({ length: 700 }, (_, i) => ({
      type: 'assistant' as const,
      content: i === 699 ? 'The very latest reply.' : `older reply ${i}`,
      sessionId: 'c1-native',
    }));
    t.sdk.enqueue(replies);
    await t.daemon.sendInput({ chatId: c1, message: 'go', localId: 'long' });
    await tick(200);
    expect(t.daemon.readHistory({ chatId: c1, fromSeq: 600 }).events.length).toBeGreaterThan(0);
    t.sdk.enqueue([{ type: 'assistant', content: 'ok', sessionId: 'mgr' }]);
    await t.daemon.deliverFinishedChats({
      runId: 'long',
      chats: [{ chatId: c1, hostId: 'd1', folder: t.folder, name: 'Long' }],
    });
    await tick();
    const prompt = t.sdk.lastOptions()!.prompt;
    expect(prompt).toContain('The very latest reply.');
    expect(prompt).not.toContain('older reply 698');
  });

  it('names the host and an unnamed chat’s folder; another host’s chat is read through the peek relay', async () => {
    n = 0;
    const t = setup({
      peekRemoteChat: async ({ targetChatId }) => {
        if (targetChatId === 'far') {
          return {
            chat_state: {
              lastMessages: [{ role: 'assistant', content: 'Done on the other host.' }],
              lastMessage: 'Done on the other host.',
            },
            events: [],
            truncated: true,
          };
        }
        throw new Error('host offline');
      },
    });
    await t.daemon.spawnChat({ folder: t.folder });
    t.sdk.enqueue([{ type: 'assistant', content: 'ok', sessionId: 'mgr' }]);
    await t.daemon.deliverFinishedChats({
      runId: 'r2',
      chats: [
        { chatId: 'far', hostId: 'd2', hostName: 'Studio Mac', folder: '/w/bus-tracker', name: '' },
        { chatId: 'gone', hostId: 'd3', folder: '/g', name: 'Gone' },
      ],
    });
    await tick();
    const prompt = t.sdk.lastOptions()!.prompt;
    expect(prompt).toMatch(/^\[Note: Finished · bus-tracker\]\n/);
    expect(prompt).toContain('Host: Studio Mac');
    expect(prompt).toContain('Host: d3');
    expect(prompt).toContain('Done on the other host.');
    expect(prompt).toContain('(its last reply could not be read: host offline)');
    expect(prompt.endsWith('2 chats finished.')).toBe(true);
  });

  it('a delivery the Manager could not take is said in its thread and reported as recorded', async () => {
    n = 0;
    const t = setup();
    await t.daemon.spawnChat({ folder: t.folder });
    t.daemon.sendInput = async () => {
      throw new Error('queue full');
    };
    t.events.length = 0;
    const result = await t.daemon.deliverFinishedChats({
      runId: 'r9',
      chats: [{ chatId: 'x', hostId: 'd2', folder: '/x', name: 'X' }],
    });
    expect(result).toEqual({
      type: 'manager.finished_result',
      runId: 'r9',
      delivered: 0,
      error: 'queue full',
      recorded: true,
    });
    expect(systemLines(t.events)).toEqual(['Finished chats not delivered: queue full']);
  });

  it('a disabled Manager is sent nothing', async () => {
    n = 0;
    const t = setup();
    const manager = await t.daemon.spawnChat({ folder: t.folder });
    await t.daemon.setDisabled(manager, true);
    const calls = t.sdk.calls?.length;
    const result = await t.daemon.deliverFinishedChats({
      runId: 'r3',
      chats: [{ chatId: 'x', hostId: 'd1', folder: '/x', name: 'X' }],
    });
    expect(result).toMatchObject({ delivered: 0, error: 'the Manager is disabled' });
    expect(t.sdk.calls?.length).toBe(calls);
  });
});
