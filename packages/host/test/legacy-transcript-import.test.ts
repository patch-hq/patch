// A chat's own log is the only replay source (spec/04 § History), so turns that
// live only in the harness transcript — written before the log existed — never
// showed in the app after a host restart. They are imported into the log once.

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createHistoryReader } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function makeDaemon(home: string, projectsRoot: string) {
  let id = 0;
  return new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend({ claudeProjectsRoot: projectsRoot }),
    historyReader: createHistoryReader({ claudeProjectsRoot: projectsRoot }),
    oauthAccessToken: 'tok',
    emit: () => {},
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
}

function userMessages(daemon: Daemon, chatId: string): string[] {
  const out: WireEvent[] = [];
  daemon.replayChat(chatId, -1, (e) => out.push(e));
  return out
    .filter((e) => e.type === 'chat.message' && e.role === 'user')
    .map((e) => (e as { content: string }).content);
}

describe('replay of turns the chat log never held', () => {
  it('shows the whole transcript after a restart, once, without duplicating', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-legacy-home-'));
    const folder = mkdtempSync(join(tmpdir(), 'patch-legacy-folder-'));
    const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-legacy-projects-'));

    const first = makeDaemon(home, projectsRoot);
    const chatId = await first.spawnChat({ folder });
    await first.sendInput({ chatId, message: 'question one', localId: 'l1' });
    await first.sendInput({ chatId, message: 'question two', localId: 'l2' });
    expect(userMessages(first, chatId)).toEqual(['question one', 'question two']);

    // The chat as an older host left it: the transcript is whole, the log is gone.
    const logPath = join(home, 'chats', chatId, 'events.jsonl');
    expect(existsSync(logPath)).toBe(true);
    rmSync(logPath);

    const second = makeDaemon(home, projectsRoot);
    second.hydrate();
    expect(userMessages(second, chatId)).toEqual(['question one', 'question two']);
    // A second replay (and a restart) reads the log, not the transcript again.
    expect(userMessages(second, chatId)).toEqual(['question one', 'question two']);
    const third = makeDaemon(home, projectsRoot);
    third.hydrate();
    expect(userMessages(third, chatId)).toEqual(['question one', 'question two']);
    const imports = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.includes('"k":"import"'));
    expect(imports).toHaveLength(1);
  });
});
