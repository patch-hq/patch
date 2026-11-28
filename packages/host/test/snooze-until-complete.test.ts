// "Snooze → Until complete" (spec/04 § Snooze): the chat leaves the list and
// comes back on its own once its work is done — turn returned and no goal left.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
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

function setup(backend: SdkBackend, home?: string, evaluateGoal?: unknown) {
  const h = home ?? mkdtempSync(join(tmpdir(), 'patch-snzc-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-snzc-f-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(h);
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: backend,
    oauthAccessToken: 'x',
    emit: () => {},
    logger: pino({ level: 'silent' }),
    now: () => T0,
    generateChatId: () => `chat-${++id}`,
    ...(evaluateGoal ? { evaluateGoal: evaluateGoal as never } : {}),
  });
  return { daemon, folder, metaStore, home: h };
}

describe('Snooze until complete', () => {
  it('stays snoozed while the turn runs and wakes when it returns', async () => {
    const { backend, release } = gated();
    const { daemon, folder, metaStore } = setup(backend);
    const id = await daemon.spawnChat({ folder });
    const turn = daemon.sendInput({ chatId: id, message: 'go', localId: 'L1', origin: 'user' });
    await sleep(20);
    await daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE);
    await sleep(40);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    expect(daemon.listWithFilter().some((c) => c.chatId === id)).toBe(false);

    release();
    await turn;
    await sleep(80);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(null);
    expect(metaStore.read(id)?.snoozedUntil).toBe(null);
    expect(daemon.listWithFilter().some((c) => c.chatId === id)).toBe(true);
    const rec = daemon.chatState.get(id)!.snoozeRecords.at(-1)!;
    expect(rec.outcome.kind).toBe('finished');
    expect(rec.endedAt).not.toBe(null);
    daemon.shutdown();
  });

  it('stays snoozed after a turn returns while a goal is still open, wakes when it clears', async () => {
    const { backend, release } = gated();
    const { daemon, folder } = setup(backend);
    const id = await daemon.spawnChat({ folder });
    await daemon.setGoal(id, 'ship it');
    await daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    release();
    await daemon.sendInput({ chatId: id, message: 'go', localId: 'L1', origin: 'user' });
    await sleep(80);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    await daemon.setGoal(id, null);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });

  it('stays snoozed between goals of a sequence, wakes when the last one is met', async () => {
    const { backend, release } = gated();
    release();
    const { daemon, folder } = setup(backend, undefined, async (i) =>
      i.condition === 'Third' ? null : { verdict: 'met', reason: 'done' },
    );
    const id = await daemon.spawnChat({ folder });
    await daemon.setGoal(id, 'First', { then: ['Second', 'Third'] });
    await daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE);
    const seen: Array<number | null> = [];
    daemon.chatState.get(id);
    await daemon.sendInput({ chatId: id, message: 'go', localId: 'L1', origin: 'user' });
    await sleep(200);
    seen.push(daemon.chatState.get(id)?.snoozedUntil ?? null);
    expect(daemon.chatState.get(id)?.goal).toBe('Third');
    expect(seen).toEqual([SNOOZE_UNTIL_COMPLETE]);
    await daemon.setGoal(id, null);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });

  it('a question wakes a snoozed goal chat, and answering it puts the chat back to sleep', async () => {
    const { backend, release } = gated();
    const { daemon, folder } = setup(backend);
    const id = await daemon.spawnChat({ folder });
    await daemon.setGoal(id, 'ship it');
    await daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE);
    await daemon.declareStatus(id, 'question', 'Which account should I use?');
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(null);
    expect(daemon.listWithFilter().some((c) => c.chatId === id)).toBe(true);
    release();
    await daemon.sendInput({ chatId: id, message: 'the work one', localId: 'L1', origin: 'user' });
    await sleep(80);
    expect(daemon.chatState.get(id)?.declaredStatus).toBe(null);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    expect(daemon.listWithFilter().some((c) => c.chatId === id)).toBe(false);
    await daemon.setGoal(id, null);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });

  it('the goal-blocked question is cleared when the goal runs again', async () => {
    const { backend, release } = gated();
    const { daemon, folder } = setup(backend);
    const id = await daemon.spawnChat({ folder });
    await daemon.setGoal(id, 'ship it');
    daemon.holdGoalForUser(id);
    await daemon.declareStatus(id, 'question', 'Goal waiting on you: Apple');
    release();
    await daemon.sendInput({ chatId: id, message: 'tick', localId: 'M1', origin: 'machine' });
    await sleep(40);
    const st = daemon.chatState.get(id)!;
    expect(st.declaredStatus).toBe(null);
    expect(st.goalProgress?.waitingOnUser).toBe(false);
    daemon.shutdown();
  });

  it('stays snoozed through a one-shot wake and wakes when the wake is cancelled', async () => {
    const { backend } = gated();
    const { daemon, folder } = setup(backend);
    const id = await daemon.spawnChat({ folder });
    daemon.scheduleWake(id, { in: '1h', message: 'check again' });
    await daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    daemon.cancelWake(id);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });

  it('a chat already waiting on the user when snoozed stays snoozed until a new stop', async () => {
    const { backend } = gated();
    const { daemon, folder } = setup(backend);
    const id = await daemon.spawnChat({ folder });
    await daemon.setGoal(id, 'wait for Apple');
    await daemon.declareStatus(id, 'question', 'waiting on Apple');
    await daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE);
    await sleep(40);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    await daemon.setGoal(id, null);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });

  it('refuses a chat whose only wake is a loop', async () => {
    const { backend } = gated();
    const { daemon, folder } = setup(backend);
    const id = await daemon.spawnChat({ folder });
    daemon.scheduleWake(id, { in: '1h', every: '1h', message: 'tick' });
    await expect(daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE)).rejects.toThrow(/no running work/);
    daemon.shutdown();
  });

  it('a project snooze waits for the whole set: an idle chat joins and all wake together', async () => {
    const { backend, release } = gated();
    const { daemon, folder } = setup(backend);
    const busy = await daemon.spawnChat({ folder });
    const idle = await daemon.spawnChat({ folder });
    const turn = daemon.sendInput({ chatId: busy, message: 'go', localId: 'L1', origin: 'user' });
    await sleep(20);
    const opts = { setId: 'set-p', waitForSet: true };
    await daemon.setSnoozed(busy, SNOOZE_UNTIL_COMPLETE, opts);
    await daemon.setSnoozed(idle, SNOOZE_UNTIL_COMPLETE, opts);
    await sleep(40);
    expect(daemon.chatState.get(idle)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    release();
    await turn;
    await sleep(80);
    expect(daemon.chatState.get(busy)?.snoozedUntil).toBe(null);
    expect(daemon.chatState.get(idle)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });

  it('a project snooze with no chat that has work is refused', async () => {
    const { backend } = gated();
    const { daemon, folder } = setup(backend);
    const idle = await daemon.spawnChat({ folder });
    await expect(
      daemon.setSnoozed(idle, SNOOZE_UNTIL_COMPLETE, { setId: 'set-p', waitForSet: true }),
    ).rejects.toThrow(/no running work/);
    daemon.shutdown();
  });

  it('refuses a chat with nothing running and no goal', async () => {
    const { backend } = gated();
    const { daemon, folder } = setup(backend);
    const id = await daemon.spawnChat({ folder });
    await expect(daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE)).rejects.toThrow(/no running work/);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });

  it('a host restart wakes it when nothing is left to resume', async () => {
    const { backend } = gated();
    const first = setup(backend);
    const id = await first.daemon.spawnChat({ folder: first.folder });
    await first.daemon.setGoal(id, 'ship it');
    await first.daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE);
    first.daemon.shutdown();
    const second = setup(backend, first.home);
    second.daemon.hydrate();
    expect(second.daemon.chatState.get(id)?.snoozedUntil ?? null).toBe(null);
    second.daemon.shutdown();
  });

  it('a host restart keeps it while the turn is interrupted and continued, then wakes when that returns', async () => {
    const first = gated();
    const a = setup(first.backend);
    const id = await a.daemon.spawnChat({ folder: a.folder });
    void a.daemon.sendInput({ chatId: id, message: 'go', localId: 'L1', origin: 'user' });
    await sleep(20);
    await a.daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE);
    // No shutdown(): a killed host is what leaves the turn owed in meta.json.

    const second = gated();
    const b = setup(second.backend, a.home);
    b.daemon.hydrate();
    await sleep(40);
    expect(b.daemon.chatState.get(id)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    expect(b.metaStore.read(id)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);

    // The cut-off turn comes back when it is continued (spec/12 § Continue).
    await b.daemon.continueChat(id);
    await sleep(20);
    second.release();
    await sleep(60);
    expect(b.daemon.chatState.get(id)?.snoozedUntil ?? null).toBe(null);
    b.daemon.shutdown();
    first.release();
    a.daemon.shutdown();
  });

  it('a turn that errors while the host is going down does not end it', async () => {
    const failing: SdkBackend = {
      run: async function* () {
        await sleep(30);
        throw new Error('claude process exited');
      },
    };
    const { daemon, folder, metaStore } = setup(failing);
    const id = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId: id, message: 'go', localId: 'L1', origin: 'user' });
    await sleep(10);
    await daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE);
    daemon.beginShutdown();
    await sleep(120);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    expect(metaStore.read(id)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    daemon.shutdown();
  });

  it('stays snoozed while a delegated agent is still running, and wakes once all agents are done', async () => {
    const { backend, release } = gated();
    const { daemon, folder } = setup(backend);
    const parent = await daemon.spawnChat({ folder });
    // The parent itself is idle; only its agent has work in flight.
    const { id: agent } = await daemon.createDelegate({ parentChatId: parent, prompt: 'research' });
    await sleep(20);
    expect(daemon.chatState.get(agent)?.subagent?.outcome).toBeUndefined();

    await daemon.setSnoozed(parent, SNOOZE_UNTIL_COMPLETE);
    await sleep(60);
    expect(daemon.chatState.get(parent)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);

    release();
    await sleep(300);
    expect(daemon.chatState.get(agent)?.subagent?.outcome).toBe('done');
    expect(daemon.chatState.get(parent)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });

  it('stays snoozed while a delegated agent is still running, and wakes once all agents are done', async () => {
    const { backend, release } = gated();
    const { daemon, folder } = setup(backend);
    const parent = await daemon.spawnChat({ folder });
    // The parent itself is idle; only its agent has work in flight.
    const { id: agent } = await daemon.createDelegate({ parentChatId: parent, prompt: 'research' });
    await sleep(20);
    expect(daemon.chatState.get(agent)?.subagent?.outcome).toBeUndefined();

    await daemon.setSnoozed(parent, SNOOZE_UNTIL_COMPLETE);
    await sleep(60);
    expect(daemon.chatState.get(parent)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);

    release();
    await sleep(300);
    expect(daemon.chatState.get(agent)?.subagent?.outcome).toBe('done');
    expect(daemon.chatState.get(parent)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });
});
