import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CodexHistory } from '../src/codexHistory.js';
import { CodexBackend } from '../src/codexBackend.js';
import { setLiveRunPermissionMode } from '../src/sdkBackend.js';

// A mode chosen while a Codex turn is running reaches that turn: Codex fixed its
// approval policy when the turn began, so the host answers its approval requests
// itself once the chat is on bypass.
async function runWithApproval(switchTo: 'bypassPermissions' | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'patch-codex-live-mode-'));
  const history = new CodexHistory(root);
  let listener: ((m: any) => void) | undefined;
  const responses: any[] = [];
  const asked: any[] = [];
  const emit = (method: string, params: object, id?: number): void =>
    listener?.({
      method,
      ...(id !== undefined ? { id } : {}),
      params: { threadId: 'thread1', turnId: 't1', ...params },
    });
  const client = {
    subscribe: (fn: (m: any) => void) => {
      listener = fn;
      return () => {};
    },
    respond: (id: number, result: any) => responses.push({ id, result }),
    request: async (method: string) => {
      if (method === 'thread/start') return { thread: { id: 'thread1', path: '/p' } };
      if (method === 'turn/start') {
        setTimeout(async () => {
          if (switchTo) await setLiveRunPermissionMode('c', switchTo);
          emit('item/commandExecution/requestApproval', { command: 'ls' }, 7);
          setTimeout(() => emit('turn/completed', { turn: { id: 't1', status: 'completed' } }), 20);
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
  const backend = new CodexBackend(accounts, history);
  for await (const _ of backend.run({
    prompt: 'work',
    cwd: root,
    chatId: 'c',
    model: 'gpt',
    permissionMode: 'default',
    oauthAccessToken: '',
    abortController: new AbortController(),
    onPermissionRequest: async (r: any) => {
      asked.push(r);
      return { approve: false };
    },
  } as any)) {
    // drain
  }
  return { responses, asked };
}

describe('Codex live permission mode', () => {
  it('approves without asking once the chat is switched to bypass mid-turn', async () => {
    const { responses, asked } = await runWithApproval('bypassPermissions');
    expect(asked).toHaveLength(0);
    expect(responses).toEqual([{ id: 7, result: { decision: 'accept' } }]);
  });

  it('still asks when the mode was not changed', async () => {
    const { asked } = await runWithApproval(undefined);
    expect(asked).toHaveLength(1);
  });
});
