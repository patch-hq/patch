// The sign-in page, driven in a real headless browser against a real listening server.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

describe('artifact sign-in page (browser)', () => {
  it('shows a way in when signed out, and opens the artifact when signed in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-signin-'));
    const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    const hostLink = new InProcessHostLink();
    const built = await buildAll({ logger: false, registry, hostLink });
    hostLink.emit({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '/tmp/chat' });
    hostLink.emit({
      type: 'patch.artifact.publish_request',
      requestId: 'r1',
      chatId: 'c1',
      artifactId: 'a1',
      title: 'Hello',
      path: 'out/report.html',
      html: '<!doctype html><html><body><p id="hi">hello artifact</p></body></html>',
    });
    for (let i = 0; i < 200 && hostLink.sent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(hostLink.sent.length).toBeGreaterThan(0);
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;
    const browser = await chromium.launch();
    try {
      const url = `${base}/api/chats/c1/artifact/a1`;
      const anon = await browser.newPage();
      await anon.goto(url);
      expect(await anon.locator('h1').innerText()).toBe('Sign in to Patch');
      expect(await anon.locator('#open').getAttribute('href')).toBe('/');

      const jwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-test',
        surfaceKind: 'web',
        label: 'test',
      });
      const ctx = await browser.newContext();
      await ctx.addInitScript((j) => localStorage.setItem('patch.credential.v1', j), jwt);
      const signed = await ctx.newPage();
      await signed.goto(url);
      await signed.waitForURL(/exp=\d+&sig=/);
      expect(await signed.locator('#hi').innerText()).toBe('hello artifact');

      const bad = await browser.newContext();
      await bad.addInitScript(() => localStorage.setItem('patch.credential.v1', 'a.b.c'));
      const failed = await bad.newPage();
      await failed.goto(url);
      await failed.getByText('Could not sign you in').waitFor();
    } finally {
      await browser.close();
      await built.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
