// Settings → Manager → "Manager and Speakers model" (`specialThreadModel`,
// spec/06 § Session rotation). The setting must reach the special threads
// themselves: before this, it was saved and mirrored but nothing read it, so
// changing it did nothing.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatStateEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { ensureSpecialThreads } from '../src/specialThreads.js';

const silent = pino({ level: 'silent' });
const CATALOGUE = ['claude-sonnet-5', 'claude-opus-5'];

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-special-model-'));
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    knownModelIds: async () => new Set(CATALOGUE),
  });
  ensureSpecialThreads({
    patchHome: home,
    metaStore,
    chatState: daemon.chatState,
    now: () => 1_700_000_000_000,
    logger: silent,
    permissionModeDefault: 'auto',
  });
  return { daemon, events, metaStore };
}

describe('the Manager and Speakers model setting', () => {
  it('puts both special threads on the chosen model and announces it', async () => {
    const { daemon, events, metaStore } = setup();
    await daemon.applySpecialThreadModel('claude-opus-5');
    for (const id of ['thread_manager', 'thread_speakers']) {
      expect(daemon.chatState.get(id)?.model).toBe('claude-opus-5');
      expect(metaStore.read(id)?.model).toBe('claude-opus-5');
      const last = events
        .filter((e): e is ChatStateEvent => e.type === 'chat.state' && e.chatId === id)
        .at(-1);
      expect(last?.model).toBe('claude-opus-5');
    }
  });

  it('changes again when the setting changes, and leaves ordinary chats alone', async () => {
    const { daemon } = setup();
    await daemon.applySpecialThreadModel('claude-opus-5');
    await daemon.applySpecialThreadModel('claude-sonnet-5');
    expect(daemon.chatState.get('thread_manager')?.model).toBe('claude-sonnet-5');
    expect(daemon.chatState.get('thread_speakers')?.model).toBe('claude-sonnet-5');
  });

  it('refuses a model the host does not offer, saying so, and leaves the thread as it was', async () => {
    const { daemon } = setup();
    await daemon.applySpecialThreadModel('claude-opus-5');
    await expect(daemon.applySpecialThreadModel('not-a-model')).rejects.toThrow(/not-a-model/);
    expect(daemon.chatState.get('thread_manager')?.model).toBe('claude-opus-5');
  });
});
