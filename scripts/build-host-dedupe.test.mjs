import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkDuplicateFiles, machOFiles } from './build-host.mjs';

const big = (fill) => Buffer.alloc(2 * 1024 * 1024, fill);

test('the soname copy becomes a symlink to the versioned file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dedupe-'));
  writeFileSync(join(dir, 'libonnxruntime.1.26.0.dylib'), big(1));
  writeFileSync(join(dir, 'libonnxruntime.1.dylib'), big(1));
  assert.equal(linkDuplicateFiles(dir), 1);
  assert.equal(lstatSync(join(dir, 'libonnxruntime.1.26.0.dylib')).isSymbolicLink(), false);
  assert.equal(readlinkSync(join(dir, 'libonnxruntime.1.dylib')), 'libonnxruntime.1.26.0.dylib');
  assert.equal(readFileSync(join(dir, 'libonnxruntime.1.dylib')).length, 2 * 1024 * 1024);
});

test('different files and small files are left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dedupe-'));
  writeFileSync(join(dir, 'a.bin'), big(1));
  writeFileSync(join(dir, 'b.bin'), big(2));
  writeFileSync(join(dir, 'c.txt'), 'x');
  writeFileSync(join(dir, 'd.txt'), 'x');
  assert.equal(linkDuplicateFiles(dir), 0);
  assert.equal(lstatSync(join(dir, 'b.bin')).isSymbolicLink(), false);
});

test('the signer does not see the symlink, so the library is signed once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dedupe-'));
  const macho = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), big(7)]);
  writeFileSync(join(dir, 'lib.1.26.0.dylib'), macho);
  writeFileSync(join(dir, 'lib.1.dylib'), macho);
  linkDuplicateFiles(dir);
  assert.deepEqual(machOFiles(dir), [join(dir, 'lib.1.26.0.dylib')]);
});
