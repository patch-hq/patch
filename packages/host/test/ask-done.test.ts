// Done on a patch_ask_human (spec/04 § Current status): the ask clears, the
// agent is told (user path), and the snooze the ask woke the chat from resumes.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { SNOOZE_UNTIL_COMPLETE } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const T0 = 1_700_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gated() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const backend: SdkBackend = {
    run: async function* () {
      await gate;
      yield { type: 'assistant', content: 'ok', sessionId: 's' };
      yield { type: 'result', sessionId: 's' };
    },
  };
  return { backend, release };
}

async function snoozedThenAsked(task: string) {
  const { backend, release } = gated();
  const home = mkdtempSync(join(tmpdir(), 'patch-askdone-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-askdone-f-')));
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: backend,
    oauthAccessToken: 'x',
    emit: () => {},
    logger: pino({ level: 'silent' }),
    now: () => T0,
    generateChatId: () => `chat-${++id}`,
  });
  const chatId = await daemon.spawnChat({ folder });
  void daemon.sendInput({ chatId, message: 'go', localId: 'L1', origin: 'user' });
  await sleep(20);
  await daemon.setSnoozed(chatId, SNOOZE_UNTIL_COMPLETE);
  await daemon.declareStatus(chatId, 'question', task);
  await sleep(20);
  return { daemon, chatId, release };
}

describe('resolveAsk', () => {
  it('the ask wakes the snooze; the agent clearing it puts the snooze back', async () => {
    const { daemon, chatId, release } = await snoozedThenAsked('plug the drive in');
    const st = daemon.chatState.get(chatId)!;
    expect(st.snoozedUntil).toBe(null);
    expect(st.snoozeRecords.at(-1)?.outcome.kind).toBe('waiting');

    await daemon.resolveAsk(chatId, 'agent');
    expect(st.declaredStatus).toBe(null);
    expect(st.statusKind).toBe(null);
    expect(st.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    release();
    daemon.shutdown();
  });

  it('the user pressing Done clears the ask, sends "Done: <task>" and restores the snooze', async () => {
    const { daemon, chatId, release } = await snoozedThenAsked('plug the drive in');
    const send = vi.spyOn(daemon, 'sendInput');
    await daemon.resolveAsk(chatId, 'user');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ chatId, message: 'Done: plug the drive in' }),
    );
    const st = daemon.chatState.get(chatId)!;
    expect(st.declaredStatus).toBe(null);
    expect(st.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    release();
    daemon.shutdown();
  });

  it('refuses when nothing is outstanding', async () => {
    const { daemon, chatId, release } = await snoozedThenAsked('x');
    await daemon.resolveAsk(chatId, 'agent');
    await expect(daemon.resolveAsk(chatId, 'user')).rejects.toThrow(/not waiting on an action/);
    release();
    daemon.shutdown();
  });
});
