// Under `auto`, a Bash call the SDK escalates to canUseTool is denied at once
// (spec/02 § Permission mode) instead of parking the chat on an approval card.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon, AUTO_BASH_DENIED_MESSAGE, autoBashDeniedMessage } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

type Gate = (
  chatId: string,
  tool: string,
  args: Record<string, unknown>,
  description: string | undefined,
  branchId?: string,
  decisionReason?: string,
) => Promise<{ approve: boolean; denyMessage?: string }>;

async function setup(mode: 'auto' | 'default') {
  const home = mkdtempSync(join(tmpdir(), 'patch-autobash-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-autobash-folder-')));
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: pino({ level: 'silent' }),
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    permissionModeDefault: mode,
  });
  const chatId = await daemon.spawnChat({ folder, permissionMode: mode });
  const gate = (daemon as unknown as { requestPermission: Gate }).requestPermission.bind(daemon);
  const state = (daemon as unknown as { chatState: Map<string, { turnOrigin?: string }> })
    .chatState;
  const setOrigin = (o: 'user' | 'machine') => {
    state.get(chatId)!.turnOrigin = o;
  };
  setOrigin('machine');
  return { chatId, events, gate, setOrigin };
}

describe('auto-mode Bash escalation', () => {
  it('is denied immediately with no approval card', async () => {
    const { chatId, events, gate } = await setup('auto');
    const res = await gate(chatId, 'Bash', { command: 'pnpm test' }, 'Run tests');
    expect(res).toEqual({ approve: false, denyMessage: AUTO_BASH_DENIED_MESSAGE });
    expect(events.some((e) => e.type === 'chat.permission_request')).toBe(false);
  });

  it('shows the classifier response in the denial', async () => {
    const { chatId, gate } = await setup('auto');
    const res = await gate(
      chatId,
      'Bash',
      { command: 'rm -rf x' },
      'rm',
      undefined,
      'Deletes files outside the task',
    );
    expect(res.denyMessage).toBe(autoBashDeniedMessage('Deletes files outside the task'));
    expect(res.denyMessage).toContain('Classifier response: Deletes files outside the task');
  });

  it('asks the user when the turn is theirs, so an advance approval can be honoured', async () => {
    const { chatId, events, gate, setOrigin } = await setup('auto');
    setOrigin('user');
    void gate(chatId, 'Bash', { command: 'rm -rf old' }, 'delete');
    expect(events.some((e) => e.type === 'chat.permission_request')).toBe(true);
  });

  it('still asks for a non-Bash safety check under auto', async () => {
    const { chatId, events, gate } = await setup('auto');
    void gate(chatId, 'Write', { file_path: '.claude/settings.json' }, 'sensitive');
    expect(events.some((e) => e.type === 'chat.permission_request')).toBe(true);
  });

  it('still asks for Bash under a blocking mode', async () => {
    const { chatId, events, gate } = await setup('default');
    void gate(chatId, 'Bash', { command: 'ls' }, 'ls');
    expect(events.some((e) => e.type === 'chat.permission_request')).toBe(true);
  });
});
