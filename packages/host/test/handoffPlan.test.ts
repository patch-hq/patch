// Budgeted handoff planning (spec/04 § Provider switches — Handoff budget).
import { describe, it, expect } from 'vitest';
import type { TrackEntry } from '../src/nativeReconstruct.js';
import {
  availableInputTokens,
  buildLedger,
  handoffKey,
  planHandoff,
  replanAfterOverflow,
} from '../src/handoffPlan.js';

const budget = {
  contextWindow: 272_000,
  instructionsTokens: 6_000,
  toolsTokens: 14_000,
  outputTokens: 32_000,
};

function longTrack(turns: number, bytesPerResult = 4000): TrackEntry[] {
  const out: TrackEntry[] = [];
  let seq = 0;
  const push = (event: TrackEntry['event']): void => {
    out.push({ record: { seq, at: seq }, event } as TrackEntry);
    seq++;
  };
  for (let t = 0; t < turns; t++) {
    push({ type: 'chat.message', chatId: 'c', role: 'user', content: `step ${t}`, seq } as never);
    push({
      type: 'chat.tool_call',
      chatId: 'c',
      tool: 'Edit',
      args: { file_path: `/f/${t % 5}.ts` },
      callId: `e${t}`,
      seq,
    } as never);
    push({
      type: 'chat.tool_result',
      chatId: 'c',
      tool: 'Edit',
      callId: `e${t}`,
      result: 'x'.repeat(bytesPerResult),
      seq,
    } as never);
    push({ type: 'chat.message', chatId: 'c', role: 'assistant', content: 'done', seq } as never);
  }
  return out;
}

describe('availableInputTokens', () => {
  it('subtracts instructions, tools, output headroom and margin from the window', () => {
    expect(availableInputTokens(budget)).toBe(272_000 - 6_000 - 14_000 - 32_000 - 13_600);
  });
  it('never goes negative', () => {
    expect(availableInputTokens({ ...budget, contextWindow: 1000 })).toBe(0);
  });
});

describe('planHandoff', () => {
  it('carries the whole track when it fits', () => {
    const track = longTrack(5);
    const plan = planHandoff('c', track, budget, { latestInstruction: 'go' });
    expect(plan.ok && plan.omittedEntries).toBe(0);
  });

  it('an ~888k-token track is windowed to fit a 272k target, with the omission stated', () => {
    const track = longTrack(1000, 3500); // ~3.5M chars ≈ 900k tokens
    const plan = planHandoff('c', track, budget, { latestInstruction: 'finish the tests' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.omittedEntries).toBeGreaterThan(0);
    expect(plan.estimatedTokens).toBeLessThanOrEqual(plan.availableTokens * 0.6);
    // carried window starts at a user turn and ends at the track's end
    expect(plan.carried[0]!.event.type).toBe('chat.message');
    expect(plan.carried.at(-1)).toBe(track.at(-1));
    expect(plan.carriedFromSeq).toBe(plan.carried[0]!.record.seq);
  });

  it('fails before sending when the latest instruction alone cannot fit, and does not trim it', () => {
    const huge = 'x'.repeat(2_000_000);
    const plan = planHandoff('c', longTrack(3), budget, { latestInstruction: huge });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe('handoff_too_large');
  });

  it('is deterministic: the same track plans identically twice', () => {
    const track = longTrack(1000, 3500);
    const a = planHandoff('c', track, budget, { latestInstruction: 'go' });
    const b = planHandoff('c', track, budget, { latestInstruction: 'go' });
    expect(a).toEqual(b);
  });

  it('needs no model: works with narrative absent (source provider unavailable)', () => {
    const plan = planHandoff('c', longTrack(1000, 3500), budget, {
      latestInstruction: 'go',
      narrative: null,
    });
    expect(plan.ok).toBe(true);
  });
});

describe('buildLedger', () => {
  it('extracts files, validation outcome, open todos and the exact latest user instruction', () => {
    const e = (event: unknown, seq: number): TrackEntry =>
      ({ record: { seq, at: seq }, event }) as TrackEntry;
    const ledger = buildLedger([
      e({ type: 'chat.message', role: 'user', content: 'first', chatId: 'c', seq: 0 }, 0),
      e(
        {
          type: 'chat.tool_call',
          tool: 'Write',
          args: { file_path: '/a.ts' },
          callId: 'w',
          chatId: 'c',
          seq: 1,
        },
        1,
      ),
      e(
        {
          type: 'chat.tool_call',
          tool: 'Bash',
          args: { command: 'pnpm test' },
          callId: 'b',
          chatId: 'c',
          seq: 2,
        },
        2,
      ),
      e(
        {
          type: 'chat.tool_result',
          tool: 'Bash',
          callId: 'b',
          result: 'fail',
          isError: true,
          chatId: 'c',
          seq: 3,
        },
        3,
      ),
      e(
        {
          type: 'chat.tool_call',
          tool: 'TodoWrite',
          args: {
            todos: [
              { content: 'fix test', status: 'pending' },
              { content: 'done one', status: 'completed' },
            ],
          },
          callId: 't',
          chatId: 'c',
          seq: 4,
        },
        4,
      ),
      e(
        { type: 'chat.message', role: 'user', content: '  exact\n text  ', chatId: 'c', seq: 5 },
        5,
      ),
    ]);
    expect(ledger.filesChanged).toEqual(['/a.ts']);
    expect(ledger.validation).toEqual([{ command: 'pnpm test', ok: false, seq: 2 }]);
    expect(ledger.openTodos).toEqual(['fix test']);
    expect(ledger.latestInstruction).toBe('  exact\n text  ');
  });
});

describe('overflow retry', () => {
  it('re-plans tighter instead of resending the same request', () => {
    const r = replanAfterOverflow({ estimatedTokens: 100_000, availableTokens: 200_000 });
    expect(r).toEqual({ maxTokensOverride: 50_000 });
  });
  it('gives up when there is nothing left to shrink', () => {
    expect(replanAfterOverflow({ estimatedTokens: 1500, availableTokens: 1 })).toBeNull();
  });
  it('a retry of the same switch keeps the same idempotency key', () => {
    expect(handoffKey('c', 'b', 10, 'm')).toBe(handoffKey('c', 'b', 10, 'm'));
    expect(handoffKey('c', 'b', 10, 'm')).not.toBe(handoffKey('c', 'b', 11, 'm'));
  });
});
