// `patch jobs create --script`: the one-liner for scheduled commands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(__dirname, '..', 'dist', 'index.js');

interface CronTriggerBody {
  type: string;
  expression: string;
  timezone?: string;
}
interface CreateBody {
  name?: string;
  trigger?: CronTriggerBody;
}

/**
 * Boot a throwaway REST server that RECORDS every POST body (the stock
 * `withSetup` in commands.test.ts only sees the URL/method), run the CLI
 * against it, and hand back both the process result and the captured bodies.
 */
function withCapture<T>(
  fn: (env: NodeJS.ProcessEnv, posted: CreateBody[]) => T | Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const posted: CreateBody[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/api/jobs' && req.method === 'POST') {
          const raw = Buffer.concat(chunks).toString('utf8');
          posted.push(raw.length > 0 ? (JSON.parse(raw) as CreateBody) : {});
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'job1' }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr !== 'object') {
        reject(new Error('no addr'));
        return;
      }
      const dir = mkdtempSync(join(tmpdir(), 'patch-cli-crontz-'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'credential.jwt'), 'aGVhZA.e30.c2ln\n', { mode: 0o600 });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATCH_HOME: dir,
        PATCH_SERVER_URL: `http://127.0.0.1:${addr.port}`,
      };
      delete env['PATCH_DAEMON_SOCKET'];
      delete env['PATCH_DAEMON_LOCAL_KEY'];
      const done = (cb: () => void): void => {
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          cb();
        });
      };
      Promise.resolve(fn(env, posted))
        .then((r) => done(() => resolve(r)))
        .catch((e: unknown) => done(() => reject(e as Error)));
    });
  });
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], { env, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('runCli: timed out after 15s'));
    }, 15_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

test('--script with --daemon-id: builds a script action with cwd as folder', async () => {
  await withCapture(async (env, posted) => {
    const r = await runCli(
      [
        'jobs',
        'create',
        '--name',
        'n',
        '--cron',
        '0 3 * * *',
        '--utc',
        '--script',
        './sync.sh',
        '--daemon-id',
        'H1',
        '--json',
      ],
      env,
    );
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const body = posted[0] as unknown as { action: Record<string, unknown> };
    assert.deepEqual(body.action, {
      type: 'script',
      command: './sync.sh',
      folder: process.cwd(),
      hostId: 'H1',
    });
  });
});

test('--script without a local host or --daemon-id fails loudly', async () => {
  await withCapture(async (env, posted) => {
    const r = await runCli(['jobs', 'create', '--cron', '0 3 * * *', '--script', 'x'], env);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--daemon-id/);
    assert.equal(posted.length, 0);
  });
});

test('--script needs a trigger and rejects --command', async () => {
  await withCapture(async (env) => {
    const a = await runCli(['jobs', 'create', '--script', 'x', '--daemon-id', 'H1'], env);
    assert.notEqual(a.code, 0);
    assert.match(a.stderr, /trigger/);
    const b = await runCli(
      [
        'jobs',
        'create',
        '--cron',
        '0 3 * * *',
        '--script',
        'x',
        '--command',
        'y',
        '--daemon-id',
        'H1',
      ],
      env,
    );
    assert.notEqual(b.code, 0);
    assert.match(b.stderr, /replaces/);
  });
});
