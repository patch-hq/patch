// The release workflow splits the browser layer with PATCH_BROWSER_SHARD=i/n.
// A malformed value must stop the gate before any layer runs: a typo that
// quietly ran the whole layer (or the wrong slice) would be a gate that lies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const verify = join(dirname(fileURLToPath(import.meta.url)), 'verify.mjs');

for (const bad of ['2', '0/4', '2/0', 'a/b', '2/4/6', '']) {
  test(`PATCH_BROWSER_SHARD=${JSON.stringify(bad)} is refused before anything runs`, () => {
    const r = spawnSync('node', [verify], {
      env: { ...process.env, PATCH_BROWSER_SHARD: bad },
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PATCH_BROWSER_SHARD must look like 2\/4/);
    assert.doesNotMatch(r.stdout, /=== verify/);
  });
}

// The load targets run once per gate, alone, on the first shard; the rest of
// the browser layer is split across every shard.
function plan(shard) {
  const r = spawnSync('node', [verify, '--plan'], {
    env: { ...process.env, PATCH_BROWSER_SHARD: shard, PATCH_RUN_BROWSER_GATE: '1' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter((l) => /^[a-z +]+: /.test(l));
}

test('shard 1/4 runs its slice of the browser specs, then the load targets alone', () => {
  const lines = plan('1/4');
  const browser = lines.findIndex((l) => l.startsWith('browser: '));
  const targets = lines.findIndex((l) => l.startsWith('load targets: '));
  assert.match(lines[browser], /--project=chromium --shard=1\/4$/);
  assert.match(lines[targets], /--project=load-targets$/);
  assert.ok(targets > browser);
});

test('the other shards run their slice and no load targets', () => {
  for (const shard of ['2/4', '3/4', '4/4']) {
    const lines = plan(shard);
    assert.ok(lines.some((l) => l.endsWith(`--project=chromium --shard=${shard}`)));
    assert.ok(!lines.some((l) => l.startsWith('load targets: ')));
  }
});
