import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDevTag } from './promote.mjs';

const releases = [
  { tagName: 'v1.1.10', isDraft: false, createdAt: '2026-10-16T10:00:00Z' },
  { tagName: 'dev-1.1.12', isDraft: false, createdAt: '2026-10-16T12:00:00Z' },
  { tagName: 'dev-1.1.11', isDraft: false, createdAt: '2026-10-16T11:00:00Z' },
  { tagName: 'dev-1.1.13', isDraft: true, createdAt: '2026-10-16T13:00:00Z' },
];

test('with no version, the newest published dev release', () => {
  assert.equal(pickDevTag(releases), 'dev-1.1.12');
});

test('a named version must exist as a published dev release', () => {
  assert.equal(pickDevTag(releases, '1.1.11'), 'dev-1.1.11');
  assert.throws(() => pickDevTag(releases, '1.1.13'), /no release dev-1.1.13/);
  assert.throws(() => pickDevTag(releases, '1.1.10'), /no release dev-1.1.10/);
});

test('nothing to promote is an error', () => {
  assert.throws(() => pickDevTag([]), /no dev releases/);
});
