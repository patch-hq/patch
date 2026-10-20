// A host restart must not strand the agent's tab ids: a logged-in tab is
// reopened at its last address on first use, and a closed tab stays closed.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { BrowserManager, TabNotFoundError } from '../src/browser.js';
import { describeRealBrowser } from './helpers/realBrowser.js';

const silent = pino({ level: 'silent' });

describeRealBrowser('BrowserManager — tab ids survive a host restart', () => {
  let server: Server | undefined;
  let managers: BrowserManager[] = [];
  let root: string | undefined;

  afterEach(async () => {
    for (const m of managers) await m.dispose();
    managers = [];
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  async function start(): Promise<string> {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body><h1>page ${req.url}</h1></body></html>`);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function manager(display: string): BrowserManager {
    const m = new BrowserManager({ root: root!, logger: silent, virtualDisplay: display });
    managers.push(m);
    return m;
  }

  it('reopens a logged-in tab at its last address under the same id', async () => {
    const base = await start();
    root = mkdtempSync(join(tmpdir(), 'patch-browser-restart-'));
    const before = manager(':61');
    const { tabId } = await before.open({ url: `${base}/one` });
    const page = await before.read(tabId, { mode: 'text' });
    expect(page.text).toContain('page /one');
    await before.dispose();

    const after = manager(':62');
    const again = await after.read(tabId, { mode: 'text' });
    expect(again.text).toContain('page /one');
    expect(again.notices?.join(' ')).toContain('restart');
    expect((await after.tabs()).map((t) => t.tabId)).toEqual([tabId]);
  }, 60_000);

  it('does not bring back a tab that was closed on purpose', async () => {
    const base = await start();
    root = mkdtempSync(join(tmpdir(), 'patch-browser-restart-'));
    const before = manager(':63');
    const { tabId } = await before.open({ url: `${base}/two` });
    await before.close(tabId);
    await before.dispose();

    const after = manager(':64');
    await expect(after.read(tabId)).rejects.toBeInstanceOf(TabNotFoundError);
  }, 60_000);
});
