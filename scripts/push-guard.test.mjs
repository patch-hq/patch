import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from './push-guard.mjs';

test('a clean file has no findings', () => {
  assert.deepEqual(scanText('src/a.ts', 'const x = 1; // nothing to see'), []);
});

test('a real-looking token is refused, an obvious fixture is not', () => {
  assert.equal(scanText('src/a.ts', 'const k = "sk-ant-api03-Zk9qL2mWx7TnB4vC8rYd5HsE"').length, 1);
  assert.equal(scanText('src/a.ts', 'const k = "ghp_Zk9qL2mWx7TnB4vC8rYd5HsEa1Qp3Ju6Mi0Ko"').length, 1);
  assert.deepEqual(scanText('src/a.ts', 'const k = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx"'), []);
  assert.deepEqual(scanText('src/a.ts', "process.env.ANTHROPIC_API_KEY = 'sk-ant-host-id-test-key-12345'"), []);
});

test('a private key is refused except in the known fixture places', () => {
  const key = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
  assert.equal(scanText('src/keys.ts', key).length, 1);
  assert.deepEqual(scanText('docker-compose.test.yml', key), []);
  assert.deepEqual(scanText('packages/voice-firmware/managed_components/x/client_key.pem', key), []);
  assert.deepEqual(scanText('packages/server/test/fcm.test.ts', key), []);
});

test('a value from this host settings is refused wherever it appears', () => {
  const secret = 'abcdef0123456789-SECRET-VALUE';
  assert.equal(scanText('docs/notes.md', `token is ${secret} ok`, [secret]).length, 1);
  assert.deepEqual(scanText('docs/notes.md', 'nothing here', [secret]), []);
});
