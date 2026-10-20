import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relayUnit, releasePath, staleReleases } from './install-relay.mjs';

test('the relay unit binds loopback on 8787 and always restarts', () => {
  const u = relayUnit({ home: '/h/.patch-relay', node: '/usr/bin/node' });
  assert.match(u, /Environment=PORT=8787 HOST=127\.0\.0\.1/);
  assert.match(u, /ExecStart=\/usr\/bin\/node \/h\/\.patch-relay\/current\/dist\/cli\.js/);
  assert.match(u, /Restart=always/);
});

test('the installer defaults to the latest release the project publishes on GitHub', () => {
  const sh = readFileSync(
    new URL('../packages/server/release/install-server.sh', import.meta.url),
    'utf8',
  );
  assert.match(
    sh,
    /DEFAULT_RELEASE_URL="https:\/\/github\.com\/tomchambers2\/patch\/releases\/latest\/download\/patch-server\.tar\.gz"/,
  );
});

test('each install builds into a release directory of its own, never over the one running', () => {
  assert.equal(releasePath('/h/.patch-relay', 1700), '/h/.patch-relay/releases/1700');
  assert.notEqual(releasePath('/h/.patch-relay', 1700), releasePath('/h/.patch-relay', 1701));
});

test('pruning keeps the live release and the newest few, and nothing else', () => {
  const names = ['100', '300', '200', '400', '50'];
  assert.deepEqual(staleReleases(names, '50', 2).sort(), ['100', '200']);
  assert.deepEqual(staleReleases(names, '400', 2).sort(), ['100', '50']);
});
