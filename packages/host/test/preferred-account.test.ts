// Preferred account on a live chat (spec/10 § Backend credentials).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { chatStateFromMeta } from '../src/chatState.js';

const silent = pino({ level: 'silent' });

function setup(
  opts: {
    permissionModeDefault?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto';
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'patch-perm-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-perm-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    ...(opts.permissionModeDefault !== undefined
      ? { permissionModeDefault: opts.permissionModeDefault }
      : {}),
  });
  return { daemon, sdk, events, home, folder, metaStore };
}

describe('setChatPreferredAccount', () => {
  it('sets, announces on chat.state, persists to meta, and clears with null', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    daemon.setChatPreferredAccount(chatId, 'a2');
    const last = () =>
      [...events].reverse().find((e) => e.type === 'chat.state') as {
        preferredAccountId?: unknown;
      };
    expect(last().preferredAccountId).toBe('a2');
    expect(metaStore.read(chatId)?.preferredAccountId).toBe('a2');
    expect(chatStateFromMeta(metaStore.read(chatId)!).preferredAccountId).toBe('a2');
    daemon.setChatPreferredAccount(chatId, null);
    expect(last().preferredAccountId).toBeNull();
    expect(metaStore.read(chatId)?.preferredAccountId).toBeUndefined();
  });

  it('refuses a chat it does not hold', () => {
    const { daemon } = setup();
    expect(() => daemon.setChatPreferredAccount('nope', 'a1')).toThrow();
  });
});
