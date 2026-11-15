// A chat switching onto and between local models (docs/providers.md): the
// switch hands the local harness the chat's track, and a later turn on the
// local model resumes its own session rather than rebuilding.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createHistoryReader } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import {
  createMockSdkBackend,
  type SdkBackend,
  type SdkEnvelope,
  type SdkRunOptions,
} from '../src/sdkBackend.js';
import { isLocalModel } from '../src/localModels.js';

const silent = pino({ level: 'silent' });
const CLAUDE_MODEL = 'claude-opus-5';
const LOCAL_MODEL = 'local/qwen3:8b';

function mockLocalBackend(known: Set<string>) {
  let counter = 0;
  const calls: SdkRunOptions[] = [];
  const backend: SdkBackend = {
    async *run(opts: SdkRunOptions): AsyncGenerator<SdkEnvelope> {
      calls.push(opts);
      const prior = opts.resumeSessionId?.startsWith('local-') ? opts.resumeSessionId : undefined;
      const sessionId = prior ?? `local-${++counter}`;
      known.add(sessionId);
      yield { type: 'system', sessionId };
      yield { type: 'assistant', content: `local reply to: ${opts.prompt}` };
      yield { type: 'result', sessionId };
    },
  };
  return { backend, calls };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-local-switch-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-local-switch-folder-'));
  mkdirSync(folder, { recursive: true });
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-local-switch-projects-'));
  const mockClaude = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
  const known = new Set<string>();
  const local = mockLocalBackend(known);
  const routed: SdkBackend = {
    run: (o) => (isLocalModel(o.model) ? local.backend.run(o) : mockClaude.run(o)),
  };
  const claudeHistory = createHistoryReader({ claudeProjectsRoot: projectsRoot });
  const historyReader = {
    hasSession: (o: { folder: string; sessionId: string }) =>
      o.sessionId.startsWith('local-') ? known.has(o.sessionId) : claudeHistory.hasSession(o),
    read: (o: Parameters<typeof claudeHistory.read>[0]) => claudeHistory.read(o),
    forkPoint: (o: Parameters<typeof claudeHistory.forkPoint>[0]) => claudeHistory.forkPoint(o),
    sidePoint: (o: Parameters<typeof claudeHistory.sidePoint>[0]) => claudeHistory.sidePoint(o),
  };
  const events: WireEvent[] = [];
  const metaStore = createMetaStore(home);
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: routed,
    historyReader,
    claudeProjectsRoot: projectsRoot,
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, local, folder, metaStore };
}

describe('local model provider switch', () => {
  it('switching onto a local model seeds it from the track, and the mode follows the provider', async () => {
    const { daemon, local, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, model: CLAUDE_MODEL });
    await daemon.sendInput({ chatId, message: 'hello claude', localId: 'l1' });
    await daemon.setChatModel(chatId, LOCAL_MODEL);
    await daemon.sendInput({ chatId, message: 'hello local', localId: 'l2' });

    const opts = local.calls[0]!;
    expect(opts.localReseed).toBeDefined();
    expect(opts.codexReseed).toBeUndefined();
    const texts = opts.localReseed!.events.flatMap((t) =>
      t.event.type === 'chat.message' && t.event.role !== 'system' ? [t.event.content] : [],
    );
    expect(texts[0]).toBe('hello claude');
    expect(texts).toHaveLength(2);
    expect(metaStore.read(chatId)!.claudeSessionId).toMatch(/^local-/);
    // Local cannot run `auto`: the chat is not left on it.
    expect(opts.permissionMode).not.toBe('auto');
  });

  it('a second turn on the local model resumes its session without reseeding', async () => {
    const { daemon, local, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, model: CLAUDE_MODEL });
    await daemon.sendInput({ chatId, message: 'one', localId: 'l1' });
    await daemon.setChatModel(chatId, LOCAL_MODEL);
    await daemon.sendInput({ chatId, message: 'two', localId: 'l2' });
    const session = metaStore.read(chatId)!.claudeSessionId!;
    await daemon.sendInput({ chatId, message: 'three', localId: 'l3' });
    const third = local.calls[1]!;
    expect(third.resumeSessionId).toBe(session);
    expect(third.localReseed).toBeUndefined();
  });

  it('a chat spawned on a local model has no effort control', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: LOCAL_MODEL });
    await expect(daemon.setChatEffort(chatId, 'high')).rejects.toThrow();
  });
});
