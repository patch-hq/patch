// Per-chat code paths must never scan every chat's meta.json from disk.
//
// `metaStore.list()` reads every chat's file. On reconnect the host replays
// and re-emits state for every chat, so a `list()` anywhere on that path is
// chats × chats file reads — it froze a 9,000-chat host twice (countRunningDelegates,
// then listDelegates via replayChat). `list()` is for boot hydration only.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

describe('per-chat paths do not scan every chat on disk', () => {
  it('replaying and listing delegates for one chat never calls metaStore.list()', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-nodiskscan-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-nodiskscan-folder-')));
    mkdirSync(folder, { recursive: true });
    const real = createMetaStore(home);
    let listCalls = 0;
    const metaStore = {
      ...real,
      list: () => {
        listCalls++;
        return real.list();
      },
    };
    let id = 0;
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore,
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'tok',
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
    });
    const parent = await daemon.spawnChat({ folder });
    const child = await daemon.spawnChat({ folder });
    daemon.chatState.get(child)!.subagent = { parentChatId: parent, label: 'worker' };

    listCalls = 0;
    const replayed: WireEvent[] = [];
    daemon.replayChat(parent, -1, (e) => replayed.push(e));
    const delegates = daemon.listDelegates(parent);

    expect(delegates.map((d) => d.id)).toEqual([child]);
    expect(delegates[0]!.status).toBe('running');
    expect(
      listCalls,
      'replay/state build must use in-memory chat states, not metaStore.list()',
    ).toBe(0);
  });
});
