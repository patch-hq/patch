// Merging the Mac's darwin build into the box's host manifest
// (scripts/host-manifest.mjs).
//
// Run: node scripts/host-manifest.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHostArtifact } from './host-manifest.mjs';

const linux = { target: 'linux-x64', file: 'patch-host-0.1.9-linux-x64.tar.gz', sha256: 'aa' };
const darwin = {
  target: 'darwin-arm64',
  file: 'patch-host-0.1.9-darwin-arm64.tar.gz',
  sha256: 'bb',
};
const box = { version: '0.1.9', gitSha: 'abc1234', signingPublicKey: 'K', artifacts: [linux] };
const mac = { version: '0.1.9', gitSha: 'abc1234', signingPublicKey: 'K', artifacts: [darwin] };

test("adds the Mac's artifact beside the box's", () => {
  const merged = mergeHostArtifact(box, mac, 'darwin-arm64');
  assert.deepEqual(merged.artifacts, [linux, darwin]);
  assert.equal(merged.version, '0.1.9');
});

test('replaces an earlier darwin entry rather than listing two', () => {
  const stale = { ...darwin, sha256: 'old' };
  const merged = mergeHostArtifact({ ...box, artifacts: [linux, stale] }, mac, 'darwin-arm64');
  assert.deepEqual(merged.artifacts, [linux, darwin]);
});

test('refuses a Mac build of another commit', () => {
  assert.throws(
    () => mergeHostArtifact(box, { ...mac, version: '0.1.8', gitSha: 'fff0000' }, 'darwin-arm64'),
    /refusing to mix two builds/,
  );
});

test("accepts the Mac's 7-char abbreviation of the box's 8-char sha", () => {
  const merged = mergeHostArtifact(
    { ...box, gitSha: 'abc1234d' },
    { ...mac, gitSha: 'abc1234' },
    'darwin-arm64',
  );
  assert.deepEqual(merged.artifacts, [linux, darwin]);
});

test('refuses a Mac build signed with another artifact key', () => {
  assert.throws(
    () => mergeHostArtifact(box, { ...mac, signingPublicKey: 'other' }, 'darwin-arm64'),
    /different artifact key/,
  );
});

test('refuses a Mac manifest without the target it claims to have built', () => {
  assert.throws(
    () => mergeHostArtifact(box, { ...mac, artifacts: [] }, 'darwin-arm64'),
    /no darwin-arm64/,
  );
});
