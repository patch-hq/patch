import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSpotlightIndexed, LSREGISTER, type SpotlightDeps } from './spotlight';

const mk = (over: Partial<SpotlightDeps>, calls: string[] = []): SpotlightDeps => ({
  platform: 'darwin',
  isPackaged: true,
  bundlePath: '/Applications/Patch.app',
  run: async (cmd) => {
    calls.push(cmd);
    return { code: 0, stdout: '', stderr: '' };
  },
  log: () => {},
  error: () => {},
  ...over,
});

test('skips off macOS and in dev', async () => {
  assert.equal(await ensureSpotlightIndexed(mk({ platform: 'linux' })), 'skipped');
  assert.equal(await ensureSpotlightIndexed(mk({ isPackaged: false })), 'skipped');
});

test('leaves an indexed app alone', async () => {
  const calls: string[] = [];
  const r = await ensureSpotlightIndexed(
    mk({
      run: async (c) => (
        calls.push(c),
        { code: 0, stdout: '/Applications/Patch.app\n', stderr: '' }
      ),
    }),
  );
  assert.equal(r, 'indexed');
  assert.deepEqual(calls, ['mdfind']);
});

test('re-registers and imports when Spotlight does not know the app', async () => {
  const calls: string[] = [];
  assert.equal(await ensureSpotlightIndexed(mk({}, calls)), 'repaired');
  assert.deepEqual(calls, ['mdfind', LSREGISTER, 'mdimport']);
});

test('a failing re-register throws and logs', async () => {
  const errs: string[] = [];
  await assert.rejects(
    ensureSpotlightIndexed(
      mk({
        run: async (c) =>
          c === 'mdimport'
            ? { code: 1, stdout: '', stderr: 'boom' }
            : { code: 0, stdout: '', stderr: '' },
        error: (m) => errs.push(m),
      }),
    ),
  );
  assert.equal(errs.length, 1);
});
