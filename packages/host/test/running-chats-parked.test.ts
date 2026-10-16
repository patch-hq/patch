// A chat parked on an unanswered permission card is not doing work, so it must
// not hold the host's self-update (selfUpdate.ts waitUntilNoRunningTurns).

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

describe('runningChatIds', () => {
  it('excludes a chat parked on a permission card', async () => {
    vi.useFakeTimers();
    try {
      const home = mkdtempSync(join(tmpdir(), 'patch-parked-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-parked-folder-')));
      mkdirSync(folder, { recursive: true });
      const events: WireEvent[] = [];
      const daemon = new Daemon({
        hostId: 'd1',
        metaStore: createMetaStore(home),
        sdkBackend: createMockSdkBackend(),
        oauthAccessToken: 'fake-token',
        emit: (e) => events.push(e),
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'chat-1',
        permissionModeDefault: 'default',
      });
      const chatId = await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
      await vi.advanceTimersByTimeAsync(50);
      expect(events.some((e) => e.type === 'chat.permission_request')).toBe(true);
      expect(daemon.runningChatIds()).not.toContain(chatId);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('waitUntilNoRunningTurns', () => {
  it('warns loudly, repeatedly, when a hold has lasted a long time', async () => {
    const { waitUntilNoRunningTurns } = await import('../src/selfUpdate.js');
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn } as never;
    let t = 0;
    let reads = 0;
    await waitUntilNoRunningTurns({
      runningChats: () => (++reads > 5 ? [] : ['a']),
      logger,
      pollMs: 1,
      sleep: async () => {
        t += 20 * 60_000;
      },
      now: () => t,
    });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]![1]).toContain('still holding');
  });
});

describe('install commit', () => {
  it('commits in the idle tick and refuses a user permission answer until released', async () => {
    const { waitUntilNoRunningTurns } = await import('../src/selfUpdate.js');
    vi.useFakeTimers();
    try {
      const home = mkdtempSync(join(tmpdir(), 'patch-parked-'));
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-parked-folder-')));
      const events: WireEvent[] = [];
      const daemon = new Daemon({
        hostId: 'd1',
        metaStore: createMetaStore(home),
        sdkBackend: createMockSdkBackend(),
        oauthAccessToken: 'fake-token',
        emit: (e) => events.push(e),
        logger: silent,
        now: () => 1_700_000_000_000,
        generateChatId: () => 'chat-1',
        permissionModeDefault: 'default',
      });
      await daemon.spawnChat({ folder, prompt: '[[bash-permission]]' });
      await vi.advanceTimersByTimeAsync(50);
      const req = events.find((e) => e.type === 'chat.permission_request') as unknown as {
        requestId: string;
      };
      await waitUntilNoRunningTurns({
        runningChats: () => daemon.runningChatIds(),
        logger: { info: vi.fn(), warn: vi.fn() } as never,
        onIdle: () => daemon.commitToInstall(),
      });
      expect(() =>
        daemon.submitPermissionResponse({ requestId: req.requestId, decision: 'approve' }),
      ).toThrow(/self-update is installing/);
      daemon.releaseInstall();
      expect(() =>
        daemon.submitPermissionResponse({ requestId: req.requestId, decision: 'approve' }),
      ).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
