#!/usr/bin/env node
// The Worker is tested by the relay's own suite, not a second one: this starts
// it under `wrangler dev` (workerd, Durable Objects and hibernation included,
// all local) and runs packages/relay's behaviour tests against it through
// PATCH_RELAY_TEST_URL. A quick hello timeout and a small channel keep the run
// short; /healthz reports them, and the tests read them from there.
//
//   node test/run.mjs                         against wrangler dev
//   node test/run.mjs wss://relay.example     against a deployed relay

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(HERE, '..');
const RELAY = resolve(HERE, '../../relay');
// The files that drive a relay over the wire. crypto, tunnel and utf8 never touch one.
const SUITE = [
  'test/server.test.ts',
  'test/e2e.test.ts',
  'test/bridge.test.ts',
  'test/keepalive.test.ts',
];

async function freePort() {
  const srv = createServer();
  await new Promise((r, j) => {
    srv.once('error', j);
    srv.listen(0, '127.0.0.1', r);
  });
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

function run(cmd, args, opts) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

let target = process.argv[2];
let dev = null;
if (!target) {
  const port = await freePort();
  dev = spawn(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      String(await freePort()),
      '--show-interactive-dev-session=false',
      '--var',
      'HELLO_TIMEOUT_MS:500',
      '--var',
      'MAX_CLIENTS_PER_CHANNEL:3',
    ],
    {
      cwd: WORKER,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
      detached: true,
    },
  );
  let log = '';
  dev.stdout.on('data', (d) => (log += d));
  dev.stderr.on('data', (d) => (log += d));
  const stop = () => {
    try {
      process.kill(-dev.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  };
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));
  target = `http://127.0.0.1:${port}`;
  const end = Date.now() + 60_000;
  for (;;) {
    if (dev.exitCode !== null) {
      console.error(`wrangler dev exited (${dev.exitCode}):\n${log}`);
      process.exit(1);
    }
    try {
      const res = await fetch(`${target}/healthz`);
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > end) {
      console.error(`wrangler dev did not answer /healthz within 60s:\n${log}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`relay-worker: wrangler dev is up at ${target}`);
}

const code = await run('pnpm', ['exec', 'vitest', 'run', ...SUITE], {
  cwd: RELAY,
  env: {
    ...process.env,
    PATCH_RELAY_TEST_URL: target,
    // Local workerd reports a close the relay started ~10 s late (test/target.ts).
    ...(dev ? { PATCH_RELAY_TEST_PATIENCE: '8' } : {}),
  },
});
process.exit(code);
