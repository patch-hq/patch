// The published zip's bundle id must be the id every running shell was installed
// with. Squirrel.Mac (ShipIt) unpacks the update and looks for a bundle whose
// identifier matches the running app; a different id fails with "Could not locate
// update bundle for <id>", and the installed app can never update itself again.
// The renames (com.tomchambers.patch -> io.github.tomchambers2.patch on 2026-10-09,
// then -> dev.patchhq.app before the public launch) did exactly that to every
// install under the old id, which needs one manual reinstall.
// Changing the id is therefore a breaking release: this test makes it deliberate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { APP_BUNDLE_ID } from './app-id';

const PUBLISHED_APP_ID = 'dev.patchhq.app';

test('the id the server agent names is the published one', () => {
  assert.equal(APP_BUNDLE_ID, PUBLISHED_APP_ID);
});

test('electron-builder appId is the id installed shells update under', () => {
  const yml = readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  const id = /^appId:\s*(\S+)/m.exec(yml)?.[1];
  assert.equal(id, PUBLISHED_APP_ID);
});

test('the release refuses to publish under a different id than the Mac bundle', () => {
  const release = readFileSync(
    join(__dirname, '..', '..', '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  assert.ok(release.includes(`Identifier=${PUBLISHED_APP_ID}`));
});
