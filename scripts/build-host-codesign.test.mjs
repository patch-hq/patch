// Run: node --test scripts/build-host-codesign.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timestampFlag } from './build-host.mjs';

test('a Developer ID identity takes a secure timestamp, anything else stays offline', () => {
  assert.equal(timestampFlag('Developer ID Application: Tom Chambers (ABCDE12345)'), '--timestamp');
  assert.equal(timestampFlag('-'), '--timestamp=none');
  assert.equal(timestampFlag('Patch Dev Cert'), '--timestamp=none');
});
