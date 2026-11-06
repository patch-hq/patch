// spec/02 § Browser — In the Patch app: how the host finds the app's browser,
// and starts the app when it is not running.

import { it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { appBrowserLink } from '../src/appBrowser.js';

const silent = pino({ level: 'silent' });
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'patch-app-link-'));
  homes.push(h);
  mkdirSync(join(h, '.patch'));
  return h;
}

it('is not present until the app has run on this host', () => {
  const h = home();
  const link = appBrowserLink({ home: h, logger: silent });
  expect(link.present()).toBe(false);
  writeFileSync(join(h, '.patch', 'agent-browser.json'), JSON.stringify({ appPath: '/x' }));
  expect(link.present()).toBe(true);
});

it('uses the endpoint of an app that is running', async () => {
  const h = home();
  writeFileSync(
    join(h, '.patch', 'agent-browser.json'),
    JSON.stringify({
      endpoint: 'ws://127.0.0.1:1/devtools/browser/t',
      pid: process.pid,
      appPath: '/x',
    }),
  );
  await expect(appBrowserLink({ home: h, logger: silent }).endpoint()).resolves.toBe(
    'ws://127.0.0.1:1/devtools/browser/t',
  );
});

it('starts the app when it is not running, and waits for its browser', async () => {
  const h = home();
  const file = join(h, '.patch', 'agent-browser.json');
  // Stands in for the app: comes up, says where its browser is, stays running.
  const app = join(h, 'fake-app.sh');
  writeFileSync(
    app,
    `#!/bin/sh\necho '{"endpoint":"ws://127.0.0.1:2/devtools/browser/u","pid":'$$',"appPath":"${app}"}' > ${file}\nsleep 5\n`,
  );
  chmodSync(app, 0o755);
  writeFileSync(file, JSON.stringify({ pid: 999_999_999, appPath: app }));
  await expect(
    appBrowserLink({ home: h, logger: silent, platform: 'linux' }).endpoint(),
  ).resolves.toBe('ws://127.0.0.1:2/devtools/browser/u');
});

it('says so when the app never brings its browser up', async () => {
  const h = home();
  const app = join(h, 'silent-app.sh');
  writeFileSync(app, '#!/bin/sh\nexit 0\n');
  chmodSync(app, 0o755);
  writeFileSync(join(h, '.patch', 'agent-browser.json'), JSON.stringify({ appPath: app }));
  let t = 0;
  await expect(
    appBrowserLink({
      home: h,
      logger: silent,
      platform: 'linux',
      now: () => (t += 10_000),
    }).endpoint(),
  ).rejects.toThrow(/did not start its browser/);
});
