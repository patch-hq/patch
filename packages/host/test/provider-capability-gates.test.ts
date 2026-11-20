// Features follow declared capability (spec/02 § Provider adapters) for the
// capabilities every real provider declares today: interrupt, steer and resume.
// A provider without them is simulated by narrowing what `local/` models declare.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ProviderCapability, WireEvent } from '@patch/wire';

const WITHHELD: ReadonlySet<ProviderCapability> = new Set(['interrupt', 'steer', 'resume']);

vi.mock('@patch/wire', async (importOriginal) => {
  const real = await importOriginal<typeof import('@patch/wire')>();
  return {
    ...real,
    modelHasCapability: (model: string | null | undefined, capability: ProviderCapability) =>
      model?.startsWith('local/') === true && WITHHELD.has(capability)
        ? false
        : real.modelHasCapability(model, capability),
  };
});

const { Daemon, CapabilityUnsupportedError } = await import('../src/chatRunner.js');
const { createClaudeSessionProbe } = await import('../src/history.js');
const { createMetaStore } = await import('../src/meta.js');
const { createMockSdkBackend } = await import('../src/sdkBackend.js');

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-capgate-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-capgate-folder-'));
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-capgate-projects-'));
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend({ claudeProjectsRoot: projectsRoot }),
    sessionProbe: createClaudeSessionProbe({ claudeProjectsRoot: projectsRoot }),
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

type Internals = {
  turnQueues: Map<string, Array<Record<string, unknown>>>;
  deliverQueuedAtBoundary(chatId: string): string | undefined;
};

describe('interrupt', () => {
  it('is refused, and said, on a provider that does not declare it', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'local/qwen' });
    events.length = 0;
    expect(daemon.refuseUnlessCapable(chatId, 'interrupt')).toBe(true);
    expect(codes(events)).toEqual(['capability_unsupported']);
  });

  it('goes ahead on a provider that declares it', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    expect(daemon.refuseUnlessCapable(chatId, 'interrupt')).toBe(false);
    expect(codes(events)).toEqual([]);
  });

  it('a send-now (promote) does not interrupt the running turn without it', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'local/qwen' });
    const stop = vi.spyOn(daemon, 'stopChat');
    (daemon as unknown as Internals).turnQueues.set(chatId, [
      { localId: 'q1', message: 'next', queuedAt: 0 },
    ]);
    events.length = 0;
    await daemon.promoteInput(chatId, 'q1');
    expect(stop).not.toHaveBeenCalled();
    expect(codes(events)).toEqual(['capability_unsupported']);
  });
});

describe('steer', () => {
  it('hands nothing into a running turn on a provider that does not declare it', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder, model: 'local/qwen' });
    const internals = daemon as unknown as Internals;
    internals.turnQueues.set(chatId, [{ localId: 'q1', message: 'next', queuedAt: 0 }]);
    expect(internals.deliverQueuedAtBoundary(chatId)).toBeUndefined();
    // Still queued: it runs as its own turn when this one ends.
    expect(internals.turnQueues.get(chatId)).toHaveLength(1);
  });
});

describe('resume', () => {
  it('names the capability it refuses', () => {
    const err = new CapabilityUnsupportedError('c1', 'resume');
    expect(err.code).toBe('capability_unsupported');
    expect(err.message).toBe("resuming the session is not supported by this chat's provider");
  });
});
