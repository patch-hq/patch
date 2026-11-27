// Views — the round trip (spec/14 § Views): the agent's set / patch / read go to
// the API route, the user's marks land in the shared store, Send delivers them
// into the owning chat as a `chat.input`, and refusals are loud.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';
import { applyPatch } from '../src/views/jsonpatch.js';
import { isRelayablePath } from '../src/api-rpc-bridge.js';

const DOC = {
  heading: 'Which names?',
  items: [
    { id: 'a', title: 'Alder', detail: 'a tree' },
    { id: 'b', title: 'Birch' },
  ],
};

describe('json patch', () => {
  it('adds, replaces and removes without touching the original', () => {
    const out = applyPatch(DOC, [
      { op: 'replace', path: '/items/0/title', value: 'Ash' },
      { op: 'add', path: '/items/-', value: { id: 'c', title: 'Cedar' } },
      { op: 'remove', path: '/items/1' },
    ]) as typeof DOC;
    expect(out.items.map((i) => i.title)).toEqual(['Ash', 'Cedar']);
    expect(DOC.items[0]!.title).toBe('Alder');
  });
  it('refuses a missing path and a bad index', () => {
    expect(() => applyPatch(DOC, [{ op: 'replace', path: '/nope', value: 1 }])).toThrow(
      /no such path/,
    );
    expect(() => applyPatch(DOC, [{ op: 'remove', path: '/items/9' }])).toThrow(/out of range/);
    expect(() => applyPatch(DOC, [{ op: 'add', path: '/items/-' }])).toThrow(/needs a value/);
  });
});

describe('views', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-views-'));
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
    const headers = { authorization: `Bearer ${bearer}` };
    const agent = async (body: Record<string, unknown>) =>
      built.app.inject({ method: 'POST', url: '/api/views/agent', headers, payload: body });
    const json = (r: { body: string }) => JSON.parse(r.body);
    return { built, hostLink, headers, agent, json };
  }

  it('relays the agent path through the host API bridge', () => {
    expect(isRelayablePath('/api/views/agent')).toBe(true);
  });

  it('refuses unauthenticated calls', async () => {
    const { built } = await makeApp();
    const r = await built.app.inject({ method: 'GET', url: '/api/views' });
    expect(r.statusCode).toBe(401);
  });

  it('set creates, patch changes in place, read shows marks', async () => {
    const { built, headers, agent, json } = await makeApp();
    const made = await agent({
      chatId: 'c1',
      op: 'set',
      title: 'Names',
      template: 'review-list',
      data: DOC,
    });
    expect(made.statusCode).toBe(200);
    const v = json(made);
    expect(v.rev).toBe(1);

    const m = await built.app.inject({
      method: 'POST',
      url: `/api/views/${v.id}/marks`,
      headers,
      payload: { itemId: 'a', verdict: 'yes', note: 'lovely' },
    });
    expect(json(m).unsent).toBe(1);

    const p = await agent({
      chatId: 'c1',
      op: 'patch',
      viewId: v.id,
      baseRev: 1,
      ops: [{ op: 'add', path: '/items/-', value: { id: 'c', title: 'Cedar' } }],
    });
    expect(json(p).rev).toBe(2);
    expect(json(p).data.items).toHaveLength(3);
    expect(json(p).marks.a.verdict).toBe('yes'); // a patch keeps the user's marks

    const read = json(await agent({ chatId: 'c1', op: 'read', viewId: v.id }));
    expect(read.marks.a.note).toBe('lovely');

    const same = json(
      await built.app.inject({ method: 'GET', url: `/api/views/${v.id}?since=2`, headers }),
    );
    expect(same).toMatchObject({ rev: 2, unchanged: true });
    const changed = json(
      await built.app.inject({ method: 'GET', url: `/api/views/${v.id}?since=1`, headers }),
    );
    expect(changed.data.items).toHaveLength(3);
  });

  it('set again replaces the data and drops marks on items that went', async () => {
    const { built, headers, agent, json } = await makeApp();
    const v = json(
      await agent({ chatId: 'c1', op: 'set', title: 'Names', template: 'review-list', data: DOC }),
    );
    await built.app.inject({
      method: 'POST',
      url: `/api/views/${v.id}/marks`,
      headers,
      payload: { itemId: 'b', verdict: 'no' },
    });
    const again = json(
      await agent({
        chatId: 'c1',
        op: 'set',
        viewId: v.id,
        title: 'Names',
        template: 'review-list',
        data: { items: [{ id: 'a', title: 'Alder' }] },
      }),
    );
    expect(again.rev).toBe(2);
    expect(again.marks).toEqual({});
  });

  it('refuses loudly: stale rev, bad patch, bad data, another chat, unknown item', async () => {
    const { built, headers, agent, json } = await makeApp();
    const v = json(
      await agent({ chatId: 'c1', op: 'set', title: 'Names', template: 'review-list', data: DOC }),
    );
    const stale = await agent({
      chatId: 'c1',
      op: 'patch',
      viewId: v.id,
      baseRev: 5,
      ops: [{ op: 'remove', path: '/items/0' }],
    });
    expect(stale.statusCode).toBe(409);
    const bad = await agent({
      chatId: 'c1',
      op: 'patch',
      viewId: v.id,
      ops: [{ op: 'remove', path: '/items/7' }],
    });
    expect(bad.statusCode).toBe(400);
    const dup = await agent({
      chatId: 'c1',
      op: 'patch',
      viewId: v.id,
      ops: [{ op: 'add', path: '/items/-', value: { id: 'a', title: 'Again' } }],
    });
    expect(dup.statusCode).toBe(400);
    expect(json(await agent({ chatId: 'c1', op: 'read', viewId: v.id })).rev).toBe(1); // nothing changed
    const other = await agent({
      chatId: 'c2',
      op: 'patch',
      viewId: v.id,
      ops: [{ op: 'remove', path: '/items/0' }],
    });
    expect(other.statusCode).toBe(400);
    const nonsense = await agent({
      chatId: 'c1',
      op: 'set',
      title: 'x',
      template: 'review-list',
      data: { items: [{ id: 1 }] },
    });
    expect(nonsense.statusCode).toBe(400);
    const unknown = await built.app.inject({
      method: 'POST',
      url: `/api/views/${v.id}/marks`,
      headers,
      payload: { itemId: 'zzz', verdict: 'yes' },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('send delivers the changed marks to the chat once, and nothing when none changed', async () => {
    const { built, hostLink, headers, agent, json } = await makeApp();
    const v = json(
      await agent({ chatId: 'c1', op: 'set', title: 'Names', template: 'review-list', data: DOC }),
    );
    const empty = await built.app.inject({
      method: 'POST',
      url: `/api/views/${v.id}/send`,
      headers,
    });
    expect(empty.statusCode).toBe(409);

    await built.app.inject({
      method: 'POST',
      url: `/api/views/${v.id}/marks`,
      headers,
      payload: { itemId: 'a', verdict: 'yes' },
    });
    await built.app.inject({
      method: 'POST',
      url: `/api/views/${v.id}/marks`,
      headers,
      payload: { itemId: 'b', note: 'too plain' },
    });
    const sent = await built.app.inject({
      method: 'POST',
      url: `/api/views/${v.id}/send`,
      headers,
    });
    expect(json(sent).sent).toBe(2);
    const inputs = hostLink.sent.filter((s) => s.event.type === 'chat.input');
    expect(inputs).toHaveLength(1);
    const ev = inputs[0]!.event as Extract<WireEvent, { type: 'chat.input' }>;
    expect(ev.chatId).toBe('c1');
    expect(ev.source).toEqual({ kind: 'view', viewId: v.id });
    expect(ev.message).toContain('a "Alder": yes');
    expect(ev.message).toContain('b "Birch": no verdict — note: too plain');

    const again = await built.app.inject({
      method: 'POST',
      url: `/api/views/${v.id}/send`,
      headers,
    });
    expect(again.statusCode).toBe(409); // already sent
    const read = json(await agent({ chatId: 'c1', op: 'read', viewId: v.id }));
    expect(read.marks.a.verdict).toBe('yes'); // sent marks stay on the screen
    expect(read.unsent).toBe(0);
  });

  it('lists views without their document', async () => {
    const first = await makeApp();
    const v = first.json(
      await first.agent({
        chatId: 'c1',
        op: 'set',
        title: 'Names',
        template: 'review-list',
        data: DOC,
      }),
    );
    await first.built.app.inject({
      method: 'POST',
      url: `/api/views/${v.id}/marks`,
      headers: first.headers,
      payload: { itemId: 'a', verdict: 'no' },
    });
    const listed = first.json(
      await first.built.app.inject({
        method: 'GET',
        url: '/api/views?chatId=c1',
        headers: first.headers,
      }),
    );
    expect(listed.views).toHaveLength(1);
    expect(listed.views[0]).toMatchObject({ id: v.id, items: 2, unsent: 1 });
    expect(listed.views[0].data).toBeUndefined();
  });
});
