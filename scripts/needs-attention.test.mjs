import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, sign, send } from './needs-attention.mjs';

test('a red main names the commit, not a PR', () => {
  const sha = 'a'.repeat(40);
  const p = buildPayload({ kind: 'main-failed', repo: 'patch-hq/patch', sha, detail: 'd' });
  assert.deepEqual(
    [p.type, p.url, p.number],
    ['commit', `https://github.com/patch-hq/patch/commit/${sha}`, undefined],
  );
  assert.throws(() => buildPayload({ kind: 'main-failed', repo: 'patch-hq/patch', sha: 'abc' }));
});

test('payload names the PR or the issue and its url', () => {
  const pr = buildPayload({
    kind: 'pr-conflict',
    repo: 'patch-hq/patch',
    number: '7',
    detail: 'd',
  });
  assert.deepEqual([pr.type, pr.url], ['pr', 'https://github.com/patch-hq/patch/pull/7']);
  const issue = buildPayload({ kind: 'issue-opened', repo: 'patch-hq/patch', number: 8 });
  assert.deepEqual(
    [issue.type, issue.url],
    ['issue', 'https://github.com/patch-hq/patch/issues/8'],
  );
});

test('bad input fails loudly', () => {
  assert.throws(() => buildPayload({ kind: 'nope', repo: 'a/b', number: 1 }));
  assert.throws(() => buildPayload({ kind: 'pr-conflict', repo: 'a/b', number: 'x' }));
  assert.throws(() => buildPayload({ kind: 'pr-conflict', repo: 'ab', number: 1 }));
});

test('send signs the exact body and rejects non-2xx', async () => {
  let seen;
  const ok = async (url, init) => {
    seen = init;
    return { ok: true, status: 200 };
  };
  const payload = buildPayload({ kind: 'issue-opened', repo: 'a/b', number: 1 });
  await send({ url: 'http://x', secret: 's', payload, fetchImpl: ok });
  assert.equal(seen.headers['x-hub-signature-256'], sign('s', seen.body));
  await assert.rejects(
    send({
      url: 'http://x',
      secret: 's',
      payload,
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'no' }),
    }),
    /401/,
  );
});
