import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buckets, forcesAll, slices } from './ci-plan.mjs';

test('a change inside one package is left to turbo', () => {
  assert.equal(forcesAll(['packages/web/src/App.tsx', 'apps/mobile/app/index.tsx']), false);
});

test('documentation alone forces nothing', () => {
  assert.equal(
    forcesAll(['spec/19-testing.md', 'docs/x.md', 'design/a/b.html', 'deploy.md']),
    false,
  );
});

test('a lockfile, root config, script or workflow change runs every package', () => {
  for (const f of [
    'pnpm-lock.yaml',
    'package.json',
    'tsconfig.base.json',
    'vitest.config.ts',
    'turbo.json',
    '.nvmrc',
    'scripts/verify.mjs',
    '.github/workflows/test.yml',
  ]) {
    assert.equal(forcesAll(['packages/web/src/a.ts', f]), true, f);
  }
});

test('host and web get a runner each, the rest share one', () => {
  assert.deepEqual(buckets(['@patch/wire', '@patch/web', '@patch/host', '@patch/auth']), [
    { name: 'host', packages: '@patch/host' },
    { name: 'web', packages: '@patch/web' },
    { name: 'rest', packages: '@patch/auth,@patch/wire' },
  ]);
});

test('nothing affected is no buckets', () => {
  assert.deepEqual(buckets([]), []);
  assert.deepEqual(buckets(['@patch/server']), [{ name: 'rest', packages: '@patch/server' }]);
});

test('a PR runs the cheap layers and its unit buckets, no browser layer', () => {
  const s = slices(['@patch/web'], { browser: false });
  assert.deepEqual(
    s.map((x) => [x.name, x.layers, x.packages]),
    [
      ['checks', 'lint,types,mock,personal,scripts', ''],
      ['unit web', 'unit', '@patch/web'],
    ],
  );
});

test('a docs-only PR still runs the cheap layers', () => {
  assert.deepEqual(
    slices([], { browser: false }).map((x) => x.name),
    ['checks'],
  );
});

test('main covers every verify layer exactly once per slice kind, browser in four shards', () => {
  const s = slices(['@patch/host', '@patch/web', '@patch/wire'], { browser: true });
  assert.deepEqual(
    s.map((x) => x.name),
    [
      'checks',
      'unit host 1/2',
      'unit host 2/2',
      'unit web',
      'unit rest',
      'browser 1/4',
      'browser 2/4',
      'browser 3/4',
      'browser 4/4',
    ],
  );
  const layers = new Set(s.flatMap((x) => x.layers.split(',')));
  assert.deepEqual([...layers].sort(), [
    'browser',
    'lint',
    'mock',
    'personal',
    'scripts',
    'types',
    'unit',
  ]);
});

test('the host suite is split over two runners, by vitest shard', () => {
  const host = slices(['@patch/host'], { browser: false }).filter((x) => x.layers === 'unit');
  assert.deepEqual(
    host.map((x) => [x.name, x.packages, x.unitShard]),
    [
      ['unit host 1/2', '@patch/host', '1/2'],
      ['unit host 2/2', '@patch/host', '2/2'],
    ],
  );
});
