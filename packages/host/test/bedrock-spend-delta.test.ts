// spec/10 § Spending caps — a Bedrock account's spend is what each turn cost.
// Claude Code's `total_cost_usd` is the process's running total, so a warm
// process answering several prompts must report each result's own cost, and a
// warm process must never carry a turn on another account. No real AWS or
// Anthropic: the SDK is a scripted fake.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SdkRunOptions } from '../src/sdkBackend.js';

/** Every process the fake SDK started, with its env and the prompts it answered. */
const processes: Array<{ env: Record<string, string | undefined>; prompts: string[] }> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query(args: {
    prompt: AsyncIterable<{ message: { content: string } }>;
    options: { env: Record<string, string | undefined> };
  }) {
    const proc = { env: args.options.env, prompts: [] as string[] };
    processes.push(proc);
    let total = 0;
    const gen = (async function* () {
      for await (const user of args.prompt) {
        proc.prompts.push(user.message.content);
        // Each prompt costs 0.10; the result carries the process's running total.
        total = Math.round((total + 0.1) * 100) / 100;
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
        yield { type: 'result', subtype: 'success', session_id: 's1', total_cost_usd: total };
      }
    })();
    return Object.assign(gen, {
      interrupt: async () => undefined,
      reloadPlugins: async () => undefined,
      setPermissionMode: async () => undefined,
    });
  },
}));

const bedrock = {
  accountId: 'b1',
  awsProfile: 'work',
  awsRegion: 'eu-west-2',
  regionPrefix: 'eu' as const,
};

async function turn(opts: Partial<SdkRunOptions>, costs: number[]): Promise<void> {
  const { persistentRun } = await import('../src/sdkBackend.js');
  for await (const _ of persistentRun({
    prompt: 'p',
    cwd: '/tmp',
    chatId: 'chat-warm',
    abortController: new AbortController(),
    oauthAccessToken: '',
    bedrock,
    accountId: 'b1',
    onResultCost: (c) => costs.push(c),
    ...opts,
  }))
    void _;
}

describe('a warm Claude Code process on a Bedrock account', () => {
  afterEach(() => {
    processes.length = 0;
  });

  it('reports each result’s own cost, not the process’s running total', async () => {
    const costs: number[] = [];
    await turn({ prompt: 'one' }, costs);
    await turn({ prompt: 'two' }, costs);
    await turn({ prompt: 'three' }, costs);
    // One process answered all three.
    expect(processes).toHaveLength(1);
    expect(processes[0]!.prompts).toEqual(['one', 'two', 'three']);
    // Totals were 0.10, 0.20, 0.30: the spend is their deltas, summing to 0.30.
    expect(costs.map((c) => Math.round(c * 100) / 100)).toEqual([0.1, 0.1, 0.1]);
    expect(Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100).toBe(0.3);
  });

  it('starts a new process when the turn runs on another account or profile', async () => {
    const costs: number[] = [];
    await turn({ chatId: 'chat-switch', prompt: 'on b1' }, costs);
    await turn(
      {
        chatId: 'chat-switch',
        prompt: 'on b2',
        accountId: 'b2',
        bedrock: { ...bedrock, accountId: 'b2', awsProfile: 'other' },
      },
      costs,
    );
    await turn(
      {
        chatId: 'chat-switch',
        prompt: 'on b2, us',
        accountId: 'b2',
        bedrock: { ...bedrock, accountId: 'b2', awsProfile: 'other', regionPrefix: 'us' },
      },
      costs,
    );
    await turn(
      {
        chatId: 'chat-switch',
        prompt: 'on a token',
        accountId: 'sub',
        bedrock: undefined,
        oauthAccessToken: 'tok',
      },
      costs,
    );
    expect(processes.map((p) => p.prompts)).toEqual([
      ['on b1'],
      ['on b2'],
      ['on b2, us'],
      ['on a token'],
    ]);
    expect(processes[0]!.env['AWS_PROFILE']).toBe('work');
    expect(processes[1]!.env['AWS_PROFILE']).toBe('other');
    expect(processes[2]!.env['ANTHROPIC_BEDROCK_REGION_PREFIX']).toBe('us');
    // A token run keeps the host's own profile (for the agent's shell), never the last Bedrock run's.
    expect(processes[3]!.env['AWS_PROFILE']).toBe(process.env['AWS_PROFILE']);
    expect(processes[3]!.env['CLAUDE_CODE_USE_BEDROCK']).toBeUndefined();
    expect(processes[3]!.env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('tok');
    // Every new process's first reading is its own total.
    expect(costs.map((c) => Math.round(c * 100) / 100)).toEqual([0.1, 0.1, 0.1, 0.1]);
  });
});

describe('createResultCostDelta', () => {
  it('counts the first reading whole and each later one as what it adds', async () => {
    const { createResultCostDelta } = await import('../src/sdkBackend.js');
    const delta = createResultCostDelta();
    const result = (total: number) => ({ type: 'result', total_cost_usd: total });
    expect(delta({ type: 'assistant' })).toBeUndefined();
    expect(delta(result(0.5))).toBe(0.5);
    expect(delta(result(0.75))).toBe(0.25);
    expect(delta(result(0.75))).toBe(0);
  });
});
