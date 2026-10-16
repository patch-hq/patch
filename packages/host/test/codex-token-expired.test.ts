import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccounts, SIGN_IN_EXPIRED_MESSAGE } from '../src/codexAccounts.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'patch-expired-'));
  dirs.push(root);
  const home = join(root, 'login');
  mkdirSync(home);
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'pool' } }));
  const spawns = join(root, 'spawns');
  const executable = join(root, 'codex');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(spawns)}, 'x');
const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', line => {
 const m = JSON.parse(line); if (m.id === undefined) return;
 if (m.method === 'account/rateLimits/read') {
  process.stdout.write(JSON.stringify({id:m.id,error:{code:-32603,message:'unexpected status 401 Unauthorized: Provided authentication token is expired (token_expired)'}})+'\\n');
  return;
 }
 let result = {};
 if (m.method === 'account/read') result = {account:{type:'chatgpt', email:'tom@example.com'}};
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(root, 'accounts.json'),
    JSON.stringify([
      { id: 'a', label: 'Sub', home, adopted: false, store: 'file', kind: 'chatgpt' },
    ]),
  );
  const accounts = new CodexAccounts({ root, hostId: 'h', onChange: () => {}, executable });
  const count = () => (existsSync(spawns) ? readFileSync(spawns, 'utf8').length : 0);
  return { accounts, home, count };
}

it('stops respawning Codex after a token_expired and flags the account for sign-in', async () => {
  const { accounts, count } = setup();
  await accounts.refresh();
  const first = accounts.report().accounts![0]!;
  expect(first).toMatchObject({
    connected: false,
    needsSignIn: true,
    error: SIGN_IN_EXPIRED_MESSAGE,
  });
  expect(count()).toBe(1);
  for (let i = 0; i < 5; i++) await accounts.refresh();
  expect(count()).toBe(1);
  await accounts.close();
});

it('tries again once the account is signed in again', async () => {
  const { accounts, home, count } = setup();
  await accounts.refresh();
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({ tokens: { account_id: 'pool', new: 1 } }),
  );
  await accounts.refresh();
  expect(count()).toBe(2);
  expect(accounts.report().accounts![0]!.needsSignIn).toBe(true);
  await accounts.close();
});

it('tries again after the back-off passes', async () => {
  const { accounts, count } = setup();
  const now = Date.now();
  await accounts.refresh();
  const spy = (await import('vitest')).vi.spyOn(Date, 'now').mockReturnValue(now + 61 * 60_000);
  await accounts.refresh();
  spy.mockRestore();
  expect(count()).toBe(2);
  await accounts.close();
});
