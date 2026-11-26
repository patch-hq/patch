// Archiving kills a chat's background work silently. On restore the log says
// what was stopped, and the agent's next message carries the same note once.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';

const NOW = 1_700_000_000_000;
const backend: SdkBackend = {
  run: (): AsyncGenerator<SdkEnvelope> => {
    async function* gen(): AsyncGenerator<SdkEnvelope> {
      /* settles with no output */
    }
    return gen();
  },
};

describe('archive then restore', () => {
  it('logs what archiving stopped, once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-arch-note-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-arch-note-f-')));
    const events: WireEvent[] = [];
    const daemon = new Daemon({
      home,
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: backend,
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: (e) => events.push(e),
      logger: pino({ level: 'silent' }),
      now: () => NOW,
      generateChatId: () => 'chat-1',
    });
    const chatId = await daemon.spawnChat({ folder });
    daemon.scheduleWake(chatId, { in: '1h', message: 'check' });
    const notes = (): string[] =>
      events.flatMap((e) =>
        e.type === 'chat.message' &&
        e.role === 'system' &&
        e.content.startsWith('Chat was archived')
          ? [e.content]
          : [],
      );

    await daemon.setArchived(chatId, true);
    expect(notes()).toHaveLength(0);
    await daemon.setArchived(chatId, false);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toContain('scheduled wake');
    await daemon.setArchived(chatId, true);
    await daemon.setArchived(chatId, false);
    expect(notes()).toHaveLength(1);
    daemon.shutdown();
  });
});
