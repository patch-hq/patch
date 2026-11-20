import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CodexSessions } from '../src/codexSessions.js';
import { CodexBackend, codexTurnHolding } from '../src/codexBackend.js';
import type { SdkEnvelope } from '../src/sdkBackend.js';

// A fork names the entry the new branch keeps through by the id the record
// holds for it (an item id). Codex forks at whole turns, so the adapter asks
// Codex which turn holds that item.
const TURNS = [
  { id: 't1', items: [{ id: 'u1' }, { id: 'a1' }] },
  { id: 't2', items: [{ id: 'u2' }, { id: 'call-2' }, { id: 'a2' }] },
];

describe('codexTurnHolding', () => {
  const client = {
    request: async (method: string) => {
      if (method !== 'thread/read') throw new Error('unexpected ' + method);
      return { thread: { turns: TURNS } };
    },
  };

  it('finds the turn that holds an item', async () => {
    expect(await codexTurnHolding(client, 'th', 'a1')).toBe('t1');
    expect(await codexTurnHolding(client, 'th', 'call-2')).toBe('t2');
  });

  it('fails loudly for an item the thread does not hold', async () => {
    await expect(codexTurnHolding(client, 'th', 'nope')).rejects.toThrow(
      /not in this Codex thread/,
    );
  });
});

describe('Codex fork', () => {
  it('forks the prior thread through the turn holding the recorded entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'patch-codex-fork-'));
    try {
      const sessions = new CodexSessions(root);
      sessions.begin('codex-parent', '/codex/parent.jsonl');
      const calls: { method: string; params: any }[] = [];
      let listener: ((m: any) => void) | undefined;
      const client = {
        subscribe: (fn: (m: any) => void) => {
          listener = fn;
          return () => {};
        },
        request: async (method: string, params: any) => {
          calls.push({ method, params });
          if (method === 'thread/read') return { thread: { turns: TURNS } };
          if (method === 'thread/fork')
            return { thread: { id: 'child', path: '/codex/child.jsonl' } };
          if (method === 'turn/start') {
            setTimeout(
              () =>
                listener?.({
                  method: 'turn/completed',
                  params: {
                    threadId: 'child',
                    turnId: 't3',
                    turn: { id: 't3', status: 'completed' },
                  },
                }),
              0,
            );
            return { turn: { id: 't3' } };
          }
          throw new Error('unexpected ' + method);
        },
      };
      const accounts: any = {
        resolveChosen: async () => ({ accountId: 'a' }),
        turnClient: async () => client,
        releaseTurnClient: async () => {},
      };
      const events: SdkEnvelope[] = [];
      for await (const e of new CodexBackend(accounts, sessions).run({
        prompt: 'again',
        cwd: root,
        chatId: 'c',
        model: 'gpt',
        permissionMode: 'acceptEdits',
        oauthAccessToken: '',
        abortController: new AbortController(),
        resumeSessionId: 'codex-parent',
        fork: { throughNativeId: 'a1' },
      } as any))
        events.push(e);
      const fork = calls.find((c) => c.method === 'thread/fork')!;
      expect(fork.params).toMatchObject({
        threadId: 'parent',
        path: '/codex/parent.jsonl',
        lastTurnId: 't1',
      });
      expect(events[0]).toEqual({ type: 'system', sessionId: 'codex-child' });
      expect(sessions.hasSession({ sessionId: 'codex-child' })).toBe(true);
      expect(sessions.providerPath('codex-child')).toBe('/codex/child.jsonl');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
