// pnpm 10 runs `pre<name>` / `post<name>` scripts implicitly. A script called
// "prebuild" in apps/mobile made every `build` run `expo prebuild`, rewriting the
// committed android/ project mid-test-run. Native generation is `native:prebuild`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Deliberate hooks, reviewed: they run around a script that is not part of any test or build.
const ALLOWED = new Set(['packages/desktop/package.json:postdist:dry']);

const roots = ['.', ...['apps', 'packages'].flatMap((d) => (existsSync(d) ? readdirSync(d).map((n) => join(d, n)) : []))];

test('no package has a script that pnpm would run implicitly around another', () => {
  for (const dir of roots) {
    const file = join(dir, 'package.json');
    if (!existsSync(file)) continue;
    const scripts = Object.keys(JSON.parse(readFileSync(file, 'utf8')).scripts ?? {});
    for (const name of scripts) {
      const m = /^(pre|post)(.+)$/.exec(name);
      if (m && !ALLOWED.has(`${file}:${name}`) && scripts.includes(m[2])) assert.fail(`${file}: "${name}" runs implicitly around "${m[2]}"; rename it`);
    }
  }
});
