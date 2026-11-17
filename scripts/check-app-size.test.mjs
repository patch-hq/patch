import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSize } from './check-app-size.mjs';

function app() {
  const dir = mkdtempSync(join(tmpdir(), 'patch-size-'));
  mkdirSync(join(dir, 'Resources', 'host'), { recursive: true });
  writeFileSync(join(dir, 'Resources', 'host', 'big.bin'), Buffer.alloc(3 * 1024 * 1024));
  writeFileSync(join(dir, 'small'), 'x');
  return dir;
}

test('passes under budget', () => {
  const r = checkSize(app(), 5);
  assert.equal(r.ok, true);
});

test('fails over budget and names the largest item', () => {
  const r = checkSize(app(), 2);
  assert.equal(r.ok, false);
  assert.match(r.report, /Resources\/host\/big\.bin/);
});
