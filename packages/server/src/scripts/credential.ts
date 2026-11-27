// `patch-server credential --label <name> [--out <file>]` — a surface
// credential for something on this machine (a scheduled check, an agent driving
// the web app), issued by the RUNNING server without approval from another
// device (spec/10 § Local credentials). Reading the data folder's
// local-admin.token is the proof. Same label again renews the same device.
//
// Run through the launcher, which loads server.env, so PORT and the data
// directory are the running server's own.

import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { defaultServerHome } from '../config.js';
import { LOCAL_ADMIN_HEADER, LOCAL_ADMIN_TOKEN_FILE } from '../local-admin.js';

function fail(message: string): never {
  process.stderr.write(`patch-server credential: ${message}\n`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) fail(`${name} needs a value`);
  return v;
}

function post(
  path: string,
  body: unknown,
  token: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const socketPath = process.env['PATCH_SOCKET'];
  const port = Number(process.env['PORT'] ?? '3970');
  return new Promise((resolve, reject) => {
    const req = request(
      {
        ...(socketPath ? { socketPath } : { host: '127.0.0.1', port }),
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', [LOCAL_ADMIN_HEADER]: token },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              json: JSON.parse(text) as Record<string, unknown>,
            });
          } catch {
            reject(new Error(`server answered ${res.statusCode}: ${text.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const label = flag(args, '--label') ?? fail('--label <name> is required');
  const out = flag(args, '--out');
  const dataDir = process.env['PATCH_DATA_DIR'] ?? join(defaultServerHome(), 'data');
  let token: string;
  try {
    token = readFileSync(join(dataDir, LOCAL_ADMIN_TOKEN_FILE), 'utf8').trim();
  } catch (e) {
    fail(
      `cannot read ${join(dataDir, LOCAL_ADMIN_TOKEN_FILE)} (${(e as Error).message}); is the server running a release that writes it?`,
    );
  }
  const res = await post('/api/auth/local/credential', { label }, token).catch((e: Error) =>
    fail(`cannot reach the server: ${e.message}`),
  );
  const credential = res.json['credential'];
  if (res.status !== 200 || typeof credential !== 'string') {
    fail(
      `server refused (${res.status}): ${String(res.json['error'] ?? JSON.stringify(res.json))}`,
    );
  }
  if (!out) {
    process.stdout.write(`${credential}\n`);
    return;
  }
  const tmp = `${out}.tmp.${process.pid}`;
  writeFileSync(tmp, `${credential}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, out);
  process.stderr.write(`patch-server credential: wrote ${out}\n`);
}

void main();
