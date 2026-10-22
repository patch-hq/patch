import { describe, it, expect, vi } from 'vitest';
import {
  matchModel,
  parseClear,
  runSlashCommand,
  SLASH_COMMANDS,
  type SlashDeps,
} from '../src/lib/slashCommands';

const tick = () => new Promise((r) => setTimeout(r, 0));

function deps(over: Partial<SlashDeps> = {}) {
  const d = {
    chatId: 'c1',
    hostId: 'home' as string | null,
    goal: 'old goal' as string | null,
    reminder: 'old reminder' as string | null,
    setGoal: vi.fn(),
    setReminder: vi.fn(),
    clearTimeline: vi.fn(),
    chooseModel: vi.fn(),
    pushError: vi.fn(),
    api: {
      setGoal: vi.fn().mockResolvedValue(undefined),
      setReminder: vi.fn().mockResolvedValue(undefined),
      setLoop: vi.fn().mockResolvedValue(undefined),
      models: vi.fn().mockResolvedValue({
        models: [
          { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
          { id: 'claude-opus-5-5', label: 'Opus 5.5' },
        ],
      }),
    },
    ...over,
  };
  return d as typeof d & SlashDeps;
}

describe('slash commands', () => {
  it('lists the built-ins', () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(['clear', 'goal', 'remind', 'loop', 'model']);
  });

  it('an ordinary message is not a command', () => {
    const d = deps();
    expect(runSlashCommand('hello /goal', d)).toEqual({ handled: false, text: 'hello /goal' });
    expect(runSlashCommand('/clearance', d)).toEqual({ handled: false, text: '/clearance' });
    expect(runSlashCommand('/goals x', d)).toEqual({ handled: false, text: '/goals x' });
  });

  it('/clear clears the visible transcript only, with no arguments', () => {
    const d = deps();
    expect(parseClear(' /CLEAR ')).toBe(true);
    expect(parseClear('/clear foo')).toBe(false);
    expect(runSlashCommand('/clear', d)).toEqual({ handled: true });
    expect(d.clearTimeline).toHaveBeenCalled();
  });

  it('/goal <text> sets the goal and sends the text as the turn', async () => {
    const d = deps();
    expect(runSlashCommand('/goal ship it', d)).toEqual({ handled: false, text: 'ship it' });
    expect(d.setGoal).toHaveBeenCalledWith('ship it');
    expect(d.api.setGoal).toHaveBeenCalledWith('c1', 'ship it');
  });

  it('bare /goal clears and sends nothing', () => {
    const d = deps();
    expect(runSlashCommand('/goal', d)).toEqual({ handled: true });
    expect(d.api.setGoal).toHaveBeenCalledWith('c1', null);
  });

  it('a failed goal write reverts the local goal and says so', async () => {
    const d = deps();
    d.api.setGoal.mockRejectedValue(new Error('nope'));
    runSlashCommand('/goal x', d);
    await tick();
    expect(d.setGoal).toHaveBeenLastCalledWith('old goal');
    expect(d.pushError).toHaveBeenCalledWith('setting goal failed: nope');
  });

  it('/remind sets, clears, and reverts on failure — never sent as a turn', async () => {
    const d = deps();
    expect(runSlashCommand('/remind call mum', d)).toEqual({ handled: true });
    expect(d.api.setReminder).toHaveBeenCalledWith('c1', 'call mum');
    runSlashCommand('/remind', d);
    expect(d.api.setReminder).toHaveBeenLastCalledWith('c1', null);
    d.api.setReminder.mockRejectedValue(new Error('bad'));
    runSlashCommand('/remind again', d);
    await tick();
    expect(d.setReminder).toHaveBeenLastCalledWith('old reminder');
    expect(d.pushError).toHaveBeenCalledWith('setting reminder failed: bad');
  });

  it('/loop arms, cancels, rejects an incomplete arm, and reports failures', async () => {
    const d = deps();
    expect(runSlashCommand('/loop 5m check the build', d)).toEqual({ handled: true });
    expect(d.api.setLoop).toHaveBeenCalledWith('c1', { every: '5m', message: 'check the build' });
    runSlashCommand('/loop', d);
    expect(d.api.setLoop).toHaveBeenLastCalledWith('c1', null);
    runSlashCommand('/loop 5m', d);
    expect(d.pushError).toHaveBeenCalledWith('usage: /loop <interval> <message>');
    expect(d.api.setLoop).toHaveBeenCalledTimes(2);
    d.api.setLoop.mockRejectedValue(new Error('x'));
    runSlashCommand('/loop 1h hi', d);
    runSlashCommand('/loop', d);
    await tick();
    expect(d.pushError).toHaveBeenCalledWith('starting loop failed: x');
    expect(d.pushError).toHaveBeenCalledWith('stopping loop failed: x');
  });

  it('/model picks from the chat host catalogue by label, id or unique substring', async () => {
    const d = deps();
    expect(runSlashCommand('/model opus', d)).toEqual({ handled: true });
    await tick();
    expect(d.api.models).toHaveBeenCalledWith('home');
    expect(d.chooseModel).toHaveBeenCalledWith('claude-opus-5-5');
  });

  it('/model errors: bare, unknown, ambiguous, no host, catalogue failure', async () => {
    const d = deps();
    runSlashCommand('/model', d);
    expect(d.pushError).toHaveBeenCalledWith('usage: /model <name>');
    runSlashCommand('/model gpt', d);
    await tick();
    expect(d.pushError).toHaveBeenCalledWith('model not found: gpt');
    runSlashCommand('/model 5.5', d);
    await tick();
    expect(d.pushError).toHaveBeenCalledWith(
      '"5.5" matches more than one model: Sonnet 5.5, Opus 5.5',
    );
    expect(d.chooseModel).not.toHaveBeenCalled();
    const none = deps({ hostId: null });
    runSlashCommand('/model opus', none);
    expect(none.pushError).toHaveBeenCalledWith(
      'model failed: this chat has no machine to read models from',
    );
    const broken = deps();
    broken.api.models.mockRejectedValue(new Error('offline'));
    runSlashCommand('/model opus', broken);
    await tick();
    expect(broken.pushError).toHaveBeenCalledWith('model failed: offline');
  });

  it('matchModel prefers an exact match over substrings', () => {
    const models = [
      { id: 'a', label: 'Opus' },
      { id: 'b', label: 'Opus Max' },
    ];
    expect(matchModel('opus', models)).toEqual({ status: 'found', modelId: 'a' });
  });
});
