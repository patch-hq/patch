// Chats on a local model (docs/providers.md): a later turn resumes the local
// harness's own session, and a chat on another provider cannot switch onto one
// in place (spec/04 § Provider switches).

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

describe('local model chats', () => {
  it('a Claude chat cannot switch onto a local model: that starts a new linked chat', async () => {
    const { daemon, local, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, model: CLAUDE_MODEL });
    await daemon.sendInput({ chatId, message: 'hello claude', localId: 'l1' });
    await expect(daemon.setChatModel(chatId, LOCAL_MODEL)).rejects.toMatchObject({
      code: 'provider_switch_needs_new_chat',
    });
    expect(metaStore.read(chatId)!.model).toBe(CLAUDE_MODEL);
    expect(local.calls).toHaveLength(0);
  });

  it('a second turn on a local chat resumes its session without reseeding', async () => {
    const { daemon, local, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder, model: LOCAL_MODEL });
    await daemon.sendInput({ chatId, message: 'one', localId: 'l1' });
    const session = metaStore.read(chatId)!.claudeSessionId!;
    expect(session).toMatch(/^local-/);
    await daemon.sendInput({ chatId, message: 'two', localId: 'l2' });
    const second = local.calls[1]!;
    expect(second.resumeSessionId).toBe(session);
    expect(second.localReseed).toBeUndefined();
  });

  it('a chat spawned on a local model has no effort control', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: LOCAL_MODEL });
    await expect(daemon.setChatEffort(chatId, 'high')).rejects.toThrow();
  });
});
