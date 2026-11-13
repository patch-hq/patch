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

// freePort() frees the port before wrangler binds it, so another process on a
// busy runner can take it in between. That race is the only failure retried,
// and only by picking new ports; anything else exits straight away.
async function startDev() {
  const port = await freePort();
  const dev = spawn(
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
  const state = { dev, port, log: '' };
  dev.stdout.on('data', (d) => (state.log += d));
  dev.stderr.on('data', (d) => (state.log += d));
  return state;
}

let target = process.argv[2];
let dev = null;
if (!target) {
  for (let attempt = 1; ; attempt++) {
    const state = await startDev();
    dev = state.dev;
    const stop = () => {
      try {
        process.kill(-state.dev.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    };
    process.on('exit', stop);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));
    target = `http://127.0.0.1:${state.port}`;
    const end = Date.now() + 60_000;
    let portTaken = false;
    for (;;) {
      if (dev.exitCode !== null) {
        if (attempt < 3 && /Address already in use/.test(state.log)) {
          console.error(`relay-worker: port ${state.port} was taken, retrying (${attempt}/3)`);
          portTaken = true;
          break;
        }
        console.error(`wrangler dev exited (${dev.exitCode}):\n${state.log}`);
        process.exit(1);
      }
      try {
        const res = await fetch(`${target}/healthz`);
        if (res.ok) break;
      } catch {
        /* not listening yet */
      }
      if (Date.now() > end) {
        console.error(`wrangler dev did not answer /healthz within 60s:\n${state.log}`);
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!portTaken) break;
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
