// spec/06 § Manager conversation — bounded context through what the provider
// supports: once the Manager's session has carried more than its window of
// messages, the next turn starts a fresh session and the recent conversation
// goes in as a visible `Handoff` note on that turn. Nothing is rebuilt and the
// full record is untouched.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { SPECIAL_THREAD_IDS, type WireEvent } from '@patch/wire';
import { Daemon, type HostOptions } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup(managerContextWindow: number | undefined) {
  const home = mkdtempSync(join(tmpdir(), 'patch-mgrctx-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-mgrctx-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => SPECIAL_THREAD_IDS.manager,
    ...(managerContextWindow !== undefined ? { managerContextWindow } : {}),
  } satisfies HostOptions);
  return { daemon, sdk, events, folder, metaStore };
}

let n = 0;
/** A turn that resumes ONE provider session, as Claude Code does. */
async function turn(
  daemon: ReturnType<typeof setup>['daemon'],
  sdk: ReturnType<typeof setup>['sdk'],
  chatId: string,
  sessionId = 'native',
): Promise<void> {
  n += 1;
  sdk.enqueue([{ type: 'assistant', content: `reply ${n}`, sessionId }]);
  await daemon.sendInput({ chatId, message: `msg ${n}`, localId: `L${n}` });
  await new Promise((r) => setTimeout(r, 30));
}

describe('the Manager’s bounded context', () => {
  it('resumes the same session while it is within the window', async () => {
    n = 0;
    const { daemon, sdk, folder, events } = setup(40);
    const chatId = await daemon.spawnChat({ folder });
    await turn(daemon, sdk, chatId);
    await turn(daemon, sdk, chatId);
    expect(sdk.lastOptions()?.resumeSessionId).toBe('native');
    expect(events.some((e) => e.type === 'chat.note' && e.label === 'Handoff')).toBe(false);
  });

  it('at the window: a fresh session, a divider, and the recent messages in a visible Handoff note', async () => {
    n = 0;
    const { daemon, sdk, folder, events } = setup(4);
    const chatId = await daemon.spawnChat({ folder });
    await turn(daemon, sdk, chatId);
    await turn(daemon, sdk, chatId); // msg1 + reply1 = 2, within the window
    expect(sdk.lastOptions()?.resumeSessionId).toBe('native');
    await turn(daemon, sdk, chatId, 'native-2'); // 4 messages on this session: the window
    const opts = sdk.lastOptions()!;
    expect(opts.resumeSessionId).toBeUndefined();
    expect(opts.prompt).toMatch(/^\[Note: Handoff\]/);
    // Half the window is carried: the newest two messages.
    expect(opts.prompt).toContain('User: msg 2');
    expect(opts.prompt).toContain('Manager: reply 2');
    expect(opts.prompt).not.toContain('msg 1');
    expect(opts.prompt.endsWith('msg 3')).toBe(true);
    // What the model received is in the record: the note is its own entry.
    const note = events.find((e) => e.type === 'chat.note' && e.label === 'Handoff');
    expect(note).toBeDefined();
    expect(
      events.some(
        (e) =>
          e.type === 'chat.message' &&
          e.role === 'system' &&
          e.content === 'New session · the last 2 messages carried over',
      ),
    ).toBe(true);
    // The user's own message is recorded as they sent it.
    expect(
      events.some((e) => e.type === 'chat.message' && e.role === 'user' && e.content === 'msg 3'),
    ).toBe(true);
    // The carried messages count towards the window: one more exchange fills it.
    await turn(daemon, sdk, chatId, 'native-3');
    expect(sdk.lastOptions()?.resumeSessionId).toBeUndefined();
    // The record keeps every message.
    const history = daemon.readHistory({ chatId, limit: 200 });
    expect(
      history.events.filter((e) => e.type === 'chat.message' && e.role !== 'system'),
    ).toHaveLength(8);
  });

  it('a session holds between half the window and the window, carried messages included', async () => {
    n = 0;
    const { daemon, sdk, folder, events } = setup(8);
    const chatId = await daemon.spawnChat({ folder });
    const resumed: Array<string | undefined> = [];
    for (let i = 0; i < 12; i++) {
      await turn(daemon, sdk, chatId);
      resumed.push(sdk.lastOptions()?.resumeSessionId);
    }
    // Turns 1–4 fill the first session (8 messages); turn 5 starts fresh,
    // handed 4. From then on a session trims after 4 new messages (2 turns),
    // so turns 5, 7, 9 and 11 each start fresh.
    const fresh = resumed.flatMap((r, i) => (i > 0 && r === undefined ? [i + 1] : []));
    expect(fresh).toEqual([5, 7, 9, 11]);
    const handovers = events.filter(
      (e) =>
        e.type === 'chat.message' && e.role === 'system' && e.content.startsWith('New session'),
    );
    expect(handovers).toHaveLength(4);
    // What Settings shows as "This session" counts the carried messages too.
    const last = events.filter((e) => e.type === 'chat.state' && e.chatId === chatId).at(-1);
    expect(last?.type === 'chat.state' ? last.session?.messages : undefined).toBe(8);
  });

  it('a host with no window configured never hands over', async () => {
    n = 0;
    const { daemon, sdk, folder } = setup(undefined);
    const chatId = await daemon.spawnChat({ folder });
    await turn(daemon, sdk, chatId);
    await turn(daemon, sdk, chatId);
    await turn(daemon, sdk, chatId);
    expect(sdk.lastOptions()?.resumeSessionId).toBe('native');
  });

  it('setManagerContextWindow changes the window for the next turn', async () => {
    n = 0;
    const { daemon, sdk, folder } = setup(40);
    const chatId = await daemon.spawnChat({ folder });
    await turn(daemon, sdk, chatId);
    await turn(daemon, sdk, chatId);
    expect(sdk.lastOptions()?.resumeSessionId).toBe('native');
    daemon.setManagerContextWindow(2);
    await turn(daemon, sdk, chatId);
    expect(sdk.lastOptions()?.resumeSessionId).toBeUndefined();
  });

  it('an ordinary chat is never bounded, even with a tiny window configured', async () => {
    n = 0;
    const home = mkdtempSync(join(tmpdir(), 'patch-mgrctx-ord-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-mgrctx-ord-folder-')));
    mkdirSync(folder, { recursive: true });
    const sdk = createMockSdkBackend();
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: sdk,
      oauthAccessToken: 'tok',
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
      managerContextWindow: 2,
    });
    const chatId = await daemon.spawnChat({ folder });
    await turn(daemon, sdk, chatId);
    await turn(daemon, sdk, chatId);
    await turn(daemon, sdk, chatId);
    expect(sdk.lastOptions()?.resumeSessionId).toBe('native');
  });
});
