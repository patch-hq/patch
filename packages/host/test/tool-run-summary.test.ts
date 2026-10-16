// spec/14 § Tool runs — the host labels each closed run of tool calls. A run
// is what a surface collapses: consecutive groupable calls, cut by prose, by a
// call that keeps its own row (an edit), and by the end of the turn. Only runs
// of more than one call are summarised, and a failure is stamped, not hidden.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatToolRunSummaryEvent, WireEvent } from '@patch/wire';
import { Daemon, type HostOptions } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend, type SdkEnvelope } from '../src/sdkBackend.js';
import {
  buildToolRunPrompt,
  parseToolRunSummary,
  makeToolRunSummarizer,
} from '../src/toolRunGen.js';

const silent = pino({ level: 'silent' });

type SummarizeInput = Parameters<NonNullable<HostOptions['summarizeToolRun']>>[0];

function setup(summarize: (input: SummarizeInput) => Promise<string>, turnDelayMs = 0) {
  const home = mkdtempSync(join(tmpdir(), 'patch-trs-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-trs-folder-')));
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend({ turnDelayMs });
  const asked: SummarizeInput[] = [];
  const askedLive: SummarizeInput[] = [];
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => 'chat-1',
    discoverClaudeMcpServers: () => [],
    summarizeToolRun: async (input) => {
      (input.live === true ? askedLive : asked).push(input);
      return await summarize(input);
    },
  });
  return { daemon, sdk, events, folder, asked, askedLive };
}

const call = (callId: string, name: string, args: unknown = {}): SdkEnvelope => ({
  type: 'tool_use',
  tool: { name, args, callId },
});
const result = (callId: string, name: string): SdkEnvelope => ({
  type: 'tool_result',
  toolResult: { name, callId, result: 'ok' },
});

const settle = () => new Promise((r) => setTimeout(r, 40));
const allSummaries = (events: WireEvent[]) =>
  events.filter((e): e is ChatToolRunSummaryEvent => e.type === 'chat.tool_run_summary');
const summaries = (events: WireEvent[]) => allSummaries(events).filter((e) => e.live !== true);
const narrations = (events: WireEvent[]) => allSummaries(events).filter((e) => e.live === true);

describe('tool run summaries', () => {
  it('labels each closed run, keyed by its call ids, with the prose around it', async () => {
    const { daemon, sdk, events, folder, asked } = setup(async (i) =>
      i.calls.length === 2 ? 'Found the poller' : 'Ran the suite',
    );
    sdk.enqueue([
      { type: 'assistant', content: 'Looking at the poller.' },
      call('a', 'Grep', { pattern: 'poll' }),
      call('b', 'Read', { file_path: '/x/poll.ts' }),
      result('a', 'Grep'),
      result('b', 'Read'),
      { type: 'assistant', content: 'Now the tests.' },
      call('c', 'Bash', { command: 'pnpm test' }),
      result('c', 'Bash'),
      call('d', 'Bash', { command: 'pnpm lint' }),
      result('d', 'Bash'),
      call('e', 'Bash', { command: 'pnpm build' }),
      result('e', 'Bash'),
      { type: 'result', sessionId: 's1' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'tidy the poller' });
    await settle();

    const got = summaries(events);
    expect(got.map((s) => [s.callIds, s.summary])).toEqual([
      [['a', 'b'], 'Found the poller'],
      [['c', 'd', 'e'], 'Ran the suite'],
    ]);
    expect(asked[0]).toMatchObject({
      calls: [
        { tool: 'Grep', args: { pattern: 'poll' } },
        { tool: 'Read', args: { file_path: '/x/poll.ts' } },
      ],
    });
    // The summariser is handed the calls alone, never the model's prose.
    expect(Object.keys(asked[0]!).sort()).toEqual(['calls', 'chatId', 'folder']);
    // The last run closed on the END of the turn, not on a following message.
    expect(asked[1]?.calls).toHaveLength(3);
    // Each summary has its own seq, after everything it labels.
    const callSeqs = events.filter((e) => e.type === 'chat.tool_call').map((e) => e.seq);
    for (const s of got) expect(s.seq).toBeGreaterThan(Math.min(...callSeqs));
  });

  it('tells the summariser which calls failed and why, so the label cannot claim they worked', async () => {
    const { daemon, sdk, asked } = setup(async () => 'Tried to file a ticket');
    sdk.enqueue([
      call('a', 'Bash', { command: 'jira create' }),
      {
        type: 'tool_result',
        toolResult: { name: 'Bash', callId: 'a', result: 'HTTP 400 bad request', isError: true },
      },
      call('b', 'Bash', { command: 'jira create --retry' }),
      { type: 'tool_result', toolResult: { name: 'Bash', callId: 'b', result: 'ok' } },
      { type: 'result', sessionId: 's1' },
    ]);
    await daemon.spawnChat({
      folder: realpathSync(mkdtempSync(join(tmpdir(), 'patch-trs-f-'))),
      prompt: 'go',
    });
    await settle();
    expect(asked[0]?.calls).toEqual([
      expect.objectContaining({ tool: 'Bash', failed: true, outcome: 'HTTP 400 bad request' }),
      expect.objectContaining({ tool: 'Bash', failed: false }),
    ]);
  });

  it('labels a lone call too, and an edit splits a run the way a surface draws it', async () => {
    const { daemon, sdk, events, folder, asked } = setup(async () => 'x');
    sdk.enqueue([
      call('a', 'Read', { file_path: 'a.ts' }),
      result('a', 'Read'),
      call('e', 'Edit', { file_path: 'a.ts', old_string: '1', new_string: '2' }),
      result('e', 'Edit'),
      call('b', 'Bash', { command: 'pnpm test' }),
      result('b', 'Bash'),
      call('c', 'Read', { file_path: 'b.ts' }),
      result('c', 'Read'),
      { type: 'result', sessionId: 's1' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await settle();
    expect(asked).toHaveLength(2);
    expect(summaries(events).map((s) => s.callIds)).toEqual([['a'], ['b', 'c']]);
  });

  it('narrates an open run live, and the closed label is the last word', async () => {
    const { daemon, sdk, events, folder, askedLive } = setup(async (i) =>
      i.live === true ? 'Looking at the picture…' : 'Looked at the picture',
    );
    sdk.enqueue([
      call('a', 'Read', { file_path: '/x/01M4-image.png' }),
      { type: 'result', sessionId: 's1' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await settle();
    expect(askedLive).toHaveLength(1);
    expect(narrations(events).map((s) => [s.callIds, s.summary])).toEqual([
      [['a'], 'Looking at the picture…'],
    ]);
    const all = allSummaries(events);
    expect(all[all.length - 1]).toMatchObject({ summary: 'Looked at the picture' });
    expect(all[all.length - 1]?.live).toBeUndefined();
  });

  it('coalesces narration: calls arriving mid-generation cost one follow-up, not one each', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { daemon, sdk, events, folder, askedLive } = setup(async (i) => {
      if (i.live === true) {
        if (askedLive.length === 1) await gate;
        return `Working on ${i.calls.length}…`;
      }
      return 'Done';
    }, 200);
    sdk.enqueue([
      call('a', 'Read', { file_path: 'a.ts' }),
      call('b', 'Read', { file_path: 'b.ts' }),
      call('c', 'Read', { file_path: 'c.ts' }),
      { type: 'result', sessionId: 's1' },
    ]);
    const p = daemon.spawnChat({ folder, prompt: 'go' });
    await settle();
    release();
    await p;
    await new Promise((r) => setTimeout(r, 300));
    expect(askedLive.map((i) => i.calls.length)).toEqual([1, 3]);
    expect(narrations(events).map((s) => s.callIds)).toEqual([['a'], ['a', 'b', 'c']]);
  });

  it('stamps a failure with its reason rather than leaving the run silently unlabelled', async () => {
    const { daemon, sdk, events, folder } = setup(async () => {
      throw new Error('no Claude account with credit could answer');
    });
    sdk.enqueue([
      call('a', 'Read', { file_path: 'a.ts' }),
      call('b', 'Read', { file_path: 'b.ts' }),
      result('a', 'Read'),
      result('b', 'Read'),
      { type: 'result', sessionId: 's1' },
    ]);
    await daemon.spawnChat({ folder, prompt: 'go' });
    await settle();
    expect(summaries(events)).toEqual([
      expect.objectContaining({
        callIds: ['a', 'b'],
        summary: null,
        error: 'no Claude account with credit could answer',
      }),
    ]);
  });

  it('keeps summaries in history, so a replay brings them back', async () => {
    const { daemon, sdk, folder } = setup(async () => 'Read both files');
    sdk.enqueue([
      call('a', 'Read', { file_path: 'a.ts' }),
      call('b', 'Read', { file_path: 'b.ts' }),
      result('a', 'Read'),
      result('b', 'Read'),
      { type: 'result', sessionId: 's1' },
    ]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await settle();
    const replayed: WireEvent[] = [];
    daemon.replayChat(chatId, -1, (e) => replayed.push(e));
    await settle();
    expect(summaries(replayed).map((s) => [s.callIds, s.summary])).toEqual([
      [['a', 'b'], 'Read both files'],
    ]);
  });
});

describe('toolRunGen', () => {
  it('asks for the purpose of the batch from the calls alone', () => {
    const prompt = buildToolRunPrompt({
      chatId: 'c',
      folder: '/f',
      calls: [{ tool: 'Bash', args: { command: 'cat deploy.lock', description: 'Read the lock' } }],
    });
    expect(prompt).not.toMatch(/user asked|agent said/i);
    expect(prompt).toContain('- Bash {"command":"cat deploy.lock","description":"Read the lock"}');
  });

  it('marks failed calls in the prompt and tells the model not to claim they succeeded', () => {
    const prompt = buildToolRunPrompt({
      chatId: 'c',
      folder: '/f',
      calls: [
        { tool: 'Bash', args: { command: 'jira create' }, failed: true, outcome: 'HTTP 400' },
        { tool: 'Bash', args: { command: 'ls' }, failed: false },
      ],
    });
    expect(prompt).toContain('- Bash {"command":"jira create"} [FAILED: HTTP 400]');
    expect(prompt).toContain('- Bash {"command":"ls"}\n');
    expect(prompt).toMatch(/never say a failed call succeeded/i);
  });

  it('asks for a present-continuous status line when the run is live, and keeps its ellipsis', () => {
    const prompt = buildToolRunPrompt({
      chatId: 'c',
      folder: '/f',
      live: true,
      calls: [{ tool: 'Read', args: { file_path: '/x/01M4-image.png' } }],
    });
    expect(prompt).toMatch(/right now, in 2 to 6 words, present continuous/);
    expect(prompt).toContain('- Read {"file_path":"/x/01M4-image.png"}');
    expect(parseToolRunSummary('Looking at the picture…')).toBe('Looking at the picture…');
  });

  it('keeps the first line, without quotes, markdown or a trailing full stop', () => {
    expect(parseToolRunSummary('"Set up the project locally."\nBecause…')).toBe(
      'Set up the project locally',
    );
    expect(parseToolRunSummary('**Checked the deploy lock**')).toBe('Checked the deploy lock');
    expect(parseToolRunSummary('  \n ')).toBeNull();
  });

  it('throws when no account can answer, instead of returning nothing', async () => {
    const gen = makeToolRunSummarizer({
      sdkBackend: createMockSdkBackend(),
      runOnAccountWithCredit: async () => null,
    });
    await expect(gen({ chatId: 'c', folder: '/f', calls: [] })).rejects.toThrow(
      'no Claude account with credit could answer',
    );
  });

  it('returns the model reply through the account gate', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([{ type: 'assistant', content: 'Searched the web for Haiku pricing' }]);
    const gen = makeToolRunSummarizer({
      sdkBackend: sdk,
      runOnAccountWithCredit: async (_label, run) => await run('tok'),
    });
    await expect(gen({ chatId: 'c', folder: '/f', calls: [] })).resolves.toBe(
      'Searched the web for Haiku pricing',
    );
  });
});
