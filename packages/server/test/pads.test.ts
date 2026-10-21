// Pads — the real round trip (spec/14 § Pads): an agent's patch.pad.request
// creates a Pad over the host link → the editor and the design's files are
// served from the signed URL → the user's changes land in the shared store → Send
// draws a real picture of each change in a real browser and delivers the batch
// into the owning chat as a `chat.input` → the agent's reply closes it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const PAGE = `<!doctype html><html><head><title>Home</title></head><body style="margin:0">
<h1 id="t" style="margin:40px">Credit</h1><button id="b" style="margin:40px">Go</button></body></html>`;
const b64 = (s: string): string => Buffer.from(s).toString('base64');
const SEL = { selector: 'html > body > h1:nth-of-type(1)', label: 'h1 "Credit"' };

type Res = Extract<WireEvent, { type: 'patch.pad.response' }>;
let n = 0;

describe('pads', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-pads-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function makeApp() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const hostLink = new InProcessHostLink();
    const built = await buildAll({ logger: false, registry, hostLink });
    hostLink.emit({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '/tmp/chat' });
    hostLink.emit({ type: 'chat.spawned', hostId: 'd1', chatId: 'c2', folder: '/tmp/chat2' });
    const bearer = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-test',
      surfaceKind: 'web',
      label: 'test',
    });
    const auth = { authorization: `Bearer ${bearer}` };
    const ask = async (chatId: string, req: Record<string, unknown>): Promise<Res> => {
      const requestId = `r${++n}`;
      hostLink.emit({ type: 'patch.pad.request', requestId, chatId, ...req } as WireEvent);
      for (let i = 0; i < 300; i++) {
        const hit = hostLink.sent.find(
          (s) => s.event.type === 'patch.pad.response' && s.event.requestId === requestId,
        );
        if (hit) {
          expect(hit.hostId).toBe('d1'); // the reply goes back to the asking machine
          return hit.event as Res;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('no patch.pad.response');
    };
    const create = async (chatId = 'c1') => {
      const res = await ask(chatId, {
        op: 'create',
        name: 'Care screens',
        app: 'Dog Log',
        device: 'phone',
        files: [
          { path: 'index.html', base64: b64(PAGE) },
          { path: 'other.html', base64: b64(PAGE.replace('Home', 'Other')) },
        ],
      });
      expect(res.ok, JSON.stringify(res.error)).toBe(true);
      return res.result as {
        id: string;
        frameUrl: string;
        screens: { id: string; name: string }[];
      };
    };
    return { built, hostLink, auth, ask, create };
  }

  it('an agent creates a Pad; the editor, files and API are served from its signed URL', async () => {
    const { built, create } = await makeApp();
    try {
      const pad = await create();
      expect(pad.screens.map((s) => s.name)).toEqual(['Home', 'Other']);
      const editor = await built.app.inject({ method: 'GET', url: pad.frameUrl });
      expect(editor.statusCode).toBe(200);
      expect(editor.body).toContain('id="frame"');
      const js = await built.app.inject({ method: 'GET', url: `${pad.frameUrl}editor.js` });
      expect(js.statusCode).toBe(200);
      expect(js.body).toContain('pad-tooltip');
      const file = await built.app.inject({ method: 'GET', url: `${pad.frameUrl}f/index.html` });
      expect(file.body).toContain('Credit');
      const state = await built.app.inject({ method: 'GET', url: `${pad.frameUrl}api` });
      expect(state.json()).toMatchObject({
        design: { id: pad.id, name: 'Care screens' },
        changes: [],
        device: 'phone',
      });
      // A wrong signature, and a path outside the pad, are refused.
      const bad = await built.app.inject({
        method: 'GET',
        url: pad.frameUrl.replace(/[0-9a-f]\/$/, (m) => (m[0] === '0' ? '1/' : '0/')),
      });
      expect(bad.statusCode).toBe(401);
      const esc = await built.app.inject({
        method: 'GET',
        url: `${pad.frameUrl}f/..%2f..%2fpad.json`,
      });
      expect(esc.statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      await built.app.close();
    }
  });

  it('answers a signature of multi-byte characters with 401, not a 500', async () => {
    const { built, create } = await makeApp();
    try {
      const pad = await create();
      // 64 characters, 128 bytes: the length of a signature only by counting characters.
      const forged = pad.frameUrl.replace(/[0-9a-f]{64}/, encodeURIComponent('é'.repeat(64)));
      expect((await built.app.inject({ method: 'GET', url: forged })).statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('serves a pad file whose name holds a percent sign', async () => {
    const { built, ask } = await makeApp();
    try {
      const res = await ask('c1', {
        op: 'create',
        name: 'Odd names',
        app: 'Dog Log',
        device: 'phone',
        files: [
          { path: 'index.html', base64: b64(PAGE) },
          { path: 'pic%.txt', base64: b64('hello') },
        ],
      });
      expect(res.ok, JSON.stringify(res.error)).toBe(true);
      const { frameUrl } = res.result as { frameUrl: string };
      const file = await built.app.inject({ method: 'GET', url: `${frameUrl}f/pic%25.txt` });
      expect(file.statusCode).toBe(200);
      expect(file.body).toBe('hello');
    } finally {
      await built.app.close();
    }
  });

  it('a Pad can take two library screens that share a name, as captures can', async () => {
    const { built, auth } = await makeApp();
    try {
      const src = (
        await built.app.inject({
          method: 'POST',
          url: '/api/pads',
          headers: auth,
          payload: {
            name: 'Source',
            app: 'Patch',
            chatId: 'c1',
            screens: [{ name: 'Chat', html: PAGE }],
          },
        })
      ).json();
      const from = await built.app.inject({
        method: 'POST',
        url: '/api/pads',
        headers: auth,
        payload: {
          name: 'Twice',
          app: 'Patch',
          chatId: 'c1',
          from: [
            { padId: src.id, screenId: 'chat' },
            { padId: src.id, screenId: 'chat' },
          ],
        },
      });
      expect(from.statusCode, from.body).toBe(200);
      const ids = from.json().screens.map((s: { id: string }) => s.id);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    } finally {
      await built.app.close();
    }
  });

  it('changes are shared and fold; Send draws pictures and delivers into the owning chat; the reply closes the batch', async () => {
    const { built, hostLink, create, ask } = await makeApp();
    try {
      const pad = await create();
      const api = `${pad.frameUrl}api`;
      const post = (url: string, payload: unknown) =>
        built.app.inject({ method: 'POST', url, payload: payload as object });
      expect(
        (await post(`${api}/changes`, { screen: 'index', kind: 'move', target: SEL, dx: 5, dy: 0 }))
          .statusCode,
      ).toBe(200);
      const moved = await post(`${api}/changes`, {
        screen: 'index',
        kind: 'move',
        target: SEL,
        dx: 30,
        dy: 12,
      });
      const note = await post(`${api}/changes`, {
        screen: 'other',
        kind: 'note',
        target: SEL,
        text: 'Make it bigger',
        offset: { x: 10, y: 10 },
      });
      expect(note.statusCode).toBe(200);
      const unknown = await post(`${api}/changes`, { screen: 'nope', kind: 'delete', target: SEL });
      expect(unknown.statusCode).toBe(400);
      let state = (await built.app.inject({ method: 'GET', url: api })).json();
      expect(state.changes).toHaveLength(2); // the two moves folded
      expect(moved.json()).toMatchObject({ dx: 30, dy: 12 });

      const sent = await built.app.inject({
        method: 'POST',
        url: `${api}/send`,
        headers: { host: 'patch.test', 'x-forwarded-proto': 'https' },
      });
      expect(sent.statusCode, sent.body).toBe(200);
      const input = hostLink.sent.find((s) => s.event.type === 'chat.input')!.event as Extract<
        WireEvent,
        { type: 'chat.input' }
      >;
      expect(input.chatId).toBe('c1');
      expect(input.source).toEqual({ kind: 'pad', padId: expect.any(String) });
      expect(input.message).toContain('[Pad] Tom sent 2 changes on "Care screens"');
      expect(input.message).toContain('Moved h1 "Credit" 30px right, 12px down');
      expect(input.message).toContain('Note on h1 "Credit": "Make it bigger"');
      const pic = /picture: https:\/\/patch\.test(\S+\.png)/.exec(input.message);
      expect(pic).not.toBeNull();
      const png = await built.app.inject({ method: 'GET', url: pic![1]! });
      expect(png.statusCode).toBe(200);
      expect(png.headers['content-type']).toBe('image/png');
      expect(png.rawPayload.subarray(1, 4).toString()).toBe('PNG');

      state = (await built.app.inject({ method: 'GET', url: api })).json();
      expect(state.changes.every((c: { status: string }) => c.status === 'sent')).toBe(true);
      const listed = await ask('c1', { op: 'list' });
      expect((listed.result as { pads: { working: boolean }[] }).pads[0]!.working).toBe(true);

      const replied = await ask('c1', {
        op: 'reply',
        padId: pad.id,
        text: 'Moved it and enlarged',
      });
      expect(replied.ok).toBe(true);
      state = (await built.app.inject({ method: 'GET', url: api })).json();
      expect(state.batches[0]).toMatchObject({ status: 'done', reply: 'Moved it and enlarged' });
      expect(state.changes.every((c: { status: string }) => c.status === 'done')).toBe(true);
    } finally {
      await built.app.close();
    }
  }, 60_000);

  it('Send with nothing pending is refused, and a second Send while one is running is refused', async () => {
    const { built, create } = await makeApp();
    try {
      const pad = await create();
      const api = `${pad.frameUrl}api`;
      const empty = await built.app.inject({ method: 'POST', url: `${api}/send` });
      expect(empty.statusCode).toBe(400);
      expect(empty.json().error).toMatch(/nothing to send/);
      await built.app.inject({
        method: 'POST',
        url: `${api}/changes`,
        payload: { screen: 'index', kind: 'delete', target: SEL },
      });
      const [a, b] = await Promise.all([
        built.app.inject({ method: 'POST', url: `${api}/send` }),
        built.app.inject({ method: 'POST', url: `${api}/send` }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    } finally {
      await built.app.close();
    }
  }, 60_000);

  it('collect is Send by the agent: nothing pending sends nothing; pending changes arrive as the same [Pad] message', async () => {
    const { built, hostLink, create, ask } = await makeApp();
    try {
      const pad = await create();
      const api = `${pad.frameUrl}api`;
      const inputs = () => hostLink.sent.filter((s) => s.event.type === 'chat.input');

      const empty = await ask('c1', { op: 'collect', padId: pad.id });
      expect(empty.ok, JSON.stringify(empty.error)).toBe(true);
      expect(empty.result).toMatchObject({ id: pad.id, collected: 0 });
      expect((empty.result as { message: string }).message).toMatch(/no pending changes/);
      expect(inputs()).toHaveLength(0);

      await built.app.inject({
        method: 'POST',
        url: `${api}/changes`,
        payload: { screen: 'index', kind: 'delete', target: SEL },
      });
      const foreign = await ask('c2', { op: 'collect', padId: pad.id });
      expect(foreign.ok).toBe(false);
      expect(foreign.error?.message).toMatch(/belongs to another chat/);

      vi.stubEnv('PATCH_PUBLIC_URL', '');
      vi.stubEnv('PATCH_SERVER_URL', '');
      const noUrl = await ask('c1', { op: 'collect', padId: pad.id });
      expect(noUrl.ok).toBe(false);
      expect(noUrl.error?.message).toMatch(/no public URL configured/);
      expect(inputs()).toHaveLength(0);

      vi.stubEnv('PATCH_PUBLIC_URL', 'https://patch.test/');
      const first = await ask('c1', { op: 'collect', padId: pad.id });
      expect(first.ok, JSON.stringify(first.error)).toBe(true);
      expect(first.result).toMatchObject({ collected: 1, pending: 0, working: true });
      expect((first.result as { message: string }).message).not.toMatch(/earlier batch/);
      const input = inputs()[0]!.event as Extract<WireEvent, { type: 'chat.input' }>;
      expect(input.chatId).toBe('c1');
      expect(input.message).toContain('[Pad] Tom sent 1 change on "Care screens"');
      expect(input.message).toContain('Deleted h1 "Credit"');
      const pic = /picture: https:\/\/patch\.test(\/\S+\.png)/.exec(input.message);
      expect(pic).not.toBeNull();
      expect((await built.app.inject({ method: 'GET', url: pic![1]! })).statusCode).toBe(200);

      // A batch still waiting on a reply stays open; the next queues behind it.
      await built.app.inject({
        method: 'POST',
        url: `${api}/changes`,
        payload: { screen: 'other', kind: 'delete', target: SEL },
      });
      const second = await ask('c1', { op: 'collect', padId: pad.id });
      expect(second.ok, JSON.stringify(second.error)).toBe(true);
      expect(second.result).toMatchObject({ collected: 1 });
      expect((second.result as { message: string }).message).toMatch(
        /1 earlier batch was already waiting on a reply/,
      );
      expect(inputs()).toHaveLength(2);
      await ask('c1', { op: 'reply', padId: pad.id, text: 'Removed the heading' });
      const state = (await built.app.inject({ method: 'GET', url: api })).json();
      expect(state.batches.map((b: { status: string }) => b.status)).toEqual(['done', 'sent']);
    } finally {
      vi.unstubAllEnvs();
      await built.app.close();
    }
  }, 60_000);

  it('only the owning chat can update or reply; update replaces the files and reports new screens', async () => {
    const { built, ask, create } = await makeApp();
    try {
      const pad = await create();
      const files = [
        { path: 'index.html', base64: b64(PAGE) },
        { path: 'other.html', base64: b64(PAGE) },
        { path: 'third.html', base64: b64(PAGE.replace('Home', 'Third')) },
      ];
      const foreign = await ask('c2', { op: 'update', padId: pad.id, files });
      expect(foreign.ok).toBe(false);
      expect(foreign.error?.message).toMatch(/belongs to another chat/);
      const mine = await ask('c1', { op: 'update', padId: pad.id, files });
      expect(mine.ok).toBe(true);
      expect((mine.result as { addedScreens: string[] }).addedScreens).toEqual(['Third']);
      const missing = await ask('c1', { op: 'update', padId: 'nope', files });
      expect(missing.ok).toBe(false);
      expect(missing.error?.code).toBe('not_found');
      expect(missing.error?.message).toMatch(/create one first with patch_pad_create/);
      const noBatch = await ask('c1', { op: 'reply', padId: pad.id, text: 'hi' });
      expect(noBatch.ok).toBe(false);
      expect(noBatch.error?.message).toMatch(/no open batch for this pad/);
      const bad = await ask('c1', {
        op: 'create',
        name: 'Empty',
        files: [{ path: 'notes.txt', base64: b64('x') }],
      });
      expect(bad.ok).toBe(false);
      expect(bad.error?.message).toMatch(/no .html files/);
    } finally {
      await built.app.close();
    }
  });

  it("an update naming a bad path is refused before it removes the Pad's existing files", async () => {
    const { built, ask, create } = await makeApp();
    try {
      const pad = await create();
      const res = await ask('c1', {
        op: 'update',
        padId: pad.id,
        files: [
          { path: 'index.html', base64: b64(PAGE.replace('Credit', 'Changed')) },
          { path: '../escape.html', base64: b64(PAGE) },
        ],
      });
      expect(res.ok).toBe(false);
      const file = await built.app.inject({ method: 'GET', url: `${pad.frameUrl}f/index.html` });
      expect(file.statusCode).toBe(200);
      expect(file.body).toContain('Credit');
    } finally {
      await built.app.close();
    }
  });

  it("Patch's own UI (bearer) lists, creates from captured screens, offers them as a library, renames and deletes", async () => {
    const { built, auth, create } = await makeApp();
    try {
      expect((await built.app.inject({ method: 'GET', url: '/api/pads' })).statusCode).toBe(401);
      const made = await built.app.inject({
        method: 'POST',
        url: '/api/pads',
        headers: auth,
        payload: {
          name: 'Chat header',
          app: 'Patch',
          device: 'desktop',
          chatId: 'c1',
          screens: [{ name: 'Chat', html: PAGE, width: 1400 }],
        },
      });
      expect(made.statusCode, made.body).toBe(200);
      const pad = made.json();
      expect(pad).toMatchObject({ name: 'Chat header', app: 'Patch', working: false, pending: 0 });
      expect(pad.screens.map((s: { name: string }) => s.name)).toEqual(['Chat']);
      expect(pad.screens[0].width).toBe(1400); // a captured screen keeps the width it was photographed at

      const noChat = await built.app.inject({
        method: 'POST',
        url: '/api/pads',
        headers: auth,
        payload: { name: 'x', chatId: 'ghost' },
      });
      expect(noChat.statusCode).toBe(400);

      // Blank starts with one empty screen.
      const blank = await built.app.inject({
        method: 'POST',
        url: '/api/pads',
        headers: auth,
        payload: { name: 'Scratch', chatId: 'c2' },
      });
      expect(blank.json().screens).toHaveLength(1);

      // The library offers the captured screens, and a new pad can start from one.
      const lib = (
        await built.app.inject({ method: 'GET', url: '/api/pads/library', headers: auth })
      ).json();
      expect(lib.apps).toEqual([
        { app: 'Patch', screens: [expect.objectContaining({ padId: pad.id, name: 'Chat' })] },
      ]);
      const from = await built.app.inject({
        method: 'POST',
        url: '/api/pads',
        headers: auth,
        payload: {
          name: 'Derived',
          app: 'Patch',
          chatId: 'c1',
          from: [{ padId: pad.id, screenId: 'chat' }],
        },
      });
      expect(from.statusCode, from.body).toBe(200);
      const derivedFile = await built.app.inject({
        method: 'GET',
        url: `${from.json().frameUrl}f/lib-${pad.id}/cap-chat.html`,
      });
      expect(derivedFile.body).toContain('Credit');

      // Adding a captured screen to an existing pad.
      const added = await built.app.inject({
        method: 'POST',
        url: `/api/pads/${pad.id}/screens`,
        headers: auth,
        payload: { screens: [{ name: 'Chat', html: PAGE }] },
      });
      expect(added.json().screens.map((s: { name: string }) => s.name)).toEqual(['Chat', 'Chat']);
      expect(added.json().screens[1].id).not.toBe(added.json().screens[0].id);

      const renamed = await built.app.inject({
        method: 'PATCH',
        url: `/api/pads/${pad.id}`,
        headers: auth,
        payload: { name: 'Header v2', device: 'phone' },
      });
      expect(renamed.json()).toMatchObject({ name: 'Header v2', device: 'phone' });

      expect(
        (await built.app.inject({ method: 'DELETE', url: `/api/pads/${pad.id}`, headers: auth }))
          .statusCode,
      ).toBe(204);
      expect(
        (await built.app.inject({ method: 'GET', url: `/api/pads/${pad.id}`, headers: auth }))
          .statusCode,
      ).toBe(404);
      void create;
    } finally {
      await built.app.close();
    }
  });

  it('refuses malformed captured screens with a 400, writing none of them', async () => {
    const { built, auth } = await makeApp();
    try {
      const made = await built.app.inject({
        method: 'POST',
        url: '/api/pads',
        headers: auth,
        payload: { name: 'Shapes', chatId: 'c1', screens: [{ name: 'Chat', html: PAGE }] },
      });
      expect(made.statusCode, made.body).toBe(200);
      const pad = made.json();
      const captures = (): string[] =>
        readdirSync(dir, { recursive: true })
          .map(String)
          .filter((f) => /cap-[^/]*\.html$/.test(f));
      const before = captures();

      for (const screens of [
        [null],
        [{ name: 5, html: PAGE }],
        [{ name: 'Good', html: PAGE }, { name: 'Bad' }],
        5,
        { name: 'Chat', html: PAGE },
      ]) {
        const res = await built.app.inject({
          method: 'POST',
          url: `/api/pads/${pad.id}/screens`,
          headers: auth,
          payload: { screens },
        });
        expect(res.statusCode, JSON.stringify(screens)).toBe(400);
        expect(res.json().error).toBe('each screen needs a name and html');
      }
      // Not even the good screen that came before the bad one reached disk.
      expect(captures()).toEqual(before);
      const after = await built.app.inject({
        method: 'GET',
        url: `/api/pads/${pad.id}`,
        headers: auth,
      });
      expect(after.json().screens).toHaveLength(1);

      const create = await built.app.inject({
        method: 'POST',
        url: '/api/pads',
        headers: auth,
        payload: { name: 'Broken', chatId: 'c1', screens: [null] },
      });
      expect(create.statusCode).toBe(400);
      expect(create.json().error).toBe('each screen needs a name and html');
    } finally {
      await built.app.close();
    }
  });

  it('draws card thumbnails for every screen in the background', async () => {
    const { built, auth } = await makeApp();
    try {
      const made = await built.app.inject({
        method: 'POST',
        url: '/api/pads',
        headers: auth,
        payload: { name: 'Thumb', chatId: 'c1', screens: [{ name: 'A', html: PAGE }] },
      });
      const id = made.json().id;
      let thumb: string | null = null;
      for (let i = 0; i < 100 && !thumb; i++) {
        await new Promise((r) => setTimeout(r, 150));
        thumb = (
          await built.app.inject({ method: 'GET', url: `/api/pads/${id}`, headers: auth })
        ).json().thumbUrl;
      }
      expect(thumb).toMatch(/\/thumb\/a\.png/);
      const png = await built.app.inject({ method: 'GET', url: thumb! });
      expect(png.statusCode).toBe(200);
      expect(png.headers['content-type']).toBe('image/png');
    } finally {
      await built.app.close();
    }
  }, 30_000);
});
