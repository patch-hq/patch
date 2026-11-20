// A loaded-but-blank window must be named, not left white.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOUNT_PROBE, blankWindowPage } from './blank-window';

test('the probe looks at the SPA root', () => {
  assert.match(MOUNT_PROBE, /getElementById\('root'\)/);
});

test('the page names the version and links back to the app, escaped', () => {
  const html = blankWindowPage({ url: 'https://x.test/?a="<b>"', shellVersion: '1.1.1672' });
  assert.ok(html.includes('1.1.1672'));
  assert.ok(html.includes('Patch did not start'));
  assert.ok(!html.includes('<b>'));
});
