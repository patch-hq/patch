// spec/04 § Moving to another host — what is left of moving on a host. Moving
// starts a new linked chat now and copies nothing; a host still sets aside the
// old copy of a chat a move before linked chats took over, when asked.

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { SPECIAL_THREAD_IDS, type WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { createClaudeSessionProbe } from '../src/history.js';
import { ChatMoveError } from '../src/chatMove.js';

const silent = pino({ level: 'silent' });
const settle = () => new Promise((r) => setTimeout(r, 30));

function host(hostId: string) {
  const home = mkdtempSync(join(tmpdir(), `patch-move-${hostId}-`));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), `patch-move-${hostId}-folder-`)));
  const claudeRoot = mkdtempSync(join(tmpdir(), `patch-move-${hostId}-claude-`));
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    hostId,
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${hostId}-${++id}`,
    claudeProjectsRoot: claudeRoot,
    sessionProbe: createClaudeSessionProbe({ claudeProjectsRoot: claudeRoot }),
  });
  return { daemon, events, sdk, metaStore, folder, home };
}

async function chatWithOneTurn(h: ReturnType<typeof host>): Promise<string> {
  h.sdk.enqueue([
    { type: 'result', sessionId: 'sess-1' },
    { type: 'assistant', content: 'the plan is ready', sessionId: 'sess-1' },
  ]);
  const chatId = await h.daemon.spawnChat({ folder: h.folder, prompt: 'make a plan' });
  await settle();
  return chatId;
}

describe('retiring an old moved copy', () => {
  it('a takeover retires a chat this host was never asked to export, even mid-turn', async () => {
    const mac = host('mac');
    const chatId = await chatWithOneTurn(mac);
    mac.daemon.chatState.setActivity(chatId, 'running');
    await mac.daemon.retireTakenOverChat(chatId);
    expect(mac.daemon.chatState.has(chatId)).toBe(false);
    expect(existsSync(join(mac.home, 'chats', chatId))).toBe(false);
    expect(readdirSync(join(mac.home, 'moved'))).toEqual([`${chatId}-1700000000000`]);
  });

  it('a takeover of a chat this host does not have is not_found, and a special thread is refused', async () => {
    const mac = host('mac');
    await expect(mac.daemon.retireTakenOverChat('nope')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(mac.daemon.retireTakenOverChat(SPECIAL_THREAD_IDS.manager)).rejects.toBeInstanceOf(
      ChatMoveError,
    );
  });
});
