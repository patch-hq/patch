// Agent browser hand-off (spec/02 § Browser — Hand-off), against a REAL
// Chromium and a local fixture site: the user's live view, the user's input
// reaching the page, the tab locked against the agent meanwhile, nothing the
// user typed or any authorization code reaching the agent's result, and the
// OAuth loopback relay.

import { it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { BrowserManager, TabInHandoffError, UserHandedBackError } from '../src/browser.js';
import { BrowserHandoff } from '../src/browserHandoff.js';
import { describeRealBrowser } from './helpers/realBrowser.js';

const silent = pino({ level: 'silent' });
const PASSWORD = 'hunter2-s3cret';
const CODE = 'authcode-xyz-123';

interface Fixture {
  server: Server;
  baseUrl: string;
  submitted: string[];
  callbacks: string[];
}

function startFixture(): Promise<Fixture> {
  return new Promise((resolve) => {
    const submitted: string[] = [];
    const callbacks: string[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture.local');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (url.pathname === '/submit') {
        submitted.push(url.searchParams.get('pw') ?? '');
        res.end(
          '<html><head><title>Signed in as tom@example.com</title></head><body>ok</body></html>',
        );
        return;
      }
      if (url.pathname === '/text') {
        res.end(`<html><head><title>Words</title></head><body style="margin:0">
          <p id="t" style="position:absolute;left:20px;top:20px;margin:0;font:20px monospace">hello wonderful world</p>
        </body></html>`);
        return;
      }
      if (url.pathname === '/login') {
        res.end(`<html><head><title>Sign in to Example</title></head><body style="margin:0">
          <form method="GET" action="/submit">
            <label for="em">Email address</label><input id="em" name="em" type="email" autocomplete="username" />
            <label for="pw">Password</label><input id="pw" name="pw" type="password" />
            <button>Sign in</button>
          </form>
        </body></html>`);
        return;
      }
      if (url.pathname === '/cb') {
        callbacks.push(url.search);
        res.end('<html><body>You can close this tab.</body></html>');
        return;
      }
      // Absolutely positioned so the test knows where to click.
      res.end(`<html><head><title>Sign in</title></head><body style="margin:0">
        <form method="GET" action="/submit">
          <input id="pw" name="pw" type="password" style="position:absolute;left:20px;top:20px;width:300px;height:40px" />
        </form>
        <input id="nm" type="text" style="position:absolute;left:20px;top:160px;width:300px;height:40px" />
        <a id="consent" href="CALLBACK" style="position:absolute;left:20px;top:100px;width:300px;height:40px;display:block;background:#ccc">Approve</a>
      </body></html>`);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, submitted, callbacks });
    });
  });
}

/** Point the fixture's Approve link at `href`, as an OAuth consent screen's redirect would be. */
async function setApproveHref(browser: BrowserManager, tabId: string, href: string): Promise<void> {
  const tabs = (
    browser as unknown as {
      tabsById: Map<string, { page: { evaluate: (s: string) => Promise<unknown> } }>;
    }
  ).tabsById;
  await tabs
    .get(tabId)!
    .page.evaluate(
      `document.getElementById('consent').setAttribute('href', ${JSON.stringify(href)})`,
    );
}

describeRealBrowser('Browser hand-off — real Chromium', () => {
  // A real Chromium on a shared, busy machine: the default 5 s is a guess about an idle one.
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  let managers: BrowserManager[] = [];
  let handoffs: BrowserHandoff[] = [];
  let fixture: Fixture | undefined;
  let listeners: Server[] = [];
  let tmpDirs: string[] = [];

  afterEach(async () => {
    for (const h of handoffs) h.dispose();
    handoffs = [];
    for (const m of managers) await m.dispose();
    managers = [];
    for (const s of [fixture?.server, ...listeners]) {
      if (s) await new Promise<void>((r) => s.close(() => r()));
    }
    fixture = undefined;
    listeners = [];
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs = [];
  });

  async function setup(display: string, checkIntervalMs = 100) {
    fixture = await startFixture();
    const root = mkdtempSync(join(tmpdir(), 'patch-handoff-'));
    tmpDirs.push(root);
    const browser = new BrowserManager({ root, logger: silent, virtualDisplay: display });
    managers.push(browser);
    const events: WireEvent[] = [];
    const handoff = new BrowserHandoff({
      browser,
      emit: (e) => events.push(e),
      logger: silent,
      checkIntervalMs,
      watchTtlMs: 400,
      stateRepeatMs: 150,
    });
    handoffs.push(handoff);
    const tab = await browser.open({
      url: fixture.baseUrl + '/',
      profile: 'logged-out',
      chatId: 'c1',
    });
    return { browser, handoff, events, tab, fixture };
  }

  async function until(pred: () => boolean, what: string, ms = 8000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const stateOf = (events: WireEvent[]) =>
    events.filter(
      (e): e is Extract<WireEvent, { type: 'patch.browser_handoff.state' }> =>
        e.type === 'patch.browser_handoff.state',
    );
  const framesOf = (events: WireEvent[]) =>
    events.filter(
      (e): e is Extract<WireEvent, { type: 'patch.browser_view.frame' }> =>
        e.type === 'patch.browser_view.frame',
    );

  it('streams the tab, lets the user type a password, and returns nothing they typed', async () => {
    const { browser, handoff, events, tab, fixture } = await setup(':96');
    const result = handoff.request({
      chatId: 'c1',
      tabId: tab.tabId,
      reason: 'Sign in to Example',
    });

    await until(
      () => stateOf(events).length > 0 && framesOf(events).length > 0,
      'prompt and frame',
    );
    const waiting = stateOf(events)[0]!;
    expect(waiting).toMatchObject({
      status: 'waiting',
      chatId: 'c1',
      tabId: tab.tabId,
      reason: 'Sign in to Example',
    });
    const frame = framesOf(events)[0]!;
    expect(frame.data.length).toBeGreaterThan(100);
    expect(frame.width).toBeGreaterThan(300);

    // The agent is locked out of the tab while the user has it, and the tab list hides its title.
    await expect(browser.read(tab.tabId)).rejects.toBeInstanceOf(TabInHandoffError);
    await expect(browser.screenshot(tab.tabId)).rejects.toBeInstanceOf(TabInHandoffError);
    await expect(browser.click(tab.tabId, 'e1')).rejects.toBeInstanceOf(TabInHandoffError);
    expect((await browser.tabs())[0]!.title).toBe('');

    // The prompt is repeated while it waits, so a surface that opens the chat late still hears it.
    await until(() => stateOf(events).length >= 3, 'the prompt to be repeated');
    expect(new Set(stateOf(events).map((e) => e.handoffId)).size).toBe(1);

    const id = waiting.handoffId;
    await handoff.input('c1', id, { kind: 'pointer', action: 'click', x: 60, y: 40 });
    await handoff.input('c1', id, { kind: 'text', text: PASSWORD });
    await handoff.input('c1', id, { kind: 'key', key: 'Enter' });
    await until(() => fixture.submitted.length === 1, 'the form submit');
    await until(() => browser.redactedUrl(tab.tabId).endsWith('/submit'), 'the page to navigate');
    expect(fixture.submitted[0]).toBe(PASSWORD);

    handoff.control('c1', 'done', id);
    const out = await result;
    expect(out.outcome).toBe('done');
    expect(out.url).toBe(`${fixture.baseUrl}/submit`);
    // Neither the typed text, the query, nor the page title is in what the agent gets.
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain('tom@example.com');
    expect(stateOf(events).at(-1)).toMatchObject({ status: 'ended', outcome: 'done' });
    // Nothing about the password went into any event the host emitted other than the user's own view.
    expect(
      JSON.stringify(events.filter((e) => e.type !== 'patch.browser_view.frame')),
    ).not.toContain(PASSWORD);

    // Control returns to the agent.
    const read = await browser.read(tab.tabId);
    expect(read.title).toContain('Signed in');
  });

  it("redacts what the user typed from the agent's read of the tab after the hand-off", async () => {
    const { browser, handoff, events, tab } = await setup(':95');
    const result = handoff.request({ chatId: 'c1', tabId: tab.tabId, reason: 'Sign in' });
    await until(() => stateOf(events).length > 0, 'prompt');
    const id = stateOf(events)[0]!.handoffId;
    await handoff.input('c1', id, { kind: 'pointer', action: 'click', x: 60, y: 40 });
    await handoff.input('c1', id, { kind: 'text', text: PASSWORD });
    await handoff.input('c1', id, { kind: 'pointer', action: 'click', x: 60, y: 180 });
    await handoff.input('c1', id, { kind: 'text', text: 'tom-the-username' });
    handoff.control('c1', 'done', id);
    await result;

    const read = await browser.read(tab.tabId);
    const serialised = JSON.stringify(read);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain('tom-the-username');
    const pw = read.snapshot.find((n) => n.type === 'password')!;
    expect(pw.value).toBe('[redacted]');
    expect(read.snapshot.find((n) => n.tag === 'input' && n.type === 'text')!.value).toBe(
      '[redacted]',
    );
  });

  it('ends as cancelled, and as timeout, and refuses input for a hand-off that is not live', async () => {
    const { handoff, events, tab, browser } = await setup(':95');
    const first = handoff.request({ chatId: 'c1', tabId: tab.tabId, reason: 'x' });
    await until(() => stateOf(events).length > 0, 'prompt');
    handoff.control('c1', 'cancel', stateOf(events)[0]!.handoffId);
    expect((await first).outcome).toBe('cancelled');

    await handoff.input('c1', 'not-a-handoff', { kind: 'text', text: PASSWORD }); // ignored, does not throw
    expect(browser.isHandedOff(tab.tabId)).toBe(false);

    const second = await handoff.request({
      chatId: 'c1',
      tabId: tab.tabId,
      reason: 'x',
      timeoutMs: 300,
    });
    expect(second.outcome).toBe('timeout');
    expect(browser.isHandedOff(tab.tabId)).toBe(false);
  });

  it('ends as tab_closed when the tab goes away under the user', async () => {
    const { handoff, events, tab, browser } = await setup(':94');
    const run = handoff.request({ chatId: 'c1', tabId: tab.tabId, reason: 'x' });
    await until(() => framesOf(events).length > 0, 'a frame');
    await browser.close(tab.tabId);
    expect((await run).outcome).toBe('tab_closed');
  });

  it('streams read-only frames to a watcher with no hand-off, and stops when the watch lapses', async () => {
    const { handoff, events, tab, browser } = await setup(':93');
    handoff.watch('c1', undefined, true); // the chat's own latest tab
    // A still page paints once, so it sends one frame until something changes.
    await until(() => framesOf(events).length >= 1, 'a frame');
    expect(stateOf(events)).toHaveLength(0);
    // Read-only: input is refused because there is no hand-off, and the agent is not locked out.
    await handoff.input('c1', 'none', { kind: 'text', text: 'x' });
    expect((await browser.read(tab.tabId)).title).toBe('Sign in');
    // No renewal: the stream stops by itself after the TTL.
    await new Promise((r) => setTimeout(r, 900));
    const n = framesOf(events).length;
    await new Promise((r) => setTimeout(r, 400));
    expect(framesOf(events).length).toBe(n);
  });

  it('relays the OAuth loopback callback to the waiting process without exposing the code', async () => {
    const { handoff, events, tab, browser } = await setup(':92');
    const received: string[] = [];
    const listener = createServer((req, res) => {
      received.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>All done, close this tab.</body></html>');
    });
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
    listeners.push(listener);
    const port = (listener.address() as AddressInfo).port;

    await setApproveHref(
      browser,
      tab.tabId,
      `http://localhost:${port}/callback?code=${CODE}&state=s1`,
    );

    const run = handoff.request({
      chatId: 'c1',
      tabId: tab.tabId,
      reason: 'Approve access',
      callbackPort: port,
    });
    await until(() => framesOf(events).length > 0, 'a frame');
    const id = stateOf(events)[0]!.handoffId;
    await handoff.input('c1', id, { kind: 'pointer', action: 'click', x: 100, y: 120 });

    const out = await run;
    expect(out.outcome).toBe('callback');
    expect(out.callbackStatus).toBe(200);
    expect(received).toEqual([`/callback?code=${CODE}&state=s1`]);
    expect(JSON.stringify(out)).not.toContain(CODE);
    expect(
      JSON.stringify(events.filter((e) => e.type !== 'patch.browser_view.frame')),
    ).not.toContain(CODE);
    expect(browser.isHandedOff(tab.tabId)).toBe(false);
  });

  it('fails loudly, and gives the tab back, when nothing is listening on the callback port', async () => {
    const { handoff, events, tab, browser } = await setup(':91');
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    await setApproveHref(browser, tab.tabId, `http://localhost:${port}/callback?code=${CODE}`);

    const run = handoff.request({
      chatId: 'c1',
      tabId: tab.tabId,
      reason: 'x',
      callbackPort: port,
    });
    const failure = run.then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await until(() => framesOf(events).length > 0, 'a frame');
    await handoff.input('c1', stateOf(events)[0]!.handoffId, {
      kind: 'pointer',
      action: 'click',
      x: 100,
      y: 120,
    });
    const message = await failure;
    expect(message).toContain(`port ${port} could not be reached`);
    expect(message).not.toContain(CODE);
    expect(browser.isHandedOff(tab.tabId)).toBe(false);
  });

  /** A view stays open the way a surface keeps it open: by renewing its watch. */
  const renewals: NodeJS.Timeout[] = [];
  afterEach(() => {
    for (const t of renewals.splice(0)) clearInterval(t);
  });
  function keepWatching(
    handoff: BrowserHandoff,
    tabId: string,
    view: Parameters<BrowserHandoff['watch']>[3],
  ): () => void {
    handoff.watch('c1', tabId, true, view);
    const t = setInterval(() => handoff.watch('c1', tabId, true, view), 100);
    renewals.push(t);
    return () => clearInterval(t);
  }

  /** Width and height of a base64 JPEG, read from its start-of-frame marker. */
  function jpegSize(b64: string): { width: number; height: number } {
    const b = Buffer.from(b64, 'base64');
    for (let i = 2; i < b.length; ) {
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    throw new Error('no frame header in that JPEG');
  }

  it('pauses the agent while the user drives, and tells it to look again when handed back', async () => {
    const { browser, handoff, tab } = await setup(':51');
    keepWatching(handoff, tab.tabId, { viewerId: 'v1' });
    // Just using the page takes it over: no button needed.
    await handoff.viewInput('c1', tab.tabId, { kind: 'pointer', action: 'click', x: 60, y: 180 });
    await handoff.viewInput('c1', tab.tabId, { kind: 'text', text: 'tom-the-username' });
    expect(browser.statusForChat('c1').tabs[0]!.driver).toBe('user');

    let settled = false;
    const agentRead = browser.read(tab.tabId).finally(() => (settled = true));
    agentRead.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false); // the agent waits while the user drives

    handoff.drive('c1', tab.tabId, 'agent');
    await expect(agentRead).rejects.toBeInstanceOf(UserHandedBackError);
    expect(browser.statusForChat('c1').tabs[0]!.driver).toBe('agent');

    // Its next look works, and what the user typed is not in it.
    const read = await browser.read(tab.tabId);
    expect(JSON.stringify(read)).not.toContain('tom-the-username');
  });

  it("lays the page out at a large view's size and pixel ratio, then puts the agent's size back", async () => {
    const { browser, handoff, events, tab } = await setup(':52');
    const closeLarge = keepWatching(handoff, tab.tabId, {
      viewerId: 'v1',
      viewport: { width: 700, height: 500, scale: 2 },
    });
    await until(
      () => framesOf(events).some((f) => f.width === 700 && jpegSize(f.data).width === 1400),
      'a sharp 700-wide frame',
    );
    const frame = framesOf(events).find((f) => f.width === 700)!;
    expect(frame.height).toBe(500);
    expect(frame.inputVersion).toBe(2);
    // The agent's coordinates stay CSS pixels however sharp the view.
    expect(await browser.viewport(tab.tabId)).toEqual({ width: 700, height: 500 });
    const shot = Buffer.from((await browser.screenshot(tab.tabId)).data, 'base64');
    expect([shot.readUInt32BE(16), shot.readUInt32BE(20)]).toEqual([700, 500]);

    // A preview joining does not undo the large view's size.
    keepWatching(handoff, tab.tabId, { viewerId: 'v2' });
    await new Promise((r) => setTimeout(r, 200));
    expect(await browser.viewport(tab.tabId)).toEqual({ width: 700, height: 500 });

    // The large view closes: the agent's own size and pixel ratio come back.
    closeLarge();
    handoff.watch('c1', tab.tabId, false, { viewerId: 'v1' });
    await until(() => framesOf(events).at(-1)!.width === 1280, 'a frame at the agent size');
    expect(await browser.viewport(tab.tabId)).toEqual({ width: 1280, height: 720 });
    const dpr = await browser.evaluate(tab.tabId, 'devicePixelRatio');
    expect(dpr).toEqual(expect.objectContaining({ value: 1 }));
  });

  it('drags to select text and copies it to the user', async () => {
    const { handoff, events, tab, fixture } = await setup(':53');
    keepWatching(handoff, tab.tabId, { viewerId: 'v1' });
    await handoff.viewInput('c1', tab.tabId, {
      kind: 'nav',
      action: 'goto',
      url: `${fixture.baseUrl}/text`,
    });
    await until(() => framesOf(events).some((f) => f.url.endsWith('/text')), 'the text page');
    await new Promise((r) => setTimeout(r, 300));
    await handoff.viewInput('c1', tab.tabId, { kind: 'pointer', action: 'down', x: 21, y: 32 });
    await handoff.viewInput('c1', tab.tabId, { kind: 'pointer', action: 'move', x: 90, y: 32 });
    await handoff.viewInput('c1', tab.tabId, { kind: 'pointer', action: 'up', x: 90, y: 32 });
    await handoff.viewInput('c1', tab.tabId, { kind: 'copy' });
    const clip = events.find((e) => e.type === 'patch.browser_view.clipboard') as
      | Extract<WireEvent, { type: 'patch.browser_view.clipboard' }>
      | undefined;
    expect(clip?.text.length).toBeGreaterThanOrEqual(3);
    expect('hello wonderful world'.startsWith(clip!.text)).toBe(true);
    // Back on the toolbar.
    await handoff.viewInput('c1', tab.tabId, { kind: 'nav', action: 'back' });
    await until(() => framesOf(events).at(-1)!.url.endsWith('/'), 'back to the first page');
    expect(framesOf(events).at(-1)!.canGoForward).toBe(true);
  });

  it('shows the sign-in form to the surface during a hand-off and fills it from its own fields', async () => {
    const { browser, handoff, events, tab, fixture } = await setup(':54');
    await browser.navigate(tab.tabId, 'goto', `${fixture.baseUrl}/login`);
    const result = handoff.request({ chatId: 'c1', tabId: tab.tabId, reason: 'Sign in' });
    await until(
      () => events.some((e) => e.type === 'patch.browser_view.form' && e.fields.length === 2),
      'the sign-in form',
    );
    const form = events.find(
      (e) => e.type === 'patch.browser_view.form' && e.fields.length === 2,
    ) as Extract<WireEvent, { type: 'patch.browser_view.form' }>;
    expect(form.site).toBe('127.0.0.1');
    expect(form.fields.map((f) => [f.kind, f.label])).toEqual([
      ['email', 'Email address'],
      ['password', 'Password'],
    ]);
    await handoff.viewInput('c1', tab.tabId, {
      kind: 'fill',
      formId: form.formId,
      values: [
        { field: form.fields[0]!.field, value: 'tom@example.com' },
        { field: form.fields[1]!.field, value: PASSWORD },
      ],
      submit: true,
    });
    await until(() => fixture.submitted.includes(PASSWORD), 'the form to be submitted');
    handoff.control('c1', 'done', stateOf(events)[0]!.handoffId);
    expect(JSON.stringify(await result)).not.toContain(PASSWORD);
  });
});
