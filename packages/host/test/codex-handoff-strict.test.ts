// spec/04 § Handoff budget — a budgeted handoff is never trimmed to fit. The
// Codex backend turns an over-window refusal (at injection, or on the turn
// before anything ran) into a typed HandoffOverflowError the host re-plans
// once, and passes the target's reported window on token-usage updates.

import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CodexHistory } from '../src/codexHistory.js';
import { CodexBackend } from '../src/codexBackend.js';
import { HandoffOverflowError, type SdkEnvelope } from '../src/sdkBackend.js';
import type { TrackEntry } from '../src/nativeReconstruct.js';

const track: TrackEntry[] = [
  {
    record: { seq: 0, at: 0 },
    event: { type: 'chat.message', chatId: 'c', role: 'user', content: 'hi', seq: 0 },
  },
  {
    record: { seq: 1, at: 1 },
    event: { type: 'chat.message', chatId: 'c', role: 'assistant', content: 'hello', seq: 1 },
  },
];

function harness(o: { injectFails?: string; turnStartFails?: string; usage?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'patch-codex-strict-'));
  const history = new CodexHistory(root);
  const calls: string[] = [];
  let listener: ((m: any) => void) | undefined;
  const emit = (method: string, params: object): void =>
    listener?.({ method, params: { threadId: 'thread1', turnId: 't1', ...params } });
  const client = {
    subscribe: (fn: (m: any) => void) => {
      listener = fn;
      return () => {};
    },
    request: async (method: string) => {
      calls.push(method);
      if (method === 'thread/start') return { thread: { id: 'thread1', path: '/p' } };
      if (method === 'thread/inject_items') {
        if (o.injectFails) throw new Error(o.injectFails);
        return {};
      }
      if (method === 'turn/start') {
        if (o.turnStartFails) throw new Error(o.turnStartFails);
        setTimeout(() => {
          if (o.usage)
            emit('thread/tokenUsage/updated', {
              tokenUsage: { modelContextWindow: 272000, last: { inputTokens: 1234 } },
            });
          emit('turn/completed', { turn: { id: 't1', status: 'completed' } });
        }, 0);
        return { turn: { id: 't1' } };
      }
      throw new Error('unexpected ' + method);
    },
  };
  const accounts: any = {
    resolveChosen: async () => ({ accountId: 'a' }),
    turnClient: async () => client,
    releaseTurnClient: async () => {},
  };
  const run = async (strict: boolean) => {
    const events: SdkEnvelope[] = [];
    const backend = new CodexBackend(accounts, history, {});
    for await (const e of backend.run({
      prompt: 'work',
      cwd: root,
      chatId: 'c',
      model: 'openai/gpt',
      resumeSessionId: 'abc',
      codexReseed: { events: track },
      ...(strict ? { handoffStrict: true } : {}),
      permissionMode: 'acceptEdits',
      oauthAccessToken: '',
      abortController: new AbortController(),
    } as any))
      events.push(e);
    return events;
  };
  return { calls, run };
}

describe('Codex backend and a budgeted handoff', () => {
  it('an over-window injection is a typed overflow, injected once, never trimmed', async () => {
    const h = harness({ injectFails: 'maximum context length is 272000 tokens' });
    const err = await h.run(true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HandoffOverflowError);
    expect((err as HandoffOverflowError).reportedLimit).toBe(272000);
    expect(h.calls.filter((c) => c === 'thread/inject_items')).toHaveLength(1);
    expect(h.calls).not.toContain('turn/start');
  });

  it('an over-window refusal of the turn itself, before any output, is the same typed overflow', async () => {
    const h = harness({ turnStartFails: 'context_length_exceeded' });
    await expect(h.run(true)).rejects.toBeInstanceOf(HandoffOverflowError);
  });

  it('a non-overflow injection failure stays what it was', async () => {
    const h = harness({ injectFails: 'thread not found' });
    const err = await h.run(true).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(HandoffOverflowError);
    expect((err as Error).message).toBe('thread not found');
  });

  it('without a handoff the old trim-and-retry still applies', async () => {
    const h = harness({ injectFails: 'context window exceeded' });
    const err = await h.run(false).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(HandoffOverflowError);
  });

  it('reports the model window and input tokens from token-usage updates', async () => {
    const h = harness({ usage: true });
    const events = await h.run(true);
    expect(events.find((e) => e.tokenUsage)?.tokenUsage).toEqual({
      contextWindow: 272000,
      inputTokens: 1234,
    });
    expect(events.at(-1)?.type).toBe('result');
  });
});
