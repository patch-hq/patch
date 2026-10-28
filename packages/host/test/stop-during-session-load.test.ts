// A Stop pressed while a resumed turn is still loading its session must end
// that turn. The abort handle used to be registered only after the load, so a
// stop in that window found nothing to abort, did nothing, and the turn ran on.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createHistoryReader } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend, type SdkBackend } from '../src/sdkBackend.js';

describe('stop while a resumed turn loads its session', () => {
  it('aborts the turn instead of letting it run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-stop-load-'));
    const folder = mkdtempSync(join(tmpdir(), 'patch-stop-load-folder-'));
    const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-stop-load-projects-'));
    const mock = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
    let runs = 0;
    const sdk: SdkBackend = {
      run(opts) {
        runs++;
        return mock.run(opts);
      },
    };
    const events: WireEvent[] = [];
    let id = 0;
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: sdk,
      sdkBackendKind: 'real',
      historyReader: createHistoryReader({ claudeProjectsRoot: projectsRoot }),
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: pino({ level: 'silent' }),
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first', localId: 'l1' });
    const runsBefore = runs;

    // Make the next turn's session load slow, so Stop lands inside it.
    let releaseLoad!: () => void;
    const loadHeld = new Promise<void>((r) => (releaseLoad = r));
    (daemon as unknown as Record<string, unknown>)['claudeSessionStoreFor'] = () => ({
      load: async () => {
        await loadHeld;
        return null;
      },
    });
    const state = (
      daemon as unknown as { chatState: Map<string, { claudeSessionId?: string }> }
    ).chatState.get(chatId)!;
    state.claudeSessionId ??= 'sess-1';

    const turn = daemon.sendInput({ chatId, message: 'second', localId: 'l2' });
    await new Promise((r) => setTimeout(r, 20));
    const stop = daemon.stopChat(chatId);
    releaseLoad();
    await Promise.all([turn, stop]);

    expect(runs).toBe(runsBefore);
    expect(events.some((e) => e.type === 'chat.stopped')).toBe(true);
  });
});
