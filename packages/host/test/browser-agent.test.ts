// Agent browser, the "do anything a person can" surface (spec/02 § Browser,
// spec/06 § Browser tools): reading, navigation, waiting, popups/dialogs/
// downloads/file choosers, richer interaction, state, debugging, self-healing
// and per-chat stop. Everything runs against a REAL Chromium under Xvfb and a
// local fixture site — a mocked page would prove nothing about any of it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import {
  BrowserManager,
  BrowserStoppedError,
  RefNotFoundError,
  TabNotFoundError,
  type SnapshotNode,
} from '../src/browser.js';
import { describeRealBrowser } from './helpers/realBrowser.js';

const silent = pino({ level: 'silent' });

interface Fixture {
  server: Server;
  base: string;
  /** A second origin (127.0.0.1 vs localhost): cross-origin iframes. */
  otherBase: string;
  close: () => Promise<void>;
}

const page = (body: string, head = ''): string =>
  `<!doctype html><html><head><title>fixture</title>${head}</head><body>${body}</body></html>`;

async function startFixture(): Promise<Fixture> {
  let other!: Server;
  const handler =
    (getOther: () => string) =>
    (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
      const url = new URL(req.url ?? '/', 'http://fixture.local');
      const html = (body: string, head = ''): void => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(body, head));
      };
      switch (url.pathname) {
        case '/rich':
          html(`
            <h1>Fixture article</h1>
            <article>
              <h2>Intro</h2>
              <p>The first paragraph of a long article about badgers and the tunnels they dig under the hill.</p>
              <p>The second paragraph keeps going so the article is clearly the biggest block of text on the page, which is what the reader looks for.</p>
              <p>${'Badgers are nocturnal and live in setts. '.repeat(10)}</p>
            </article>
            <table>
              <caption>Prices</caption>
              <thead><tr><th>Item</th><th>Cost</th></tr></thead>
              <tbody><tr><td>Tea</td><td>2</td></tr><tr><td>Cake</td><td>4</td></tr></tbody>
            </table>
            <ul><li>alpha</li><li>beta</li><li>gamma</li></ul>
            <a href="/nav2">Go to two</a>
            <button id="plain">Plain button</button>
            <div id="host"></div>
            <iframe id="same" src="/frame" width="300" height="80"></iframe>
            <iframe id="cross" src="${getOther()}/frame" width="300" height="80"></iframe>
            <div style="height:2400px;background:linear-gradient(#fff,#ccc)">tall</div>
            <script>
              const root = document.getElementById('host').attachShadow({ mode: 'open' });
              root.innerHTML = '<button id="sb">Shadow button</button><p id="so"></p>';
              root.getElementById('sb').onclick = () => { root.getElementById('so').textContent = 'shadow clicked'; };
            </script>`);
          return;
        case '/frame':
          html(
            `<button id="fb" onclick="document.getElementById('fo').textContent='frame clicked'">Frame button</button><p id="fo"></p>`,
          );
          return;
        case '/nav1':
          html(`<h1>one</h1><a href="/nav2">two</a>`);
          return;
        case '/nav2':
          html(`<h1>two</h1>`);
          return;
        case '/delayed':
          html(
            `<p id="st">waiting</p><button id="go">Go</button><div id="late-slot"></div>
             <script>
               setTimeout(() => { document.getElementById('st').textContent = 'loaded now'; }, 700);
               setTimeout(() => { document.getElementById('late-slot').innerHTML = '<span id="late">late arrival</span>'; }, 900);
               setTimeout(() => { history.pushState({}, '', '/delayed?done=1'); }, 1100);
             </script>`,
          );
          return;
        case '/popups':
          html(`
            <a href="/nav2" target="_blank">blank link</a>
            <a href="/nav2" target="_blank" rel="noopener">noopener link</a>
            <button onclick="window.open('/nav1')">window.open</button>`);
          return;
        case '/dialogs':
          html(`
            <button id="a" onclick="alert('heads up'); document.getElementById('out').textContent='after alert'">alert</button>
            <button id="c" onclick="document.getElementById('out').textContent='confirm=' + confirm('really?')">confirm</button>
            <button id="p" onclick="document.getElementById('out').textContent='prompt=' + prompt('name?', 'def')">prompt</button>
            <p id="out"></p>`);
          return;
        case '/download':
          html(`<a id="dl" href="/file.txt" download>get the file</a>`);
          return;
        case '/file.txt':
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="report one.txt"',
          });
          res.end('downloaded body 12345');
          return;
        case '/chooser':
          html(`
            <button id="pick" onclick="document.getElementById('f').click()">Pick a file</button>
            <input type="file" id="f" style="display:none" onchange="document.getElementById('out').textContent = this.files[0].name" />
            <p id="out"></p>`);
          return;
        case '/interact':
          html(
            `
            <div id="hov" style="padding:10px;background:#eee" onmouseenter="this.textContent='hovered'">hover me</div>
            <div id="drag" draggable="true" style="width:80px;height:30px;background:#9cf" ondragstart="event.dataTransfer.setData('text','x')">drag me</div>
            <div id="zone" style="width:120px;height:50px;background:#fc9" ondragover="event.preventDefault()" ondrop="event.preventDefault();this.textContent='dropped'">zone</div>
            <input id="keys" aria-label="Keys" onkeydown="document.getElementById('kout').textContent += event.key + ';'" />
            <p id="kout"></p>
            <p id="para">Alpha beta gamma</p>
            <p id="sel"></p>
            <input id="src" aria-label="Source" value="copy me please" />
            <input id="dst" aria-label="Destination" />
            <div style="height:2000px"></div>
            <button id="far">Far button</button>
            <script>document.addEventListener('selectionchange', () => { document.getElementById('sel').textContent = String(getSelection()); });</script>`,
          );
          return;
        case '/state':
          html(`<p id="cookies"></p><p id="ls"></p><script>
            document.getElementById('cookies').textContent = document.cookie;
            document.getElementById('ls').textContent = localStorage.getItem('token') || 'none';
          </script>`);
          return;
        case '/account':
          html(
            `<h1 role="status">${(req.headers.cookie ?? '').includes('cs=tok123') ? 'Signed in as cadence' : 'signed out'}</h1>`,
          );
          return;
        case '/console':
          html(`<script>
            console.log('hello-log'); console.error('boom-error');
            fetch('/api/data').then((r) => r.json());
            fetch('/api/missing');
            setTimeout(() => { throw new Error('uncaught-thing'); }, 50);
          </script>`);
          return;
        case '/api/data':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ x: 1, name: 'fixture' }));
          return;
        case '/viewport':
          html(
            `<p id="w"></p><script>document.getElementById('w').textContent = innerWidth;</script>`,
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
          );
          return;
        case '/slow-hold':
          // never ends within a test: an in-flight action to stop
          html(`<p>holding</p>`);
          return;
        default:
          res.writeHead(404);
          res.end('not found');
      }
    };
  const listen = (s: Server): Promise<void> =>
    new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  let otherBase = '';
  const server = createServer(handler(() => otherBase));
  other = createServer(handler(() => otherBase));
  await Promise.all([listen(server), listen(other)]);
  // `localhost` and `127.0.0.1` are different origins to the browser.
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  return {
    server,
    base,
    otherBase,
    close: async () => {
      await Promise.all(
        [server, other].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      );
    },
  };
}

function ref(snapshot: SnapshotNode[], pred: (n: SnapshotNode) => boolean): string {
  const node = snapshot.find(pred);
  if (!node) throw new Error(`no matching node in ${JSON.stringify(snapshot)}`);
  return node.ref;
}

const named = (name: string) => (n: SnapshotNode) => n.name === name;

/** What the page says in a given element, read the way the agent would: eval. */
async function textOf(m: BrowserManager, tabId: string, selector: string): Promise<string> {
  const { value } = await m.evaluate(
    tabId,
    `document.querySelector(${JSON.stringify(selector)}).textContent`,
  );
  return String(value);
}

describeRealBrowser('agent browser — a full browser for an agent', () => {
  let fx: Fixture;
  let m: BrowserManager;
  let root: string;
  const activity: string[] = [];

  beforeAll(async () => {
    fx = await startFixture();
    root = mkdtempSync(join(tmpdir(), 'patch-browser-agent-'));
    m = new BrowserManager({
      root,
      logger: silent,
      virtualDisplay: ':71',
      onActivity: (c) => activity.push(c),
    });
  }, 30_000);

  afterAll(async () => {
    await m.dispose();
    await fx.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function open(path: string, chatId = 'chat-main'): Promise<string> {
    const r = await m.open({ url: `${fx.base}${path}`, chatId });
    return r.tabId;
  }

  describe('reading', () => {
    it('reads the whole text of a page, not 200-char labels', async () => {
      const t = await open('/rich');
      const r = await m.read(t, { mode: 'text' });
      expect(r.text).toContain('Fixture article');
      expect(r.text).toContain('The second paragraph keeps going');
      expect(r.text).toContain('Badgers are nocturnal and live in setts. Badgers are nocturnal');
      // The iframe's text is included, labelled.
      expect(r.text).toContain('Frame button');
      const scoped = await m.read(t, {
        mode: 'text',
        ref: ref((await m.read(t)).snapshot!, named('Plain button')),
      });
      expect(scoped.text).toBe('Plain button');
      const cut = await m.read(t, { mode: 'text', maxChars: 100 });
      expect(cut.truncated).toBe(true);
      expect(cut.text!.length).toBe(100);
    }, 30_000);

    it('returns tables, lists, headings, links and the article body as data', async () => {
      const t = await open('/rich');
      const { structured } = await m.read(t, { mode: 'structured' });
      expect(structured!.tables).toEqual([
        {
          caption: 'Prices',
          headers: ['Item', 'Cost'],
          rows: [
            ['Tea', '2'],
            ['Cake', '4'],
          ],
        },
      ]);
      expect(structured!.lists).toContainEqual({ kind: 'ul', items: ['alpha', 'beta', 'gamma'] });
      expect(structured!.headings.map((h) => h.text)).toEqual(['Fixture article', 'Intro']);
      expect(structured!.article).toContain('first paragraph of a long article');
      expect(structured!.links).toContainEqual({ text: 'Go to two', href: `${fx.base}/nav2` });
    }, 30_000);

    it("returns the browser's accessibility tree", async () => {
      const t = await open('/rich');
      const { accessibility } = await m.read(t, { mode: 'accessibility' });
      expect(accessibility).toContain('heading "Fixture article"');
      expect(accessibility).toContain('button "Plain button"');
      expect(accessibility).toContain('link "Go to two"');
    }, 30_000);

    it('sees into iframes (same and cross origin) and open shadow DOM, and acts there', async () => {
      const t = await open('/rich');
      const { snapshot } = await m.read(t);
      const shadow = snapshot!.find(named('Shadow button'))!;
      expect(shadow).toBeDefined();
      const frameBtns = snapshot!.filter(named('Frame button'));
      expect(frameBtns).toHaveLength(2);
      expect(frameBtns.map((n) => n.frame).sort()).toEqual(
        [`${fx.base}/frame`, `${fx.otherBase}/frame`].sort(),
      );
      // Every ref is unique across frames.
      expect(new Set(snapshot!.map((n) => n.ref)).size).toBe(snapshot!.length);

      await m.click(t, shadow.ref);
      const { value } = await m.evaluate(
        t,
        `document.getElementById('host').shadowRoot.getElementById('so').textContent`,
      );
      expect(value).toBe('shadow clicked');

      for (const n of frameBtns) await m.click(t, n.ref);
      const same = await m.evaluate(
        t,
        `document.getElementById('same').contentDocument.getElementById('fo').textContent`,
      );
      expect(same.value).toBe('frame clicked');
      const crossRead = await m.read(t, { mode: 'text' });
      expect(crossRead.text!.match(/frame clicked/g)).toHaveLength(2);
    }, 30_000);

    it('keeps refs stable across reads, and a ref dies only when its element does', async () => {
      const t = await open('/delayed');
      const first = (await m.read(t)).snapshot!;
      const again = (await m.read(t)).snapshot!;
      expect(again).toEqual(first);
      await m.waitFor(t, { selector: '#late' });
      const later = (await m.read(t)).snapshot!;
      expect(later.length).toBeGreaterThanOrEqual(first.length);
      await m.evaluate(t, `document.getElementById('late').remove()`);
      await expect(m.click(t, 'e999')).rejects.toBeInstanceOf(RefNotFoundError);
    }, 30_000);

    it('takes element and full-page screenshots', async () => {
      const t = await open('/rich');
      const viewportShot = await m.screenshot(t);
      const fullShot = await m.screenshot(t, { fullPage: true });
      const btn = ref((await m.read(t)).snapshot!, named('Plain button'));
      const elShot = await m.screenshot(t, { ref: btn });
      const size = (b64: string): { w: number; h: number } => {
        const buf = Buffer.from(b64, 'base64');
        return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
      };
      expect(size(fullShot.data).h).toBeGreaterThan(size(viewportShot.data).h + 1000);
      const e = size(elShot.data);
      expect(e.w).toBeLessThan(300);
      expect(e.h).toBeLessThan(80);
    }, 30_000);
  });

  describe('navigation, tabs and waiting', () => {
    it('navigates an existing tab: goto, back, forward, reload — without a new tab', async () => {
      const t = await open('/nav1');
      const before = (await m.tabs()).length;
      const g = await m.navigate(t, 'goto', `${fx.base}/nav2`);
      expect(g.url).toBe(`${fx.base}/nav2`);
      expect(g.status).toBe(200);
      expect((await m.navigate(t, 'back')).url).toBe(`${fx.base}/nav1`);
      expect((await m.navigate(t, 'forward')).url).toBe(`${fx.base}/nav2`);
      await m.evaluate(t, `window.marker = 1`);
      await m.navigate(t, 'reload');
      expect((await m.evaluate(t, `window.marker === undefined`)).value).toBe(true);
      expect((await m.tabs()).length).toBe(before);
      await expect(m.navigate(t, 'goto')).rejects.toThrow(/needs a url/);
    }, 30_000);

    it('going back with no history fails loudly', async () => {
      const t = await open('/nav1');
      await expect(m.navigate(t, 'back')).rejects.toThrow(/no page to go back to/);
    }, 30_000);

    it('switches tabs and marks the active one', async () => {
      const a = await open('/nav1');
      const b = await open('/nav2');
      await m.switchTo(a);
      expect((await m.tabs()).find((x) => x.active)?.tabId).toBe(a);
      await m.switchTo(b);
      expect((await m.tabs()).find((x) => x.active)?.tabId).toBe(b);
      await m.close(a);
      await expect(m.switchTo(a)).rejects.toBeInstanceOf(TabNotFoundError);
    }, 30_000);

    it('waits for text, an element, a url change and network idle — and times out loudly', async () => {
      const t = await open('/delayed');
      const r = await m.waitFor(t, { text: 'loaded now' });
      expect(r.waitedMs).toBeGreaterThan(300);
      await m.waitFor(t, { selector: '#late', state: 'visible' });
      await m.waitFor(t, { url: 'done=1' });
      await m.waitFor(t, { networkIdle: true });
      await m.waitFor(t, { textGone: 'waiting' });
      await m.waitFor(t, { ms: 50 });
      await expect(m.waitFor(t, { text: 'never appears', timeoutMs: 400 })).rejects.toThrow(
        /Timeout/i,
      );
      await expect(m.waitFor(t, {})).rejects.toThrow(/needs one of/);
    }, 30_000);

    it('waits for a ref to leave the page', async () => {
      const t = await open('/delayed');
      await m.waitFor(t, { selector: '#late' });
      const late = ref((await m.read(t)).snapshot!, () => true);
      await m.evaluate(
        t,
        `setTimeout(() => document.querySelectorAll('[data-patch-ref]').forEach((e) => e.remove()), 300)`,
      );
      const r = await m.waitFor(t, { ref: late, state: 'detached', timeoutMs: 5000 });
      expect(r.waitedMs).toBeGreaterThan(150);
    }, 30_000);
  });

  describe('pages that open things', () => {
    it('adopts a target=_blank, a noopener link and window.open as tabs of the same chat', async () => {
      const t = await open('/popups', 'chat-pop');
      const { snapshot } = await m.read(t);
      await m.click(t, ref(snapshot!, named('blank link')));
      await m.click(t, ref(snapshot!, named('noopener link')));
      await m.click(t, ref(snapshot!, named('window.open')));
      await m.waitFor(t, { ms: 600 });
      const tabs = (await m.tabs()).filter((x) => x.openerTabId === t || x.tabId === t);
      expect(tabs.length).toBe(4);
      const popups = tabs.filter((x) => x.openerTabId === t);
      expect(popups.map((p) => p.url).sort()).toEqual(
        [`${fx.base}/nav1`, `${fx.base}/nav2`, `${fx.base}/nav2`].sort(),
      );
      // Owned by the chat that drove the opener, so they close with it and show in its status.
      expect(m.statusForChat('chat-pop').tabs).toHaveLength(4);
      // And they work like any tab.
      expect((await m.read(popups[0]!.tabId)).title).toBe('fixture');
      await m.closeOwnedByChat('chat-pop');
      expect(m.statusForChat('chat-pop').tabs).toHaveLength(0);
    }, 30_000);

    it('never freezes on a dialog: alert accepted, confirm declined unless armed, prompt answered when armed', async () => {
      const t = await open('/dialogs');
      const { snapshot } = await m.read(t);
      await m.click(t, ref(snapshot!, named('alert')));
      await m.waitFor(t, { text: 'after alert' });
      await m.click(t, ref(snapshot!, named('confirm')));
      await m.waitFor(t, { text: 'confirm=false' });

      m.dialog(t, { accept: true });
      await m.click(t, ref(snapshot!, named('confirm')));
      await m.waitFor(t, { text: 'confirm=true' });

      m.dialog(t, { accept: true, promptText: 'Tom' });
      await m.click(t, ref(snapshot!, named('prompt')));
      await m.waitFor(t, { text: 'prompt=Tom' });

      // The armed answer was one-shot: the next confirm is declined again.
      await m.click(t, ref(snapshot!, named('confirm')));
      await m.waitFor(t, { text: 'confirm=false' });

      const { dialogs, armed } = m.dialog(t, {});
      expect(armed).toBe(false);
      expect(dialogs.map((d) => [d.type, d.message, d.handled, d.auto])).toEqual([
        ['alert', 'heads up', 'accepted', true],
        ['confirm', 'really?', 'dismissed', true],
        ['confirm', 'really?', 'accepted', false],
        ['prompt', 'name?', 'accepted', false],
        ['confirm', 'really?', 'dismissed', true],
      ]);
    }, 30_000);

    it('saves a download as a file on the host and lists it', async () => {
      const t = await open('/download');
      const { snapshot } = await m.read(t);
      await m.click(t, ref(snapshot!, named('get the file')));
      // The download starts after the click returns: ask to wait for it.
      const [file] = await m.downloadsOf(t, 10_000);
      expect(file).toMatchObject({ filename: 'report one.txt', state: 'done', bytes: 21 });
      expect(readFileSync(file!.path!, 'utf8')).toBe('downloaded body 12345');
      expect(statSync(file!.path!).isFile()).toBe(true);
      expect(file!.path!.startsWith(root)).toBe(true);
    }, 30_000);

    it('fills a file chooser: through the button that opens it, and one a click already opened', async () => {
      const upload = join(root, 'upload-me.txt');
      writeFileSync(upload, 'hello');
      const t = await open('/chooser');
      const { snapshot } = await m.read(t);
      const pick = ref(snapshot!, named('Pick a file'));
      await m.upload(t, [upload], pick);
      await m.waitFor(t, { text: 'upload-me.txt' });

      const second = join(root, 'second-file.txt');
      writeFileSync(second, 'again');
      await m.click(t, pick);
      await m.waitFor(t, { ms: 200 });
      expect((await m.read(t)).fileChooserOpen).toBe(true);
      await m.upload(t, [second]);
      await m.waitFor(t, { text: 'second-file.txt', timeoutMs: 5000 });
      expect((await m.read(t)).fileChooserOpen).toBeUndefined();
      await expect(m.upload(t, [upload])).rejects.toThrow(/no file chooser is open/);
    }, 30_000);
  });

  describe('interaction', () => {
    it('hovers, scrolls an element into view, and drags one element onto another', async () => {
      const t = await open('/interact');
      // No ref needed for what is not interactive: a selector names it.
      await m.interact(t, { action: 'hover', selector: '#hov' });
      expect(await textOf(m, t, '#hov')).toBe('hovered');

      const far = ref((await m.read(t)).snapshot!, named('Far button'));
      const y0 = (await m.evaluate(t, 'scrollY')).value as number;
      await m.interact(t, { action: 'scroll_to', ref: far });
      expect(((await m.evaluate(t, 'scrollY')).value as number) > y0 + 500).toBe(true);

      await m.evaluate(t, 'window.scrollTo(0, 0)');
      await m.interact(t, { action: 'drag', selector: '#drag', toSelector: '#zone' });
      expect(await textOf(m, t, '#zone')).toBe('dropped');
      await expect(m.interact(t, { action: 'hover', selector: '#nope' })).rejects.toThrow(
        /no element matches/,
      );
      await expect(m.interact(t, { action: 'hover' })).rejects.toThrow(/ref .* or a selector/);
    }, 30_000);

    it('presses keys on a ref, selects text, and uses the clipboard', async () => {
      const t = await open('/interact');
      const { snapshot } = await m.read(t);
      await m.interact(t, {
        action: 'press',
        ref: ref(snapshot!, named('Keys')),
        keys: ['a', 'Enter', 'Tab'],
      });
      expect(await textOf(m, t, '#kout')).toBe('a;Enter;Tab;');

      // Text in a paragraph: selected by selector, and the page sees the selection.
      await m.interact(t, { action: 'select_text', selector: '#para', text: 'beta' });
      await m.waitFor(t, { text: 'beta' });
      expect(await textOf(m, t, '#sel')).toBe('beta');

      const src = ref(snapshot!, named('Source'));
      await m.interact(t, { action: 'select_text', ref: src, text: 'me please' });
      expect(
        (
          await m.evaluate(
            t,
            `document.getElementById('src').value.substring(document.getElementById('src').selectionStart, document.getElementById('src').selectionEnd)`,
          )
        ).value,
      ).toBe('me please');
      await m.interact(t, { action: 'select_text', ref: src });
      await m.interact(t, { action: 'copy' });
      await m.evaluate(t, `document.getElementById('dst').focus()`);
      await m.interact(t, { action: 'paste' });
      expect((await m.evaluate(t, `document.getElementById('dst').value`)).value).toBe(
        'copy me please',
      );

      await m.interact(t, { action: 'clipboard_write', text: 'from the agent' });
      expect((await m.interact(t, { action: 'clipboard_read' })).text).toBe('from the agent');
      await expect(
        m.interact(t, { action: 'select_text', ref: src, text: 'not in there' }),
      ).rejects.toThrow(/not in that element/);
    }, 30_000);
  });

  describe('state', () => {
    it('sets a saved sign-in (cookie + localStorage) so a page sees it, reads it back, and clears it', async () => {
      const t = await open('/account');
      expect(await textOf(m, t, '[role=status]')).toBe('signed out');

      const summary = await m.stateSet(t, {
        cookies: [{ name: 'cs', value: 'tok123', url: fx.base }],
        origins: [{ origin: fx.base, localStorage: [{ name: 'token', value: 'ls-secret' }] }],
      });
      expect(summary).toEqual({ cookies: 1, origins: 1, localStorageKeys: 1 });
      await m.navigate(t, 'reload');
      expect(await textOf(m, t, '[role=status]')).toBe('Signed in as cadence');

      await m.navigate(t, 'goto', `${fx.base}/state`);
      expect(await textOf(m, t, '#ls')).toBe('ls-secret');
      expect(await textOf(m, t, '#cookies')).toContain('cs=tok123');

      const got = await m.stateGet(t, 'localhost');
      expect(got.cookies.map((c) => [c['name'], c['value']])).toContainEqual(['cs', 'tok123']);
      expect(got.origins.find((o) => o.origin === fx.base)?.localStorage).toContainEqual({
        name: 'token',
        value: 'ls-secret',
      });
      expect((await m.stateGet(t, 'nowhere.example')).cookies).toEqual([]);

      // localStorage for the page's own origin, set directly.
      await m.stateSet(t, { localStorage: { extra: 'v' } });
      expect((await m.evaluate(t, `localStorage.getItem('extra')`)).value).toBe('v');

      await m.stateClear(t, { cookies: true, localStorage: true });
      await m.navigate(t, 'goto', `${fx.base}/account`);
      expect(await textOf(m, t, '[role=status]')).toBe('signed out');
      expect((await m.evaluate(t, `localStorage.length`)).value).toBe(0);
    }, 30_000);

    it('saves state to a file (counts only, mode 600) and loads it into a fresh throwaway profile', async () => {
      const t = await open('/account');
      await m.stateSet(t, { cookies: [{ name: 'cs', value: 'tok123', url: fx.base }] });
      const file = join(root, 'state.json');
      const saved = await m.stateSave(t, file);
      expect(saved).toMatchObject({ path: file, cookies: 1 });
      expect(JSON.stringify(saved)).not.toContain('tok123');
      expect(statSync(file).mode & 0o777).toBe(0o600);
      await m.stateClear(t, { cookies: true });

      const other = (await m.open({ url: `${fx.base}/account`, profile: 'logged-out' })).tabId;
      expect(await textOf(m, other, '[role=status]')).toBe('signed out');
      expect(await m.stateLoad(other, file)).toMatchObject({ cookies: 1 });
      await m.navigate(other, 'reload');
      expect(await textOf(m, other, '[role=status]')).toBe('Signed in as cadence');
      await expect(m.stateLoad(other, join(root, 'missing.json'))).rejects.toThrow(
        /could not read a storage state/,
      );
    }, 30_000);
  });

  describe('debugging', () => {
    it('runs JS in the page (and in an iframe) and returns the value', async () => {
      const t = await open('/rich');
      expect((await m.evaluate(t, 'document.title')).value).toBe('fixture');
      expect((await m.evaluate(t, '() => [1, 2, 3].map((n) => n * 2)')).value).toEqual([2, 4, 6]);
      expect((await m.evaluate(t, 'Promise.resolve({ ok: true })')).value).toEqual({ ok: true });
      expect(
        (
          await m.evaluate(t, `document.querySelector('button').textContent`, {
            frameUrl: '/frame',
          })
        ).value,
      ).toBe('Frame button');
      expect((await m.evaluate(t, `'x'.repeat(500)`, { maxChars: 100 })).truncated).toBe(true);
      await expect(m.evaluate(t, 'nosuchthing.x')).rejects.toThrow(/nosuchthing/);
    }, 30_000);

    it('records console messages, page errors and network requests with bodies', async () => {
      const t = await open('/console');
      await m.waitFor(t, { networkIdle: true });
      await m.waitFor(t, { ms: 300 });
      const all = m.consoleMessages(t);
      expect(all.map((e) => [e.type, e.text])).toEqual(
        expect.arrayContaining([
          ['log', 'hello-log'],
          ['error', 'boom-error'],
          ['pageerror', 'uncaught-thing'],
        ]),
      );
      expect(m.consoleMessages(t, { level: 'error' }).some((e) => e.text === 'boom-error')).toBe(
        true,
      );

      const reqs = m.networkRequests(t, { urlContains: '/api/' });
      const data = reqs.find((r) => r.url.endsWith('/api/data'))!;
      expect(data).toMatchObject({ method: 'GET', status: 200, resourceType: 'fetch' });
      expect(reqs.find((r) => r.url.endsWith('/api/missing'))?.status).toBe(404);
      const body = await m.responseBody(t, data.id);
      expect(JSON.parse(body.text!)).toEqual({ x: 1, name: 'fixture' });

      m.consoleMessages(t, { clear: true });
      expect(m.consoleMessages(t)).toEqual([]);
      m.networkRequests(t, { clear: true });
      expect(m.networkRequests(t)).toEqual([]);
      await expect(m.responseBody(t, data.id)).rejects.toThrow(/no response recorded/);
    }, 30_000);

    it('resizes the viewport, emulates a device, and puts everything back', async () => {
      const t = await open('/viewport');
      const normal = await m.setViewport(t, {});
      const resized = await m.setViewport(t, { width: 700, height: 500 });
      expect(resized).toMatchObject({ width: 700, height: 500 });
      expect(await m.viewport(t)).toEqual({ width: 700, height: 500 });

      const phone = await m.setViewport(t, { device: 'Pixel 7' });
      expect(phone.userAgent).toContain('Android');
      expect(phone.userAgent).not.toBe(normal.userAgent);
      expect(phone.devicePixelRatio).toBeGreaterThan(2);
      expect(phone.width).toBeLessThan(500);
      expect((await m.evaluate(t, 'navigator.maxTouchPoints')).value).toBeGreaterThan(0);

      const back = await m.setViewport(t, { reset: true });
      expect(back.userAgent).toBe(normal.userAgent);
      expect(back).toMatchObject({ width: 1280, height: 720, devicePixelRatio: 1 });
      await expect(m.setViewport(t, { device: 'Nokia 3310' })).rejects.toThrow(/unknown device/);
      await expect(m.setViewport(t, { width: 10, height: 10 })).rejects.toThrow(/between/);
    }, 30_000);

    it('stays a normal fingerprint: no webdriver flag, and the UA is untouched unless a device is asked for', async () => {
      const t = await open('/viewport');
      expect((await m.evaluate(t, 'navigator.webdriver')).value).toBe(null);
      expect((await m.evaluate(t, 'navigator.userAgent')).value).not.toMatch(/Headless/);
    }, 30_000);
  });

  describe('per-chat watching and stopping', () => {
    it('reports one chat’s tabs and running action, and tells its surfaces when that changes', async () => {
      activity.length = 0;
      const t = await open('/nav1', 'chat-status');
      expect(activity).toContain('chat-status');
      const idle = m.statusForChat('chat-status');
      expect(idle).toMatchObject({ chatId: 'chat-status', active: false });
      expect(idle.tabs).toEqual([
        {
          tabId: t,
          url: `${fx.base}/nav1`,
          title: '',
          handedOff: false,
          driver: 'agent',
          openedAt: expect.any(Number),
        },
      ]);

      const pending = m.waitFor(t, { text: 'never', timeoutMs: 1500 }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
      const busy = m.statusForChat('chat-status');
      expect(busy).toMatchObject({ active: true, action: 'Waiting' });
      expect(m.statusForChat('someone-else')).toMatchObject({ active: false, tabs: [] });
      await pending;
      expect(m.statusForChat('chat-status').active).toBe(false);
    }, 30_000);

    it('Stop cancels only that chat’s in-flight call and closes only its tabs', async () => {
      const mine = await open('/nav1', 'chat-stop-me');
      const theirs = await open('/nav2', 'chat-keep');
      const outcome = m.waitFor(mine, { text: 'never', timeoutMs: 20_000 }).then(
        () => 'finished',
        (e: unknown) => e,
      );
      await new Promise((r) => setTimeout(r, 150));
      expect(await m.stopChat('chat-stop-me')).toBe(1);
      expect(await outcome).toBeInstanceOf(BrowserStoppedError);
      expect(m.statusForChat('chat-stop-me').tabs).toEqual([]);
      expect(m.statusForChat('chat-stop-me').lastStoppedAt).toBeGreaterThan(0);
      // The other chat's browser is untouched and still works.
      expect((await m.read(theirs)).url).toBe(`${fx.base}/nav2`);
      expect(m.statusForChat('chat-keep').tabs).toHaveLength(1);
      await expect(m.read(mine)).rejects.toBeInstanceOf(TabNotFoundError);
    }, 30_000);
  });
});

describeRealBrowser('agent browser — a crashed tab or a closed browser heals itself', () => {
  let fx: Fixture;
  let root: string;
  let m: BrowserManager;

  beforeAll(async () => {
    fx = await startFixture();
  });
  afterAll(async () => {
    await fx.close();
  });

  function fresh(display: string): BrowserManager {
    root = mkdtempSync(join(tmpdir(), 'patch-browser-heal-'));
    m = new BrowserManager({ root, logger: silent, virtualDisplay: display });
    return m;
  }
  const tabsById = (
    mm: BrowserManager,
  ): Map<string, { page: import('playwright').Page; crashed: boolean; contextDead: boolean }> =>
    (mm as unknown as { tabsById: Map<string, never> }).tabsById;
  async function until(cond: () => boolean, ms = 8000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('condition never became true');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('recovers a tab whose renderer crashed: same tabId, reloaded where it was, and says so once', async () => {
    const mm = fresh(':72');
    try {
      const { tabId } = await mm.open({ url: `${fx.base}/nav2`, chatId: 'c' });
      await mm.navigate(tabId, 'goto', `${fx.base}/nav1`);
      const tab = tabsById(mm).get(tabId)!;
      const cdp = await tab.page.context().newCDPSession(tab.page);
      // The crashed page never answers this, so it is not awaited.
      void cdp.send('Page.crash').catch(() => undefined);
      await until(() => tab.crashed);

      const r = await mm.read(tabId);
      expect(r.url).toBe(`${fx.base}/nav1`);
      expect(r.snapshot!.some((n) => n.name === 'two')).toBe(true);
      expect(r.notices?.[0]).toMatch(/crashed.*reopened/);
      expect((await mm.read(tabId)).notices).toBeUndefined();
      expect((await mm.tabs()).map((t) => t.tabId)).toEqual([tabId]);
    } finally {
      await mm.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);

  it('recovers when the whole browser is killed: relaunches it and reopens every tab', async () => {
    const mm = fresh(':73');
    try {
      const a = (await mm.open({ url: `${fx.base}/nav1` })).tabId;
      const b = (await mm.open({ url: `${fx.base}/nav2` })).tabId;
      const killed = spawnSync('pkill', ['-9', '-f', join(root, 'profile')]);
      expect(killed.status).toBe(0);
      await until(() => [...tabsById(mm).values()].every((t) => t.contextDead));

      // Any action on any tab works again, with nobody doing anything.
      const ra = await mm.read(a);
      expect(ra.url).toBe(`${fx.base}/nav1`);
      expect(ra.notices?.[0]).toMatch(/browser closed/);
      expect((await mm.read(b)).url).toBe(`${fx.base}/nav2`);
      await mm.navigate(a, 'goto', `${fx.base}/nav2`);
      const open = await mm.open({ url: `${fx.base}/nav1` });
      expect(open.url).toBe(`${fx.base}/nav1`);
    } finally {
      await mm.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('recovers a throwaway (logged-out) tab when its browser dies', async () => {
    const mm = fresh(':74');
    try {
      const t = (await mm.open({ url: `${fx.base}/nav1`, profile: 'logged-out' })).tabId;
      const tab = tabsById(mm).get(tabId0(t))!;
      await tab.page.context().browser()!.close();
      await until(() => tab.contextDead);
      const r = await mm.read(t);
      expect(r.url).toBe(`${fx.base}/nav1`);
      expect(r.notices?.[0]).toMatch(/browser closed/);
    } finally {
      await mm.dispose();
      rmSync(root, { recursive: true, force: true });
    }
    function tabId0(id: string): string {
      return id;
    }
  }, 60_000);

  it('does not resurrect a tab the user closed by hand', async () => {
    const mm = fresh(':75');
    try {
      const a = (await mm.open({ url: `${fx.base}/nav1` })).tabId;
      const b = (await mm.open({ url: `${fx.base}/nav2` })).tabId;
      await tabsById(mm).get(a)!.page.close();
      await expect(mm.read(a)).rejects.toBeInstanceOf(TabNotFoundError);
      expect((await mm.tabs()).map((t) => t.tabId)).toEqual([b]);
    } finally {
      await mm.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});
