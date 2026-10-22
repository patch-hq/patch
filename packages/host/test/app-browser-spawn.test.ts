// spec/02 § Browser — In the Patch app: an app that cannot be spawned fails the
// browser call, never the host process.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { BrowserNotInstalledError } from '../src/browser.js';
import { appBrowserLink } from '../src/appBrowser.js';

describe('appBrowserLink when the app cannot be spawned', () => {
  it('rejects the endpoint call instead of raising an unhandled error', async () => {
    const home = mkdtempSync(join(tmpdir(), 'app-browser-spawn-'));
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => void unhandled.push(e);
    process.on('uncaughtException', onUnhandled);
    try {
      mkdirSync(join(home, '.patch'));
      writeFileSync(
        join(home, '.patch', 'agent-browser.json'),
        JSON.stringify({ appPath: join(home, 'gone', 'electron'), version: '1' }),
      );
      const link = appBrowserLink({ home, logger: pino({ level: 'silent' }), platform: 'linux' });
      await expect(link.endpoint()).rejects.toBeInstanceOf(BrowserNotInstalledError);
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('uncaughtException', onUnhandled);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
