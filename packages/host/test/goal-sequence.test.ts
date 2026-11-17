// spec/04 § Goals — sequence, reminders and check-in. A chat's goal can carry
// goals that start in order once it is met, a cadence on which it is restated
// to the agent, and a cadence on which the judge also says whether the work is
// on track.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';
import { makeGoalEvaluator, parseGoalVerdict } from '../src/goalEval.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface EvalInput {
  condition: string;
  turnsEvaluated: number;
  checkIn?: boolean;
}
type Verdict = {
  verdict: 'met' | 'not_met' | 'refused' | 'impossible';
  reason: string;
  onTrack?: 'on_track' | 'off_track';
  onTrackReason?: string;
};
type Evaluate = (input: EvalInput & Record<string, unknown>) => Promise<Verdict | null>;

function setup(evaluateGoal: Evaluate) {
  const prompts: string[] = [];
  const backend: SdkBackend = {
    async *run(o) {
      prompts.push(o.prompt);
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: 'ok', sessionId: 'sess' };
    },
  };
  const home = mkdtempSync(join(tmpdir(), 'patch-goalseq-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-goalseq-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => Date.now(),
    generateChatId: () => `chat-${++id}`,
    evaluateGoal: evaluateGoal as never,
  });
  return { daemon, folder, events, prompts, metaStore };
}

describe('goal sequence', () => {
  it('starts the next goal, as a turn, when the active one is met', async () => {
    const seen: string[] = [];
    const evaluateGoal: Evaluate = async (i) => {
      seen.push(i.condition);
      return i.condition === 'Third' ? null : { verdict: 'met', reason: `${i.condition} done` };
    };
    const { daemon, folder, events, metaStore } = setup(evaluateGoal);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'First', { then: ['Second', 'Third'] });
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(200);

    expect(seen).toEqual(['First', 'Second', 'Third']);
    const state = daemon.chatState.get(chatId);
    expect(state?.goal).toBe('Third');
    expect(state?.goalQueue).toEqual([]);
    expect(state?.lastGoal).toMatchObject({ condition: 'Second', outcome: 'met' });
    // Each next goal went in as a goal-triggered turn carrying the goal's own text.
    const started = events.filter(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'user' && e.goalTrigger !== undefined,
    );
    expect(started.map((e) => e.content)).toEqual(['Second', 'Third']);
    expect(metaStore.read(chatId)?.goal).toBe('Third');
    expect(metaStore.read(chatId)?.goalQueue).toEqual([]);
  });

  it('shows the queue on chat.state while the first goal runs', async () => {
    const { daemon, folder, events } = setup(async () => null);
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setGoal(chatId, 'First', { then: ['Second'] });
    const last = [...events].reverse().find((e) => e.type === 'chat.state');
    expect(last).toMatchObject({ goal: 'First', goalQueue: ['Second'] });
  });

  it('keeps the cadences across the sequence', async () => {
    const evaluateGoal: Evaluate = async (i) =>
      i.condition === 'First' ? { verdict: 'met', reason: 'done' } : null;
    const { daemon, folder } = setup(evaluateGoal);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'First', {
      then: ['Second'],
      remindEvery: { unit: 'turns', n: 3 },
      checkInEvery: { unit: 'minutes', n: 10 },
    });
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(150);
    const state = daemon.chatState.get(chatId);
    expect(state?.goal).toBe('Second');
    expect(state?.goalReminderEvery).toEqual({ unit: 'turns', n: 3 });
    expect(state?.goalCheckInEvery).toEqual({ unit: 'minutes', n: 10 });
  });

  it('an impossible goal stops the sequence and says how many were not started', async () => {
    const evaluateGoal: Evaluate = async () => ({ verdict: 'impossible', reason: 'No such repo' });
    const { daemon, folder } = setup(evaluateGoal);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'First', { then: ['Second', 'Third'] });
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(100);
    const state = daemon.chatState.get(chatId);
    expect(state?.goal).toBeNull();
    expect(state?.goalQueue).toEqual([]);
    expect(state?.declaredStatus?.text).toContain('No such repo');
    expect(state?.declaredStatus?.text).toContain('2 goals queued after it were not started');
  });

  it('a new plain goal, or a clear, drops the queue and cadences', async () => {
    const { daemon, folder } = setup(async () => null);
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setGoal(chatId, 'First', {
      then: ['Second'],
      remindEvery: { unit: 'turns', n: 2 },
      checkInEvery: { unit: 'turns', n: 2 },
    });
    await daemon.setGoal(chatId, 'Replacement');
    let state = daemon.chatState.get(chatId);
    expect(state?.goalQueue).toEqual([]);
    expect(state?.goalReminderEvery).toBeNull();
    expect(state?.goalCheckInEvery).toBeNull();

    await daemon.setGoal(chatId, 'Again', { then: ['Next'] });
    await daemon.setGoal(chatId, null);
    state = daemon.chatState.get(chatId);
    expect(state?.goal).toBeNull();
    expect(state?.goalQueue).toEqual([]);
  });
});

describe('goal reminders', () => {
  it('restates the goal to the agent every N turns, and not on the turn that sets it', async () => {
    let evals = 0;
    const evaluateGoal: Evaluate = async () =>
      ++evals < 5 ? { verdict: 'not_met', reason: 'keep going' } : null;
    const { daemon, folder, prompts } = setup(evaluateGoal);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Ship it', { remindEvery: { unit: 'turns', n: 2 } });
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(300);

    const marker = "Reminder: this chat's goal is still active";
    const flags = prompts.map((p) => p.includes(marker));
    expect(prompts.length).toBeGreaterThanOrEqual(4);
    // Turn 1 carries the goal-set notice instead; the reminder lands on every 2nd turn after.
    expect(flags.slice(0, 4)).toEqual([false, false, true, false]);
  });

  it('never restates a goal that has no cadence', async () => {
    let evals = 0;
    const evaluateGoal: Evaluate = async () =>
      ++evals < 4 ? { verdict: 'not_met', reason: 'keep going' } : null;
    const { daemon, folder, prompts } = setup(evaluateGoal);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Ship it');
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(250);
    expect(prompts.some((p) => p.includes("Reminder: this chat's goal"))).toBe(false);
  });
});

describe('goal check-in', () => {
  it('asks for an on-track read on its cadence and records it', async () => {
    const asked: Array<boolean | undefined> = [];
    const evaluateGoal: Evaluate = async (i) => {
      asked.push(i.checkIn);
      if (asked.length > 4) return null;
      return i.checkIn === true
        ? {
            verdict: 'not_met',
            reason: 'more to do',
            onTrack: 'on_track',
            onTrackReason: 'Steady progress',
          }
        : { verdict: 'not_met', reason: 'more to do' };
    };
    const { daemon, folder } = setup(evaluateGoal);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Ship it', { checkInEvery: { unit: 'turns', n: 2 } });
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(300);

    expect(asked.slice(0, 4)).toEqual([undefined, true, undefined, true]);
    const progress = daemon.chatState.get(chatId)?.goalProgress;
    expect(progress?.lastCheckIn).toMatchObject({ status: 'on_track', reason: 'Steady progress' });
  });

  it('surfaces the chat, without ending the goal, when it is off track', async () => {
    const evaluateGoal: Evaluate = async (i) =>
      i.turnsEvaluated > 1
        ? null
        : {
            verdict: 'not_met',
            reason: 'more to do',
            onTrack: 'off_track',
            onTrackReason: 'Going in circles on the same test',
          };
    const { daemon, folder } = setup(evaluateGoal);
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'Ship it', { checkInEvery: { unit: 'turns', n: 1 } });
    await daemon.sendInput({ chatId, message: 'go', localId: 'u1' });
    await tick(150);
    const state = daemon.chatState.get(chatId);
    expect(state?.goal).toBe('Ship it');
    expect(state?.goalProgress?.lastCheckIn?.status).toBe('off_track');
    expect(state?.declaredStatus?.kind).toBe('report');
    expect(state?.declaredStatus?.text).toContain('Going in circles');
  });
});

describe('goal judge — check-in', () => {
  const input = {
    chatId: 'c',
    condition: 'Ship it',
    transcript: 't',
    turnsEvaluated: 2,
    folder: '/x',
    background: 'none',
    userScope: 's',
    agentStatement: 'a',
  };
  it('parses an on-track read, and rejects a half-formed one', () => {
    expect(
      parseGoalVerdict(
        '{"verdict":"not_met","reason":"r","onTrack":"off_track","onTrackReason":"stuck"}',
      ),
    ).toEqual({ verdict: 'not_met', reason: 'r', onTrack: 'off_track', onTrackReason: 'stuck' });
    expect(parseGoalVerdict('{"verdict":"not_met","reason":"r","onTrack":"maybe"}')).toBeNull();
    expect(parseGoalVerdict('{"verdict":"not_met","reason":"r","onTrack":"on_track"}')).toBeNull();
  });
  it('asks for the on-track read only on a check-in', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: '{"verdict":"met","reason":"ok"}' },
      { type: 'result', sessionId: 's' },
    ]);
    const evaluate = makeGoalEvaluator({
      sdkBackend: sdk,
      resolveOAuth: () => ({ ok: true, accessToken: 't' }),
      logger: silent,
    });
    await evaluate(input);
    expect(sdk.lastOptions()?.prompt).not.toContain('CHECK-IN');
    sdk.enqueue([
      { type: 'assistant', content: '{"verdict":"met","reason":"ok"}' },
      { type: 'result', sessionId: 's' },
    ]);
    await evaluate({ ...input, checkIn: true });
    expect(sdk.lastOptions()?.prompt).toContain('CHECK-IN');
    expect(sdk.lastOptions()?.prompt).toContain('onTrackReason');
  });
});
