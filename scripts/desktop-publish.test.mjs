// The order the desktop build is uploaded to the box in (scripts/desktop-publish.mjs).
//
// Clients poll latest-mac.yml and download whatever it names. The manifest has
// to be the LAST thing that changes, or there is a window where it advertises
// a zip that is not on the box yet and every shell records a 404.
//
// Run: node --test scripts/desktop-publish.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopUploadOrder } from './desktop-publish.mjs';

test('the zip is uploaded before the manifest that names it', () => {
  const order = desktopUploadOrder('Patch-0.1.9-arm64-mac.zip', { blockmap: true });
  assert.ok(order.indexOf('Patch-0.1.9-arm64-mac.zip') < order.indexOf('latest-mac.yml'));
});

test('the blockmap is uploaded before the manifest too', () => {
  const order = desktopUploadOrder('Patch-0.1.9-arm64-mac.zip', { blockmap: true });
  assert.ok(order.indexOf('Patch-0.1.9-arm64-mac.zip.blockmap') < order.indexOf('latest-mac.yml'));
});

test('without a blockmap it is just the zip, then the manifest', () => {
  const order = desktopUploadOrder('Patch-0.1.9-arm64-mac.zip', { blockmap: false });
  assert.deepEqual(order, ['Patch-0.1.9-arm64-mac.zip', 'latest-mac.yml']);
});
