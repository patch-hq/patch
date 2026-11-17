import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, countPersonal, scannedFiles } from './personal-check.mjs';

test('counts every personal string, whatever the case', () => {
  assert.equal(countPersonal('ssh hetzner; curl https://Patch.TomChambers.me'), 2);
  assert.equal(countPersonal('nothing to see'), 0);
});

test('a first name counts in prompt files and in string literals, not in comments', () => {
  assert.equal(countPersonal('so it can go to Tom', 'packages/wire/src/sweep-prompt.ts'), 1);
  assert.equal(countPersonal('Tomorrow, tomato', 'packages/wire/src/x-prompt.ts'), 0);
  assert.equal(countPersonal('const m = "so it can go to Tom";', 'packages/web/src/App.tsx'), 1);
  assert.equal(countPersonal('const m = `[Pad] Tom sent ${n}`;', 'packages/server/src/format.ts'), 1);
  assert.equal(countPersonal("const m = 'it\\'s Tom';", 'packages/server/src/a.ts'), 1);
  assert.equal(countPersonal('// written for Tom\nconst a = 1;', 'packages/web/src/App.tsx'), 0);
  assert.equal(countPersonal('/* Tom said\n so */ const a = "x";', 'packages/web/src/App.tsx'), 0);
  assert.equal(countPersonal('const u = "https://x.test"; // Tom', 'packages/web/src/App.tsx'), 0);
  assert.equal(countPersonal('Tom wrote this', 'packages/web/src/index.css'), 0);
});

test('the product\'s own id and repository are not personal strings', () => {
  assert.equal(countPersonal('package io.github.tomchambers2.patch'), 0);
  assert.equal(countPersonal('io/github/tomchambers2/patch/Main.kt'), 0);
  assert.equal(countPersonal('const REPO = "tomchambers2/patch"'), 0);
  assert.equal(countPersonal('https://github.com/tomchambers2/patch'), 0);
  assert.equal(countPersonal('io.github.tomchambers2.patch and then hetzner'), 1);
  assert.equal(countPersonal('tomchambers2/some-other-repo'), 1);
});

test('product code is scanned; tests, specs and root notes are not', () => {
  const kept = scannedFiles([
    'scripts/ship.mjs',
    'packages/server/src/app.ts',
    'packages/server/test/auth.test.ts',
    'packages/web/src/__tests__/Chat.test.tsx',
    'packages/web/src/Chat.test.tsx',
    'spec/11-deployment.md',
    'NIGHT-REPORT-2026-06-22.md',
    'README.md',
    'pnpm-lock.yaml',
  ]);
  assert.deepEqual(kept, ['scripts/ship.mjs', 'packages/server/src/app.ts', 'README.md']);
});

test('a new file or a higher count fails; a lower count is only an improvement', () => {
  const baseline = { 'a.ts': 2, 'b.ts': 1 };
  const { worse, better } = compare({ 'a.ts': 3, 'c.ts': 1 }, baseline);
  assert.deepEqual(worse.map((w) => w.file).sort(), ['a.ts', 'c.ts']);
  assert.deepEqual(better.map((b) => b.file), ['b.ts']);
  assert.deepEqual(compare({ 'a.ts': 2, 'b.ts': 1 }, baseline), { worse: [], better: [] });
});
