// spec/02 § Browser — In the Patch app. The host's agent browser driven
// through the Patch app's own browser (packages/desktop/src/agent-browser.ts),
// end to end: the real bridge in a real Electron, the real BrowserManager and
// live view over it, against a local fixture site.
//
// Needs Electron (the desktop package's) and the desktop build
// (`pnpm --filter @patch/desktop build`), and Xvfb to hide the window; the
// suite is skipped, saying so, without them.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { BrowserManager, UserHandedBackError } from '../src/browser.js';
import { BrowserHandoff } from '../src/browserHandoff.js';
import { appBrowserLink } from '../src/appBrowser.js';

const DESKTOP = resolve(__dirname, '../../desktop');
const ELECTRON = join(DESKTOP, 'node_modules/.bin/electron');
const DIST = join(DESKTOP, 'dist');
const electronDist = (): boolean => {
  try {
    return (
      existsSync(join(DIST, 'agent-browser.js')) && spawnSync(ELECTRON, ['--version']).status === 0
    );
  } catch {
    return false;
  }
};
const runnable =
  process.platform === 'linux' && spawnSync('which', ['Xvfb']).status === 0 && electronDist();
if (!runnable) {
  console.warn('app-browser.test: skipped — needs Linux with Xvfb, Electron and the desktop build');
}

const silent = pino({ level: 'silent' });

function fixture(): Promise<{ server: Server; base: string }> {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture.local');
      if (url.pathname === '/file.txt') {
        res.writeHead(200, {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="ticket.txt"',
        });
        res.end('your ticket');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        ...(url.pathname === '/cookie' ? { 'set-cookie': 'seen=yes; Path=/' } : {}),
      });
      if (url.pathname === '/two') {
        res.end('<html><head><title>Two</title></head><body>second</body></html>');
        return;
      }
      res.end(`<html><head><title>Tickets</title></head><body style="margin:0">
        <input id="who" aria-label="Name" style="position:absolute;left:20px;top:20px;width:300px;height:40px" />
        <button id="go" onclick="document.title='Pressed'" style="position:absolute;left:20px;top:80px;width:120px;height:40px">Go</button>
        <a id="pop" href="/two" target="_blank" style="position:absolute;left:20px;top:140px">Open</a>
        <a id="dl" href="/file.txt" style="position:absolute;left:20px;top:180px">Ticket</a>
      </body></html>`);
    });
    server.listen(0, '127.0.0.1', () =>
      done({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    );
  });
}

describe.skipIf(!runnable)('the agent browser in the Patch app', () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let home: string;
  let app: ChildProcess;
  let xvfb: ChildProcess;
  // A display of this suite's own, stopped with it: none of the other suites use :47.
  const DISPLAY = ':47';
  let site: { server: Server; base: string };
  let browser: BrowserManager;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'patch-app-browser-'));
    mkdirSync(join(home, '.patch'));
    const endpointFile = join(home, '.patch', 'agent-browser.json');
    xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
      stdio: 'ignore',
    });
    await new Promise((r) => setTimeout(r, 500));
    app = spawn(ELECTRON, ['--no-sandbox', join(__dirname, 'fixtures/app-browser-main.cjs')], {
      env: { ...process.env, DISPLAY, ENDPOINT_FILE: endpointFile, DESKTOP_DIST: DIST },
      stdio: 'ignore',
    });
    const until = Date.now() + 30_000;
    while (!(existsSync(endpointFile) && JSON.parse(readFileSync(endpointFile, 'utf8')).endpoint)) {
      if (Date.now() > until) throw new Error('the Patch app browser never came up');
      await new Promise((r) => setTimeout(r, 200));
    }
    // Only this user may read the token that drives the signed-in browser.
    expect(statSync(endpointFile).mode & 0o077).toBe(0);
    site = await fixture();
    const link = appBrowserLink({ home, logger: silent });
    expect(link.present()).toBe(true);
    browser = new BrowserManager({
      root: join(home, 'browser'),
      logger: silent,
      appBrowser: link,
    });
  });

  afterAll(async () => {
    await browser?.dispose();
    for (const child of [app, xvfb]) {
      if (!child || child.exitCode !== null) continue;
      const gone = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await gone;
    }
    await new Promise<void>((r) => site?.server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  });

  it('opens, reads, types, clicks and screenshots a tab that lives in the app', async () => {
    const tab = await browser.open({ url: `${site.base}/`, chatId: 'c1' });
    expect(tab.title).toBe('Tickets');
    const read = await browser.read(tab.tabId);
    const name = read.snapshot.find((n) => n.name === 'Name')!;
    await browser.type(tab.tabId, name.ref, 'Tom');
    const go = read.snapshot.find((n) => n.name === 'Go')!;
    await browser.click(tab.tabId, go.ref);
    expect((await browser.read(tab.tabId)).title).toBe('Pressed');
    const shot = Buffer.from((await browser.screenshot(tab.tabId)).data, 'base64');
    expect(shot.subarray(1, 4).toString()).toBe('PNG');
    // The large view in the app shows this very tab.
    await vi.waitFor(() =>
      expect(browser.statusForChat('c1').tabs[0]!.appTarget).toMatch(/^[0-9A-F]{32}$/),
    );
  });

  it('makes a link that opens a new tab a tab of its own, opener kept', async () => {
    const tab = await browser.open({ url: `${site.base}/`, chatId: 'c2' });
    const pop = (await browser.read(tab.tabId)).snapshot.find((n) => n.name === 'Open')!;
    await browser.click(tab.tabId, pop.ref);
    await vi.waitFor(async () => {
      const tabs = await browser.tabs();
      const opened = tabs.find((t) => t.openerTabId === tab.tabId);
      expect(opened?.url).toBe(`${site.base}/two`);
    });
  });

  it('saves a download to the host and lists it', async () => {
    const tab = await browser.open({ url: `${site.base}/`, chatId: 'c3' });
    const dl = (await browser.read(tab.tabId)).snapshot.find((n) => n.name === 'Ticket')!;
    await browser.click(tab.tabId, dl.ref);
    const files = await browser.downloadsOf(tab.tabId, 10_000);
    expect(files[0]).toMatchObject({ filename: 'ticket.txt', state: 'done' });
    expect(readFileSync(files[0]!.path, 'utf8')).toBe('your ticket');
  });

  it('keeps the signed-in profile’s cookies, and a throwaway profile apart from them', async () => {
    const signedIn = await browser.open({ url: `${site.base}/cookie`, chatId: 'c4' });
    const state = await browser.stateGet(signedIn.tabId);
    expect(state.cookies.some((c) => c['name'] === 'seen')).toBe(true);
    const throwaway = await browser.open({
      url: `${site.base}/`,
      chatId: 'c4',
      profile: 'logged-out',
    });
    const fresh = await browser.stateGet(throwaway.tabId);
    expect(fresh.cookies.some((c) => c['name'] === 'seen')).toBe(false);
  });

  it('streams the live view and takes the user’s input, pausing the agent while they drive', async () => {
    const events: WireEvent[] = [];
    const handoff = new BrowserHandoff({ browser, emit: (e) => events.push(e), logger: silent });
    try {
      const tab = await browser.open({ url: `${site.base}/`, chatId: 'c5' });
      handoff.watch('c5', tab.tabId, true, { viewerId: 'v1' });
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === 'patch.browser_view.frame')).toBe(true),
      );
      await handoff.viewInput('c5', tab.tabId, { kind: 'pointer', action: 'click', x: 60, y: 40 });
      await handoff.viewInput('c5', tab.tabId, { kind: 'text', text: 'typed by hand' });
      expect(browser.driverOf(tab.tabId)).toBe('user');
      const waiting = browser.read(tab.tabId);
      waiting.catch(() => undefined);
      handoff.drive('c5', tab.tabId, 'agent');
      await expect(waiting).rejects.toBeInstanceOf(UserHandedBackError);
      const read = await browser.read(tab.tabId);
      expect(read.snapshot.find((n) => n.name === 'Name')!.value).toBe('[redacted]');
    } finally {
      handoff.dispose();
    }
  });
});
