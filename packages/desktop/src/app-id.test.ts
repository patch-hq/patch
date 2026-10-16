// The published zip's bundle id must be the id every running shell was installed
// with. Squirrel.Mac (ShipIt) unpacks the update and looks for a bundle whose
// identifier matches the running app; a different id fails with "Could not locate
// update bundle for <id>", and the installed app can never update itself again.
// The 2026-10-09 rename (com.tomchambers.patch -> io.github.tomchambers2.patch)
// did exactly that to every existing install, which needs one manual reinstall.
// Changing the id is therefore a breaking release: this test makes it deliberate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PUBLISHED_APP_ID = 'io.github.tomchambers2.patch';

test('electron-builder appId is the id installed shells update under', () => {
  const yml = readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  const id = /^appId:\s*(\S+)/m.exec(yml)?.[1];
  assert.equal(id, PUBLISHED_APP_ID);
});

test('ship.mjs refuses to publish under a different id than the Mac bundle', () => {
  const ship = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'ship.mjs'), 'utf8');
  assert.ok(ship.includes(`Identifier=${PUBLISHED_APP_ID.replace(/\./g, '\\.')}`));
});
