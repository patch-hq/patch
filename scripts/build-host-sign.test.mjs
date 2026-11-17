// What build-host.mjs signs on macOS. Notarisation unpacks the host tarball the
// Mac app carries and refuses every binary inside that is unsigned or has no
// secure timestamp, so the set is found by content and every Developer ID
// signature is timestamped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMachO, machOFiles, timestampFlag } from './build-host.mjs';

const MACHO_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
const UNIVERSAL = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02]);
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);

test('a Developer ID signature is timestamped; self-signed and ad hoc are not', () => {
  assert.equal(timestampFlag('Developer ID Application: Someone (ABCDE12345)'), '--timestamp');
  assert.equal(timestampFlag('Patch Local Signing'), '--timestamp=none');
  assert.equal(timestampFlag('-'), '--timestamp=none');
});

test('every Mach-O in the artifact is found, wherever it is, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'patch-machos-'));
  const sherpa = join(dir, 'node_modules', 'sherpa-onnx-darwin-arm64');
  mkdirSync(sherpa, { recursive: true });
  mkdirSync(join(dir, 'native'), { recursive: true });
  writeFileSync(join(dir, 'node'), MACHO_64);
  writeFileSync(join(sherpa, 'sherpa-onnx.node'), MACHO_64);
  writeFileSync(join(sherpa, 'libonnxruntime.dylib'), UNIVERSAL);
  writeFileSync(join(dir, 'native', 'libonnxruntime.1.26.0.dylib'), MACHO_64);
  symlinkSync('libonnxruntime.1.26.0.dylib', join(dir, 'native', 'libonnxruntime.1.dylib'));
  writeFileSync(join(dir, 'host.mjs'), 'export {}');
  writeFileSync(join(dir, 'rg-linux'), ELF);
  writeFileSync(join(dir, 'empty'), '');

  assert.deepEqual(
    machOFiles(dir)
      .map((f) => f.slice(dir.length + 1))
      .sort(),
    [
      'native/libonnxruntime.1.26.0.dylib',
      'node',
      'node_modules/sherpa-onnx-darwin-arm64/libonnxruntime.dylib',
      'node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node',
    ],
  );
  assert.equal(isMachO(join(dir, 'rg-linux')), false);
});
