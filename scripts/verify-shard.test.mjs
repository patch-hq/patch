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
