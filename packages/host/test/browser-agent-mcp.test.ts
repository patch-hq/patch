// The finished agent browser through the real path an agent uses: MCP tool ->
// control socket -> Daemon -> a real Chromium. One test per capability group;
// the browser behaviour itself is covered in browser-agent.test.ts, this proves
// the tools are wired, validated and return what an agent can use. Also the
// per-chat Stop and the status a chat's surfaces draw it from.

import { it, expect, vi, afterAll, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { buildPatchToolsServer } from '../src/mcp.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { describeRealBrowser } from './helpers/realBrowser.js';

const LOCAL_KEY = 'test-local-key';
const silent = pino({ level: 'silent' });

type Status = Extract<WireEvent, { type: 'patch.browser_view.status' }>;

describeRealBrowser('agent browser tools — MCP to Chromium', () => {
  vi.setConfig({ testTimeout: 40_000, hookTimeout: 30_000 });
  const home = mkdtempSync(join(tmpdir(), 'patch-amcp-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-amcp-folder-'));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  let site: Server;
  let base = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  let daemon: Daemon;

  beforeAll(async () => {
    site = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const html = (b: string): void => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          `<!doctype html><html><head><title>T ${url.pathname}</title></head><body>${b}</body></html>`,
        );
      };
      if (url.pathname === '/dl') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="a.txt"',
        });
        res.end('file-body');
      } else if (url.pathname === '/who') {
        html(`<h1>${(req.headers.cookie ?? '').includes('cs=tok') ? 'in' : 'out'}</h1>`);
      } else if (url.pathname === '/api') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } else {
        html(`
          <h1>Main</h1>
          <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
          <button id="b" onclick="document.getElementById('o').textContent = confirm('sure?') ? 'yes' : 'no'">Ask</button>
          <p id="o"></p>
          <a id="dl" href="/dl" download>Download</a>
          <input type="file" aria-label="Pick" onchange="document.getElementById('o').textContent = this.files[0].name" />
          <script>console.log('hi'); fetch('/api');</script>`);
      }
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

    daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: silent,
    });
    const socketPath = join(home, 'daemon.sock');
    app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs: new MemoryJobsStore() });
    await app.listen({ path: socketPath });
    const server = buildPatchToolsServer({
      hostSocketPath: socketPath,
      chatId: 'caller-1',
      localKey: LOCAL_KEY,
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
    await (daemon as unknown as { browser: { dispose(): Promise<void> } }).browser.dispose();
    await new Promise<void>((r) => site.close(() => r()));
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text?: string; data?: string }[];
    };
    const text = res.content.map((c) => c.text ?? '').join('');
    return { isError: res.isError === true, text, res };
  };
  const json = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.text}`);
    return JSON.parse(r.text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  let tabId = '';

  it('open, read in every mode, navigate, wait, screenshot', async () => {
    tabId = (await json('patch_browser_open', { url: `${base}/`, profile: 'logged-out' }))['tabId'];

    const text = await json('patch_browser_read', { tabId, mode: 'text' });
    expect(text['text']).toContain('Main');
    const structured = await json('patch_browser_read', { tabId, mode: 'structured' });
    expect(structured['structured'].tables[0].headers).toEqual(['A', 'B']);
    const tree = await json('patch_browser_read', { tabId, mode: 'accessibility' });
    expect(tree['accessibility']).toContain('button "Ask"');
    const snap = await json('patch_browser_read', { tabId });
    expect(snap['snapshot'].some((n: { name: string }) => n.name === 'Ask')).toBe(true);

    const nav = await json('patch_browser_navigate', { tabId, action: 'goto', url: `${base}/who` });
    expect(nav['url']).toBe(`${base}/who`);
    await json('patch_browser_navigate', { tabId, action: 'back' });
    await json('patch_browser_wait', { tabId, text: 'Main', timeoutMs: 5000 });
    const missing = await call('patch_browser_wait', { tabId, text: 'zzz', timeoutMs: 300 });
    expect(missing.isError).toBe(true);
    expect((await call('patch_browser_navigate', { tabId, action: 'goto' })).isError).toBe(true);

    const shot = await call('patch_browser_screenshot', { tabId, fullPage: true });
    expect(shot.res.content[0]!.type).toBe('image');
    expect((await json('patch_browser_switch_tab', { tabId }))['tabId']).toBe(tabId);
    const tabs = await json('patch_browser_tabs', {});
    expect(tabs['tabs'].find((t: { tabId: string }) => t.tabId === tabId).active).toBe(true);
  });

  it('dialogs, downloads and file choosers', async () => {
    const snap = (await json('patch_browser_read', { tabId }))['snapshot'] as Array<{
      ref: string;
      name: string;
    }>;
    const ask = snap.find((n) => n.name === 'Ask')!.ref;
    await call('patch_browser_click', { tabId, ref: ask });
    await json('patch_browser_wait', { tabId, text: 'no', timeoutMs: 5000 });
    await json('patch_browser_dialog', { tabId, accept: true });
    await call('patch_browser_click', { tabId, ref: ask });
    await json('patch_browser_wait', { tabId, text: 'yes', timeoutMs: 5000 });
    const log = await json('patch_browser_dialog', { tabId });
    expect(log['dialogs'].map((d: { handled: string }) => d.handled)).toEqual([
      'dismissed',
      'accepted',
    ]);

    await call('patch_browser_click', { tabId, ref: snap.find((n) => n.name === 'Download')!.ref });
    const dl = await json('patch_browser_downloads', { tabId, waitSeconds: 10 });
    expect(dl['downloads'][0]).toMatchObject({ filename: 'a.txt', state: 'done' });
    expect(readFileSync(dl['downloads'][0].path, 'utf8')).toBe('file-body');

    const f = join(folder, 'chosen.txt');
    writeFileSync(f, 'x');
    await json('patch_browser_upload', {
      tabId,
      ref: snap.find((n) => n.name === 'Pick')!.ref,
      filePaths: [f],
    });
    await json('patch_browser_wait', { tabId, text: 'chosen.txt', timeoutMs: 5000 });
  });

  it('interact, eval, console, network, viewport', async () => {
    expect(
      (await json('patch_browser_interact', { tabId, action: 'hover', selector: 'h1' }))['ok'],
    ).toBe(true);
    expect((await call('patch_browser_interact', { tabId, action: 'hover' })).isError).toBe(true);
    await json('patch_browser_interact', { tabId, action: 'clipboard_write', text: 'abc' });
    expect(
      (await json('patch_browser_interact', { tabId, action: 'clipboard_read' }))['text'],
    ).toBe('abc');

    expect((await json('patch_browser_eval', { tabId, expression: '() => 6 * 7' }))['value']).toBe(
      42,
    );
    const consoleLog = await json('patch_browser_console', { tabId });
    expect(consoleLog['messages'].some((m: { text: string }) => m.text === 'hi')).toBe(true);
    const net = await json('patch_browser_network', { tabId, urlContains: '/api' });
    const req = net['requests'].at(-1);
    expect(req).toMatchObject({ status: 200 });
    const body = await json('patch_browser_network', { tabId, bodyOf: req.id });
    expect(body['body'].text).toBe('{"ok":true}');

    const phone = await json('patch_browser_viewport', { tabId, device: 'Pixel 7' });
    expect(phone['userAgent']).toContain('Android');
    const back = await json('patch_browser_viewport', { tabId, reset: true });
    expect(back['userAgent']).not.toContain('Android');
  });

  it('state: set a saved sign-in, read it back, save it, clear it, load it', async () => {
    await json('patch_browser_navigate', { tabId, action: 'goto', url: `${base}/who` });
    expect((await json('patch_browser_read', { tabId, mode: 'text' }))['text']).toBe('out');
    const set = await json('patch_browser_state', {
      tabId,
      action: 'set',
      cookies: [{ name: 'cs', value: 'tok', url: base }],
    });
    expect(set['cookies']).toBe(1);
    await json('patch_browser_navigate', { tabId, action: 'reload' });
    expect((await json('patch_browser_read', { tabId, mode: 'text' }))['text']).toBe('in');

    const got = await json('patch_browser_state', { tabId, action: 'get', domain: '127.0.0.1' });
    expect(got['state'].cookies[0]).toMatchObject({ name: 'cs', value: 'tok' });
    const file = join(folder, 'state.json');
    const saved = await json('patch_browser_state', { tabId, action: 'save', path: file });
    expect(JSON.stringify(saved)).not.toContain('tok');
    await json('patch_browser_state', { tabId, action: 'clear', cookies: true });
    await json('patch_browser_navigate', { tabId, action: 'reload' });
    expect((await json('patch_browser_read', { tabId, mode: 'text' }))['text']).toBe('out');
    await json('patch_browser_state', { tabId, action: 'load', path: file });
    await json('patch_browser_navigate', { tabId, action: 'reload' });
    expect((await json('patch_browser_read', { tabId, mode: 'text' }))['text']).toBe('in');
  });

  it("a chat's surfaces hear its browser status, and Stop ends that chat's browsing", async () => {
    events.length = 0;
    const opened = await json('patch_browser_open', { url: `${base}/`, profile: 'logged-out' });
    const mine = opened['tabId'] as string;
    const statuses = (): Status[] =>
      events.filter((e): e is Status => e.type === 'patch.browser_view.status');
    expect(statuses().at(-1)).toMatchObject({ chatId: 'caller-1', active: false });
    expect(
      statuses()
        .at(-1)!
        .tabs.map((t) => t.tabId),
    ).toContain(mine);

    const pending = call('patch_browser_wait', { tabId: mine, text: 'never', timeoutMs: 20_000 });
    const waiting = (): Status | undefined => statuses().find((s) => s.action === 'Waiting');
    for (let i = 0; i < 100 && !waiting(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(waiting()).toMatchObject({ active: true, chatId: 'caller-1' });

    // What the surface's Stop button sends.
    await daemon.browserViewStop('caller-1');
    const stopped = await pending;
    expect(stopped.isError).toBe(true);
    expect(stopped.text).toContain('Stop');
    expect(statuses().at(-1)).toMatchObject({ active: false, tabs: [] });
    expect((await call('patch_browser_read', { tabId: mine })).isError).toBe(true);
  });
});
