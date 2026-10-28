// `patch accounts list|order|strategy` on a machine that runs a host: they go
// over the host's own socket and need NO credential.jwt — the host relays them
// to the server on the link it already holds. Anywhere else they keep using
// REST (covered by the REST error path in `_common.test.ts`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerSettingsCommands } from '../src/commands/settings.js';

const VIEW = {
  strategy: { claude: 'priority', codex: 'priority' },
  claude: [
    { id: 'a1', label: 'work', connected: true },
    { id: 'a2', label: 'personal', connected: true },
  ],
  codex: [],
};

async function withHostSocket(
  body: (ctx: {
    seen: Array<{ method: string; url: string; auth: string | undefined; body: string }>;
  }) => Promise<void>,
): Promise<void> {
  const seen: Array<{ method: string; url: string; auth: string | undefined; body: string }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(VIEW));
    });
  });
  const dir = mkdtempSync(join(tmpdir(), 'patch-acct-cli-'));
  // A host machine always has machine.json; the CLI reads the server URL from it.
  writeFileSync(join(dir, 'machine.json'), JSON.stringify({ serverUrl: 'http://127.0.0.1:1' }));
  const socket = join(dir, 'host.sock');
  await new Promise<void>((r) => server.listen(socket, r));
  const saved = { ...process.env };
  process.env.PATCH_HOME = dir; // no credential.jwt, no identity.key in here
  process.env.PATCH_DAEMON_SOCKET = socket;
  process.env.PATCH_DAEMON_LOCAL_KEY = 'host-key';
  delete process.env.PATCH_CONFIG_DIR;
  try {
    await body({ seen });
  } finally {
    process.env = saved;
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function runCli(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerSettingsCommands(program);
  let out = '';
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += String(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    await program.parseAsync(['node', 'patch', ...args]);
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

// One test, not several: the runner reports a finished test on stdout while the
// next one is running, and `runCli` holds stdout to read the command's output.
test('accounts list, order and strategy go over the host socket with no credential', async () => {
  await withHostSocket(async ({ seen }) => {
    const out = await runCli(['accounts', 'list', 'claude']);
    assert.match(out, /1\. work/);
    assert.match(out, /2\. personal/);
    await runCli(['accounts', 'order', 'claude', 'a2', 'a1', '--json']);
    await runCli(['accounts', 'strategy', 'claude', 'round-robin', '--json']);
    assert.deepEqual(
      seen.map((s) => [s.method, s.url, s.auth, s.body === '' ? null : JSON.parse(s.body)]),
      [
        ['GET', '/accounts', 'Bearer host-key', null],
        ['PUT', '/accounts/claude-code/order', 'Bearer host-key', { accountIds: ['a2', 'a1'] }],
        ['PUT', '/accounts/claude-code/strategy', 'Bearer host-key', { strategy: 'round-robin' }],
      ],
    );
  });
});

test('a server call from a host machine is relayed over the host socket, no credential', async () => {
  await withHostSocket(async ({ seen }) => {
    const { buildTransport } = await import('../src/transport/index.js');
    const { loadConfig } = await import('../src/config.js');
    const t = buildTransport(loadConfig(), { forceRest: true });
    await t.put('/api/accounts/claude-code/order', { accountIds: ['a1'] });
    assert.equal(seen[0]!.method, 'POST');
    assert.equal(seen[0]!.url, '/server-api');
    assert.equal(seen[0]!.auth, 'Bearer host-key');
    assert.deepEqual(JSON.parse(seen[0]!.body), {
      method: 'PUT',
      path: '/api/accounts/claude-code/order',
      body: { accountIds: ['a1'] },
    });
  });
});
