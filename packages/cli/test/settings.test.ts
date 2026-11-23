// `patch settings`, `patch accounts`, `patch keys` (spec/17 § Commands,
// spec/01 § Settings): the shared settings, changed through the server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import {
  parseOwnSettingValue,
  providerSettingLines,
  providerSettingRows,
  acpAccountLines,
  acpHostLogin,
  acpSignIn,
  chatgptDeviceSignIn,
  parseBooleanValue,
  parseModelList,
  registerSettingsCommands,
  accountLines,
  accountEditBody,
  bedrockAddBody,
  parseCap,
  parsePrefix,
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
  for (const name of ['show', 'set', 'provider', 'provider-set'])
    assert.ok(subs.includes(name), `settings ${name}`);
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
    'add-bedrock',
    'set',
  ]) {
    assert.ok(subs.includes(name), `accounts ${name} (have: ${subs.join(', ')})`);
  }
});

test("accounts acp lists, signs in and removes ACP agents' accounts", () => {
  const acp = group('accounts').commands.find((c) => c.name() === 'acp');
  assert.ok(acp, 'accounts acp');
  assert.deepEqual(
    acp.commands.map((c) => c.name()),
    ['list', 'login', 'sign-in', 'order', 'strategy', 'remove'],
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
      // A Bedrock account runs on one host's AWS profile, so adding one names it.
      const readsFromHost =
        (name === 'accounts' && (cmd.name() === 'adopt' || cmd.name() === 'add-bedrock')) ||
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

test('an ACP sign-in on a host prints the hand-off, sends a pasted address, and waits for the end', async () => {
  const lines: string[] = [];
  const posts: Array<[string, unknown]> = [];
  const views = [
    { loginId: 'l1', hostId: 'h1', agentId: 'gemini', status: 'starting' },
    {
      loginId: 'l1',
      hostId: 'h1',
      agentId: 'gemini',
      status: 'waiting',
      url: 'https://accounts.example.com/auth',
      loopback: true,
    },
    { loginId: 'l1', hostId: 'h1', agentId: 'gemini', status: 'complete' },
  ];
  let polled = 0;
  const t = {
    post: async <T>(p: string, b?: unknown): Promise<T> => {
      posts.push([p, b]);
      return views[0] as T;
    },
    get: async <T>(_p: string): Promise<T> => views[Math.min(++polled, 2)] as T,
  };
  const view = await acpHostLogin(
    t,
    { agentId: 'gemini', hostId: 'h1', methodId: 'oauth-personal' },
    {
      say: (l) => lines.push(l),
      paste: async () => 'http://127.0.0.1:4000/oauth2callback?code=x',
      sleep: async () => undefined,
    },
  );
  assert.equal(view.status, 'complete');
  assert.deepEqual(posts[0], [
    '/api/accounts/acp/gemini/login',
    { hostId: 'h1', methodId: 'oauth-personal' },
  ]);
  assert.ok(lines.includes('Open https://accounts.example.com/auth'));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(posts[1], [
    '/api/accounts/acp/gemini/login/l1/callback',
    { url: 'http://127.0.0.1:4000/oauth2callback?code=x' },
  ]);
});

test('provider settings list every provider’s and agent’s own, chosen or the provider’s default', async () => {
  const { DEFAULT_SHARED_SETTINGS } = await import('@patch/wire');
  const rows = providerSettingRows({
    ...DEFAULT_SHARED_SETTINGS,
    providerSettings: { codex: { 'history.persistence': 0 } },
  } as unknown as Record<string, unknown>);
  assert.deepEqual(
    rows.map((r) => [r.provider, r.key, r.value, r.source]),
    [
      ['claude', 'cleanupPeriodDays', '30 days', 'provider default'],
      ['codex', 'history.persistence', 'Off', 'chosen'],
      ['codex', 'history.max_bytes', 'No limit', 'provider default'],
      ['acp:gemini', 'general.sessionRetention.enabled', 'On', 'provider default'],
      ['acp:gemini', 'general.sessionRetention.maxAge', '30 days', 'provider default'],
    ],
  );
  assert.deepEqual(
    providerSettingRows(DEFAULT_SHARED_SETTINGS as unknown as Record<string, unknown>, 'codex').map(
      (r) => r.key,
    ),
    ['history.persistence', 'history.max_bytes'],
  );
  assert.match(providerSettingLines(rows)[1]!, /^codex history\.persistence: Off {2}\(chosen\)/);
});

test('a provider setting is typed as on/off for a switch and a whole number in range otherwise', async () => {
  const { providerDescriptor } = await import('@patch/wire');
  const [persistence, maxBytes] = providerDescriptor('codex').settings;
  assert.equal(parseOwnSettingValue(persistence!, 'off'), 0);
  assert.equal(parseOwnSettingValue(persistence!, 'On'), 1);
  assert.throws(() => parseOwnSettingValue(persistence!, 'maybe'), /on or off/);
  assert.equal(parseOwnSettingValue(maxBytes!, '50'), 50);
  assert.throws(() => parseOwnSettingValue(maxBytes!, '0'), /from 1 to 10240/);
});

// Claude on Amazon Bedrock accounts and the auto flag (spec/10 § Backend
// credentials, § Choosing an account).

const NOV_23 = Date.UTC(2026, 10, 23, 12);
const BEDROCK = {
  hostId: 'host-a',
  awsProfile: 'work-bedrock',
  awsRegion: 'eu-west-2',
  regionPrefix: 'eu' as const,
  monthlyCapUsd: 100,
  spentUsd: 18.42,
  spentMonth: '2026-11',
};

test('accounts list numbers the accounts in the order, then those with auto off, and shows a Bedrock row', () => {
  assert.deepEqual(
    accountLines(
      [
        { id: 'b1', label: 'Work', connected: true, auto: false, bedrock: BEDROCK },
        { id: 'c1', label: 'Personal', connected: true, email: 'me@example.com' },
        {
          id: 'b2',
          label: 'Client',
          connected: false,
          auto: false,
          bedrock: { ...BEDROCK, hostId: 'host-b', regionPrefix: 'auto', spentMonth: '2026-10' },
        },
        { id: 'c2', label: 'Max', connected: false, auto: true },
      ],
      NOV_23,
    ),
    [
      '  1. Personal <me@example.com>  c1',
      '  2. Max  [not connected]  c2',
      '  - Work (Bedrock)  [auto off]  b1',
      '     host host-a · profile work-bedrock · region eu-west-2, runs in eu · $18.42 of $100 cap this month · estimated',
      '  - Client (Bedrock)  [AWS sign-in expired]  [auto off]  b2',
      // Last month's spend reads as nothing this month.
      '     host host-b · profile work-bedrock · region eu-west-2 · $0 of $100 cap this month · estimated',
    ],
  );
});

test('accounts add-bedrock sends the Bedrock body: prefix auto and auto off unless given', () => {
  assert.deepEqual(
    bedrockAddBody({
      label: 'Work',
      hostId: 'host-a',
      profile: 'work-bedrock',
      region: 'eu-west-2',
      cap: '100',
    }),
    {
      bedrock: {
        label: 'Work',
        hostId: 'host-a',
        awsProfile: 'work-bedrock',
        awsRegion: 'eu-west-2',
        regionPrefix: 'auto',
        monthlyCapUsd: 100,
        auto: false,
      },
    },
  );
  const withAll = bedrockAddBody({
    label: 'Work',
    hostId: 'host-a',
    profile: 'p',
    region: 'us-east-1',
    prefix: 'US',
    cap: '$25.5',
    auto: true,
  });
  assert.equal(withAll.bedrock.regionPrefix, 'us');
  assert.equal(withAll.bedrock.monthlyCapUsd, 25.5);
  assert.equal(withAll.bedrock.auto, true);
});

test('a cap is dollars above 0 and a prefix one of the regions Claude Code knows', () => {
  assert.equal(parseCap('100'), 100);
  for (const bad of ['0', '-5', 'lots', '']) assert.throws(() => parseCap(bad), /--cap/);
  assert.equal(parsePrefix('apac'), 'apac');
  assert.throws(() => parsePrefix('mars'), /--prefix is one of auto, us, eu, apac, jp, au, global/);
});

test('accounts set sends only what was given, and refuses nothing to change', () => {
  assert.deepEqual(accountEditBody({ auto: 'off' }), { auto: false });
  assert.deepEqual(accountEditBody({ auto: 'on', cap: '200', region: 'eu-west-1', prefix: 'eu' }), {
    auto: true,
    monthlyCapUsd: 200,
    awsRegion: 'eu-west-1',
    regionPrefix: 'eu',
  });
  assert.throws(() => accountEditBody({ auto: 'maybe' }), /on\/off/);
  assert.throws(() => accountEditBody({}), /nothing to change/);
});

test('accounts add-bedrock requires the host, profile, region, cap and a name', () => {
  const add = group('accounts').commands.find((c) => c.name() === 'add-bedrock');
  assert.ok(add);
  const required = add.options.filter((o) => o.mandatory).map((o) => o.long);
  assert.deepEqual(required.sort(), ['--cap', '--host', '--label', '--profile', '--region']);
});
