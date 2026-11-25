import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signInByApproval } from '../src/signin.js';

function deps(states: string[], calls: string[]) {
  return {
    label: 'cli',
    onRequested: () => {},
    readCode: async () => ' 123456 ',
    sleep: async () => {},
    now: () => 0,
    rest: {
      post: async (path: string, body?: unknown) => {
        calls.push(`POST ${path} ${JSON.stringify(body)}`);
        if (path.endsWith('/request')) return { id: 'i1', secret: 's1', expiresAt: 1000 };
        return { credential: 'jwt', surfaceId: 'sf' };
      },
      get: async (path: string) => {
        calls.push(`GET ${path}`);
        return { state: states.shift() };
      },
    },
  } as never;
}

test('signInByApproval: waits for approval, then redeems the typed code with no bearer', async () => {
  const calls: string[] = [];
  const out = await signInByApproval(deps(['pending', 'approved'], calls));
  assert.equal(out.credential, 'jwt');
  assert.equal(
    calls[0],
    'POST /api/auth/signin/request {"clientType":"surface-cli","label":"cli"}',
  );
  assert.equal(calls.filter((c) => c.startsWith('GET')).length, 2);
  assert.match(calls.at(-1)!, /redeem \{"secret":"s1","code":"123456"\}/);
});

test('signInByApproval: a denied request fails loudly', async () => {
  await assert.rejects(signInByApproval(deps(['denied'], [])), /denied/);
});
