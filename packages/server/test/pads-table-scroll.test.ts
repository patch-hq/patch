// Pads — a wide table must scroll sideways on a phone, in View and in Edit mode.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';
import { generateUserKeypair } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const cells = (tag: string) =>
  Array.from({ length: 12 }, (_, i) => `<${tag} style="min-width:140px">Col ${i}</${tag}>`).join(
    '',
  );
const table = `<table id="tbl" border="1"><tr>${cells('th')}</tr><tr>${cells('td')}</tr></table>`;
const page = (body: string) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>T</title></head><body style="margin:0;font:16px system-ui">${body}</body></html>`;

describe('pad: wide tables scroll sideways on a phone', () => {
  let dir: string;
  let browser: Browser;
  let built: Awaited<ReturnType<typeof buildAll>>;
  let link: InProcessHostLink;
  let base: string;
  let pw: typeof import('playwright');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-pad-table-'));
    const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    link = new InProcessHostLink();
    built = await buildAll({ logger: false, registry, hostLink: link });
    link.emit({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '/tmp/chat' });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;
    pw = await import('playwright');
    browser = await pw.chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await built?.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let n = 0;
  const newPad = async (html: string): Promise<string> => {
    const requestId = `tbl-${++n}`;
    link.emit({
      type: 'patch.pad.request',
      requestId,
      chatId: 'c1',
      op: 'create',
      name: `Tables ${n}`,
      files: [{ path: 'index.html', base64: Buffer.from(html).toString('base64') }],
    } as WireEvent);
    for (let i = 0; i < 200; i++) {
      const hit = link.sent.find(
        (x) => x.event.type === 'patch.pad.response' && x.event.requestId === requestId,
      );
      const res = hit?.event as Extract<WireEvent, { type: 'patch.pad.response' }> | undefined;
      if (res) return `${base}${(res.result as { frameUrl: string }).frameUrl}`;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no pad created');
  };

  const variants: [string, string][] = [
    ['bare table in the page', page(`<h1>Plan</h1>${table}`)],
    [
      'table in an overflow-x:auto wrapper',
      page(`<h1>Plan</h1><div id="w" style="overflow-x:auto">${table}</div>`),
    ],
    [
      'table in a padded card',
      page(
        `<div style="padding:16px"><div style="border:1px solid #ccc;border-radius:8px;overflow:hidden">${table}</div></div>`,
      ),
    ],
  ];

  for (const mode of ['view', 'edit'] as const) {
    for (const [name, html] of variants) {
      it(`${mode}: ${name} can be swiped sideways`, async () => {
        const frameUrl = await newPad(html);
        const ctx = await browser.newContext({ ...pw.devices['Pixel 7'] });
        const p = await ctx.newPage();
        await p.goto(frameUrl);
        const design = p.frameLocator('#frame');
        await design.locator('#tbl').waitFor();
        if (mode === 'edit') await p.locator('[data-mode="edit"]').click();
        const scrollX = () =>
          design
            .locator('body')
            .evaluate((b) =>
              Math.max(
                b.ownerDocument.scrollingElement!.scrollLeft,
                ...Array.from(b.ownerDocument.querySelectorAll('*')).map((e) => e.scrollLeft),
              ),
            );
        const box = (await design.locator('#tbl').boundingBox())!;
        const y = box.y + box.height / 2;
        const cdp = await ctx.newCDPSession(p);
        await cdp.send('Input.synthesizeScrollGesture', {
          x: 300,
          y,
          xDistance: -200,
          yDistance: 0,
          gestureSourceType: 'touch',
        });
        await expect.poll(scrollX).toBeGreaterThan(50);
        await ctx.close();
      });
    }
  }
});
