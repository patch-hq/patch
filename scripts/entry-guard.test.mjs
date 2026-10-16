// A script's "am I the entrypoint?" guard must go through lib/is-main.mjs.
// The inline spelling compares an unresolved argv path with a resolved module
// path, so running the script through a symlink (as /srv/patch is) skips its
// body silently: no output, no error, exit 0 — a check that "passes" by not
// running. See lib/is-main.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

test('no script compares process.argv[1] with its own URL by hand', () => {
  const offenders = readdirSync(here)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .filter((f) => {
      const src = readFileSync(join(here, f), 'utf8');
      return /process\.argv\[1\]\s*===|import\.meta\.url\s*===\s*`file:\/\/\$\{process\.argv\[1\]\}`/.test(
        src,
      );
    });
  assert.deepEqual(offenders, []);
});
