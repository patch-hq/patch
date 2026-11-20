// `patch settings`, `patch accounts`, `patch keys` (spec/17 § Commands,
// spec/01 § Settings): the shared settings, changed through the server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import {
  acpAccountLines,
  acpSignIn,
  chatgptDeviceSignIn,
  parseBooleanValue,
  parseModelList,
  registerSettingsCommands,
} from '../src/commands/settings.js';

function build(): Command {
  const program = new Command();
  program.exitOverride();
  registerSettingsCommands(program);
  return program;
}

const group = (name: string): Command => {
  const cmd = build().commands.find((c) => c.name() === name);
  assert.ok(cmd, `${name} is registered`);
  return cmd;
};

test('settings has show (default) and set', () => {
  const subs = group('settings').commands.map((c) => c.name());
  for (const name of ['show', 'set']) assert.ok(subs.includes(name), `settings ${name}`);
  // Claude Code's settings.json is per host now: `patch hosts claude-settings`.
  assert.ok(!subs.includes('claude'), 'settings claude is gone');
});

test('accounts covers the whole account list: list, add, connect, disconnect, remove, order, strategy, adopt', () => {
  const subs = group('accounts').commands.map((c) => c.name());
  for (const name of [
    'list',
    'add',
    'sign-in',
    'connect',
    'disconnect',
    'remove',
    'order',
    'strategy',
    'adopt',
  ]) {
    assert.ok(subs.includes(name), `accounts ${name} (have: ${subs.join(', ')})`);
  }
});

test("accounts acp lists, signs in and removes ACP agents' accounts", () => {
  const acp = group('accounts').commands.find((c) => c.name() === 'acp');
  assert.ok(acp, 'accounts acp');
  assert.deepEqual(
    acp.commands.map((c) => c.name()),
    ['list', 'sign-in', 'remove'],
  );
});

test('an ACP sign-in adds an account, or gives an existing one a new key', async () => {
  const calls: Array<[string, string, unknown]> = [];
  const t = {
    post: async <T>(p: string, b?: unknown): Promise<T> => {
      calls.push(['POST', p, b]);
      return { secrets: { acp: [] } } as T;
    },
    put: async <T>(p: string, b?: unknown): Promise<T> => {
      calls.push(['PUT', p, b]);
      return { secrets: { acp: [] } } as T;
    },
  };
  await acpSignIn(t, { agentId: 'gemini', apiKey: 'k1', label: 'Work' });
  await acpSignIn(t, { agentId: 'gemini', apiKey: 'k2', accountId: 'a/1' });
  assert.deepEqual(calls, [
    ['POST', '/api/accounts/acp/gemini', { apiKey: 'k1', label: 'Work' }],
    ['PUT', '/api/accounts/acp/gemini/a%2F1/key', { apiKey: 'k2' }],
  ]);
});

test('ACP accounts print with their last four and state, never a key', () => {
  assert.deepEqual(acpAccountLines([]), ['  (no accounts)']);
  assert.deepEqual(
    acpAccountLines([
      { id: 'a1', agentId: 'gemini', label: 'Work', last4: '1111', state: { state: 'ready' } },
      {
        id: 'a2',
        agentId: 'gemini',
        label: 'Home',
        state: { state: 'broken', message: 'key refused' },
      },
    ]),
    ['  gemini: Work · ends 1111  [ready]  a1', '  gemini: Home  [broken: key refused]  a2'],
  );
});

test('keys has list (default), set and revoke', () => {
  const subs = group('keys').commands.map((c) => c.name());
  for (const name of ['list', 'set', 'revoke']) assert.ok(subs.includes(name), `keys ${name}`);
});

test('none of them takes a host to change — only adopt and keys set name one to read from', () => {
  for (const name of ['settings', 'accounts', 'keys']) {
    for (const cmd of group(name).commands) {
      const takesHost = cmd.options.some((o) => o.long === '--host');
      const readsFromHost =
        (name === 'accounts' && cmd.name() === 'adopt') ||
        (name === 'keys' && cmd.name() === 'set');
      assert.equal(takesHost, readsFromHost, `${name} ${cmd.name()} --host`);
    }
  }
});

test('on/off settings accept on, off, yes, no, true, false', () => {
  for (const w of ['on', 'yes', 'true', 'ON'])
    assert.equal(parseBooleanValue('auto-update', w), true);
  for (const w of ['off', 'no', 'false', 'Off'])
    assert.equal(parseBooleanValue('auto-update', w), false);
  assert.throws(() => parseBooleanValue('auto-update', 'maybe'), /on\/off/);
});

test('a model list is typed as a comma-separated list or a JSON array, set model first', () => {
  assert.deepEqual(parseModelList('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseModelList('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseModelList('a,,b'), ['a', '', 'b']); // the server refuses the empty entry
});

test('accounts signin shows the device code, then waits until the server has the login', async () => {
  const said: string[] = [];
  const calls: string[] = [];
  let looks = 0;
  const state = { version: 2 };
  const t = {
    async post<T>(path: string, body?: unknown): Promise<T> {
      calls.push(`POST ${path} ${JSON.stringify(body)}`);
      return {
        signInId: 's1',
        userCode: 'ABCD-1234',
        url: 'https://auth.openai.com/codex/device',
        intervalSeconds: 5,
      } as T;
    },
    async get<T>(path: string): Promise<T> {
      calls.push(`GET ${path}`);
      looks += 1;
      return (looks < 3 ? { status: 'pending' } : { status: 'complete', state }) as T;
    },
  };
  const slept: number[] = [];
  const result = await chatgptDeviceSignIn(
    t,
    { label: 'Work' },
    (l) => said.push(l),
    async (ms) => {
      slept.push(ms);
    },
  );
  assert.equal(result, state as never);
  assert.match(said[0]!, /ABCD-1234/);
  assert.match(said[0]!, /auth\.openai\.com\/codex\/device/);
  assert.equal(looks, 3);
  assert.deepEqual(slept, [5000, 5000, 5000]);
  assert.equal(calls[0], 'POST /api/accounts/codex/signin {"label":"Work"}');
});

test('accounts signin reports a failed sign-in in the server’s words', async () => {
  const t = {
    async post<T>(): Promise<T> {
      return { signInId: 's', userCode: 'X', url: 'u', intervalSeconds: 1 } as T;
    },
    async get<T>(): Promise<T> {
      return { status: 'failed', error: 'This login is the same ChatGPT account as Work' } as T;
    },
  };
  await assert.rejects(
    chatgptDeviceSignIn(
      t,
      {},
      () => undefined,
      async () => undefined,
    ),
    /same ChatGPT account as Work/,
  );
});
