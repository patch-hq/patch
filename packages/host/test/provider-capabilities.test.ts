// Features follow declared capability (spec/02 § Provider adapters): a chat on a
// provider that does not declare editAtMessage or branchAtTurn is refused with
// capability_unsupported and no branch is created.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createHistoryReader } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-cap-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-cap-folder-'));
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-cap-projects-'));
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend({ claudeProjectsRoot: projectsRoot }),
    historyReader: createHistoryReader({ claudeProjectsRoot: projectsRoot }),
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: pino({ level: 'silent' }),
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, events, folder };
}

const codes = (events: WireEvent[]): string[] =>
  events
    .filter((e) => e.type === 'chat.error')
    .map((e) => (e as { error: { code: string } }).error.code);

describe('capability gating in the chat core', () => {
  it('refuses an edit on a provider that does not declare editAtMessage', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'gemini/gemini-3-pro' });
    events.length = 0;
    await daemon.forkChat({ chatId, seq: 0, message: 'edited', localId: 'l1' });
    expect(codes(events)).toEqual(['capability_unsupported']);
    expect(events.some((e) => e.type === 'chat.branches')).toBe(false);
  });

  it('refuses a side thread on a provider that does not declare branchAtTurn', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'gemini/gemini-3-pro' });
    events.length = 0;
    await daemon.sideChat({ chatId, seq: 0, message: 'aside', localId: 'l1' });
    expect(codes(events)).toEqual(['capability_unsupported']);
  });

  it('still edits on a provider that declares it', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'q', localId: 'l1' });
    events.length = 0;
    await daemon.forkChat({ chatId, seq: 0, message: 'q2', localId: 'l2' });
    expect(codes(events)).not.toContain('capability_unsupported');
  });
});
