// spec/04 § Reminders — a reminder with a cadence is re-injected into the
// agent's prompt every N turns or N minutes; a plain reminder never is.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

function setup() {
  const prompts: string[] = [];
  const backend: SdkBackend = {
    run: async function* (opts) {
      prompts.push(opts.prompt);
      yield { type: 'assistant', content: 'ok', sessionId: 'sess-1' };
      yield { type: 'result', sessionId: 'sess-1' };
    },
  };
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-remper-folder-')));
  const metaStore = createMetaStore(mkdtempSync(join(tmpdir(), 'patch-remper-')));
  let id = 0;
  let clock = 1_700_000_000_000;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    emit: () => undefined,
    logger: pino({ level: 'silent' }),
    now: () => clock,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, prompts, folder, metaStore, advance: (ms: number) => (clock += ms) };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const MARK = 'Reminder set on this chat by the user';

async function send(daemon: Daemon, chatId: string, n: number) {
  await daemon.sendInput({ chatId, message: `m${n}`, localId: `L${n}`, origin: 'machine' });
  await tick();
}

describe('periodic reminder injection', () => {
  it('turn based: injects on every Nth turn and not between', async () => {
    const { daemon, prompts, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setReminder(chatId, 'Hold to the principles', { unit: 'turns', n: 3 });
    for (let i = 1; i <= 7; i++) await send(daemon, chatId, i);
    const has = prompts.map((p) => p.includes(MARK));
    expect(has).toEqual([false, false, true, false, false, true, false]);
    expect(prompts[2]).toContain('Hold to the principles');
  });

  it('time based: injects once the interval has passed, then restarts the clock', async () => {
    const { daemon, prompts, folder, advance } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setReminder(chatId, 'Principles', { unit: 'minutes', n: 10 });
    await send(daemon, chatId, 1);
    advance(9 * 60_000);
    await send(daemon, chatId, 2);
    advance(2 * 60_000);
    await send(daemon, chatId, 3);
    await send(daemon, chatId, 4);
    expect(prompts.map((p) => p.includes(MARK))).toEqual([false, false, true, false]);
  });

  it('a plain reminder (no cadence) is never injected', async () => {
    const { daemon, prompts, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setReminder(chatId, 'banner only');
    for (let i = 1; i <= 12; i++) await send(daemon, chatId, i);
    expect(prompts.some((p) => p.includes(MARK))).toBe(false);
  });

  it('clearing stops injection and drops the cadence; the cadence persists to meta', async () => {
    const { daemon, prompts, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setReminder(chatId, 'x', { unit: 'turns', n: 1 });
    expect(metaStore.read(chatId)?.reminderEvery).toEqual({ unit: 'turns', n: 1 });
    await send(daemon, chatId, 1);
    expect(prompts[0]).toContain(MARK);
    await daemon.setReminder(chatId, null);
    expect(metaStore.read(chatId)?.reminderEvery ?? null).toBe(null);
    await send(daemon, chatId, 2);
    expect(prompts[1]).not.toContain(MARK);
  });
});

describe('the periodic reminder is disclosed in the transcript', () => {
  it('labels it "Reminder"', async () => {
    const { extractSystemContext } = await import('../src/history.js');
    const { buildPeriodicReminder } = await import('../src/todos.js');
    expect(extractSystemContext(buildPeriodicReminder('Principles') + 'hi')[0]?.label).toBe(
      'Reminder',
    );
  });
});
