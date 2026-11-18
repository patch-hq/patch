// A message the server held for this host while it was offline expired
// undelivered (spec/12 § Host-offline UX). The chat's own writer records it in
// the chat, so it is part of the record, not only a notice surfaces saw once.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { OUT_OF_BAND_SEQ, type WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { handleServerEvent } from '../src/index.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-held-exp-h-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-held-exp-hf-')));
  const events: WireEvent[] = [];
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: {
      run: async function* () {
        yield { type: 'result', sessionId: 's', content: '', raw: {} };
      },
    },
    resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
    emit: (e) => events.push(e),
    logger: silent,
    now: () => Date.now(),
    generateChatId: () => 'chat-held',
  });
  return { daemon, events, folder };
}

describe('a held message that expired is recorded in its chat', () => {
  it('writes a logged chat.error naming the host and the message', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await handleServerEvent(
      {
        type: 'chat.held_input_expired',
        chatId,
        text: 'please deploy',
        heldAt: 1,
        hostName: 'Studio Mac',
      },
      daemon,
      () => undefined,
      silent,
    );
    const err = events.find((e) => e.type === 'chat.error') as
      | Extract<WireEvent, { type: 'chat.error' }>
      | undefined;
    expect(err?.error.code).toBe('held_message_expired');
    expect(err?.error.message).toMatch(/Not delivered.*Studio Mac/);
    expect(err?.error.message).toMatch(/please deploy/);
    // A real seq in the chat's stream: part of the record, not out of band.
    expect(err?.seq).not.toBe(OUT_OF_BAND_SEQ);
    daemon.shutdown();
  });

  it('writes nothing for a chat this host does not have', () => {
    const { daemon, events } = setup();
    daemon.recordHeldInputExpired('no-such-chat', 'x', 'Studio Mac');
    expect(events.filter((e) => e.type === 'chat.error')).toEqual([]);
    daemon.shutdown();
  });
});
