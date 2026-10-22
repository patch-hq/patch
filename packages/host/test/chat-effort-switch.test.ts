// Mid-chat thinking-effort changes (spec/04 § Effort).
//
// The properties under test are the ones a fallback would quietly break:
//   1. A change takes effect on the NEXT turn, read off `state.effort`.
//   2. `effort: null` clears the override rather than requiring a level.
//   3. A chat on the Codex backend refuses the change — Codex has no
//      equivalent option — rather than silently accepting it.
//   4. The change is persisted, so a daemon restart does not silently drop it.
//   5. The new effort rides out on `chat.state`, like `model` does.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatStateEvent, WireEvent } from '@patch/wire';
import { Daemon, EffortNotSupportedError } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { chatStateFromMeta } from '../src/chatState.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-effort-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-effort-folder-')));
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
  });
  return { daemon, sdk, events, home, folder, metaStore };
}

function states(events: WireEvent[]): ChatStateEvent[] {
  return events.filter((e): e is ChatStateEvent => e.type === 'chat.state');
}

describe('a chat effort change takes effect on the next turn', () => {
  it('the next turn reaches the SDK carrying the newly chosen effort', async () => {
    const { daemon, sdk, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6', prompt: 'go' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.lastOptions()?.effort).toBeUndefined();

    await daemon.setChatEffort(chatId, 'high');
    await daemon.sendInput({ chatId, message: 'again', localId: 'L1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.lastOptions()?.effort).toBe('high');
  });

  it('clears the override with effort: null, read as "no effort" by the next turn', async () => {
    const { daemon, sdk, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6' });
    await daemon.setChatEffort(chatId, 'low');
    await daemon.setChatEffort(chatId, null);
    await daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.lastOptions()?.effort).toBeUndefined();
  });
});

describe('a chat effort change is refused on a non-Claude backend', () => {
  it('rejects the change for a chat on the Codex backend', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'openai/gpt-5-codex' });
    await expect(daemon.setChatEffort(chatId, 'high')).rejects.toBeInstanceOf(
      EffortNotSupportedError,
    );
  });

  it('leaves the chat with no effort override after a refusal', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'openai/gpt-5-codex' });
    await daemon.setChatEffort(chatId, 'high').catch(() => {});
    expect(metaStore.read(chatId)?.effort).toBeUndefined();
  });

  it('rejects an effort change for a chat this host does not have', async () => {
    const { daemon } = setup();
    await expect(daemon.setChatEffort('nope', 'high')).rejects.toThrow(/nope/);
  });
});

describe('a chat effort override survives a provider switch', () => {
  it('stays stored (but inert) across a switch to Codex, and reapplies on a switch back', async () => {
    const { daemon, sdk, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6' });
    await daemon.setChatEffort(chatId, 'max');

    await daemon.setChatModel(chatId, 'openai/gpt-5-codex');
    // Still on the books — a model switch does not silently drop a choice the
    // user made about this chat's effort.
    expect(metaStore.read(chatId)?.effort).toBe('max');

    await daemon.setChatModel(chatId, 'claude-sonnet-4-6');
    await daemon.sendInput({ chatId, message: 'go', localId: 'L1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.lastOptions()?.effort).toBe('max');
  });
});

describe('a chat effort change survives a daemon restart', () => {
  it('writes the new effort to the chat meta', async () => {
    const { daemon, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6' });
    await daemon.setChatEffort(chatId, 'max');
    expect(metaStore.read(chatId)?.effort).toBe('max');
  });

  it('a restarted daemon runs the next turn carrying the changed effort', async () => {
    const { daemon, folder, home } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6' });
    await daemon.setChatEffort(chatId, 'max');

    const sdk = createMockSdkBackend();
    const restarted = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: sdk,
      oauthAccessToken: 'fake-token',
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
      generateChatId: () => 'unused',
    });
    restarted.hydrate();
    await restarted.sendInput({ chatId, message: 'again', localId: 'L1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sdk.lastOptions()?.effort).toBe('max');
  });

  it('a chat with a persisted effort hydrates carrying it', () => {
    const s = chatStateFromMeta({
      chatId: 'c1',
      folder: '/work',
      name: null,
      nextSeq: 0,
      createdAt: 1,
      updatedAt: 1,
      effort: 'low',
    });
    expect(s.effort).toBe('low');
  });

  it('a chat with no persisted effort hydrates with none, rather than a guess', () => {
    const s = chatStateFromMeta({
      chatId: 'c1',
      folder: '/work',
      name: null,
      nextSeq: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(s.effort).toBeUndefined();
  });
});

describe('a chat effort change reaches every surface holding the chat', () => {
  it('emits a chat.state carrying the new effort', async () => {
    const { daemon, folder, events } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6' });
    events.length = 0;
    await daemon.setChatEffort(chatId, 'medium');
    const emitted = states(events);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.at(-1)?.effort).toBe('medium');
  });

  it('carries effort:null on every chat.state for a Claude chat with no override set', async () => {
    const { daemon, folder, events } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'claude-sonnet-4-6' });
    events.length = 0;
    await daemon.setPinned(chatId, true);
    expect(states(events).at(-1)?.effort).toBeNull();
  });

  it('omits the effort field entirely for a chat on the Codex backend', async () => {
    const { daemon, folder, events } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'openai/gpt-5-codex' });
    events.length = 0;
    await daemon.setPinned(chatId, true);
    expect(states(events).at(-1)?.effort).toBeUndefined();
  });
});
