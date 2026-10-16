// patch_browser_handoff end to end through the MCP tool, the control socket and
// the Daemon, against a real Chromium: the agent asks, the "surface" (here, calls
// into the Daemon exactly as index.ts makes them for wire events) signs in and
// taps Done, and the agent's tool result carries none of it.

import { it, expect, vi, afterAll, beforeAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { BrowserManager } from '../src/browser.js';
import { buildControl } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { buildPatchToolsServer } from '../src/mcp.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { describeRealBrowser } from './helpers/realBrowser.js';

const LOCAL_KEY = 'test-local-key';
const silent = pino({ level: 'silent' });
const PASSWORD = 'correct-horse-battery';

describeRealBrowser('patch_browser_handoff — MCP to Chromium', () => {
  // A real Chromium on a shared, busy machine: the default 5 s is a guess about an idle one.
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  const home = mkdtempSync(join(tmpdir(), 'patch-hmcp-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-hmcp-folder-'));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  const submitted: string[] = [];
  let site: Server;
  let baseUrl = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  let browser: BrowserManager;
  let daemon: Daemon;

  beforeAll(async () => {
    site = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.writeHead(200, { 'content-type': 'text/html' });
      if (url.pathname === '/done') {
        submitted.push(url.searchParams.get('pw') ?? '');
        res.end('<html><head><title>Welcome tom</title></head><body>in</body></html>');
        return;
      }
      res.end(`<html><head><title>Sign in</title></head><body style="margin:0"><form action="/done">
        <input name="pw" type="password" style="position:absolute;left:10px;top:10px;width:300px;height:40px"/></form></body></html>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

    browser = new BrowserManager({
      root: join(home, 'browser'),
      logger: silent,
      virtualDisplay: ':90',
    });
    daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: silent,
      browser,
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
    await browser?.dispose();
    await new Promise<void>((r) => site.close(() => r()));
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
    return { isError: res.isError === true, text: res.content.map((c) => c.text ?? '').join('') };
  };
  const until = async (pred: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 25));
    if (!pred()) throw new Error(`timed out waiting for ${what}`);
  };

  it('blocks until the user taps Done, and returns neither what they typed nor the query', async () => {
    const opened = JSON.parse(
      (await call('patch_browser_open', { url: baseUrl + '/', profile: 'logged-out' })).text,
    );
    const tabId = opened.tabId as string;

    const pending = call('patch_browser_handoff', { tabId, reason: 'Enter your password' });
    const isState = (
      e: WireEvent,
    ): e is Extract<WireEvent, { type: 'patch.browser_handoff.state' }> =>
      e.type === 'patch.browser_handoff.state';
    await until(() => events.some(isState), 'the hand-off prompt');
    const prompt = events.find(isState)!;
    expect(prompt).toMatchObject({
      chatId: 'caller-1',
      reason: 'Enter your password',
      status: 'waiting',
    });

    // While the user has it, the agent's other tools refuse that tab.
    const refused = await call('patch_browser_read', { tabId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('in the user');

    await daemon.browserHandoffInput('caller-1', prompt.handoffId, {
      kind: 'pointer',
      action: 'click',
      x: 50,
      y: 30,
    });
    await daemon.browserHandoffInput('caller-1', prompt.handoffId, {
      kind: 'text',
      text: PASSWORD,
    });
    await daemon.browserHandoffInput('caller-1', prompt.handoffId, { kind: 'key', key: 'Enter' });
    await until(() => submitted.length === 1, 'the form submit');
    await until(() => browser.redactedUrl(tabId).endsWith('/done'), 'the page to navigate');
    daemon.browserHandoffControl('caller-1', 'done', prompt.handoffId);

    const result = await pending;
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({
      ok: true,
      outcome: 'done',
      url: baseUrl + '/done',
    });
    expect(result.text).not.toContain(PASSWORD);
    expect(result.text).not.toContain('Welcome');
    expect(submitted).toEqual([PASSWORD]);

    // Control is back with the agent.
    const read = JSON.parse((await call('patch_browser_read', { tabId })).text);
    expect(read.title).toBe('Welcome tom');
  });
});
