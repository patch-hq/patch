// Run: node --test scripts/host-smoke.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { symlinkProblems } from './host-smoke.mjs';

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-'));
  mkdirSync(join(root, 'art', 'native'), { recursive: true });
  writeFileSync(join(root, 'art', 'native', 'libx.so.1.2.3'), 'x');
  return root;
}

test('a relative symlink inside the tree is fine', () => {
  const root = tree();
  symlinkSync('libx.so.1.2.3', join(root, 'art', 'native', 'libx.so'));
  assert.deepEqual(symlinkProblems(join(root, 'art')), []);
  rmSync(root, { recursive: true });
});

test('absolute, dangling and escaping symlinks are reported', () => {
  const root = tree();
  const n = join(root, 'art', 'native');
  symlinkSync('/etc/hostname', join(n, 'abs'));
  symlinkSync('missing', join(n, 'dangling'));
  symlinkSync('../../outside', join(n, 'escape'));
  const p = symlinkProblems(join(root, 'art'));
  assert.equal(p.length, 3);
  assert.match(p.join('\n'), /absolute symlink: native\/abs/);
  assert.match(p.join('\n'), /dangling symlink: native\/dangling/);
  assert.match(p.join('\n'), /leaves the tree: native\/escape/);
  rmSync(root, { recursive: true });
});

test('the installer-style copy of a relative symlink is caught once staging is gone', () => {
  const root = tree();
  const n = join(root, 'art', 'native');
  symlinkSync('libx.so.1.2.3', join(n, 'libx.so'));
  cpSync(join(root, 'art'), join(root, 'installed'), { recursive: true });
  rmSync(join(root, 'art'), { recursive: true });
  assert.match(symlinkProblems(join(root, 'installed')).join('\n'), /libx\.so/);
  rmSync(root, { recursive: true });
});
