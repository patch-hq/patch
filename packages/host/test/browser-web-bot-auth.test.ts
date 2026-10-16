// Web Bot Auth on Patch's own browsers: a REAL Chromium opens pages on a local
// server that records the request headers it receives, and every request —
// navigation and sub-resource, logged-in and logged-out profile — must arrive
// signed, with a signature that verifies against the published public key.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { parseWebBotAuthKey } from '@patch/wire/web-bot-auth';
import { BrowserManager } from '../src/browser.js';
import { describeRealBrowser } from './helpers/realBrowser.js';
import { webBotAuthFromServer } from '../src/webBotAuth.js';
import { signRequestHeaders } from '@patch/wire/web-bot-auth';

const silent = pino({ level: 'silent' });
const DIR = 'https://patch.example/.well-known/http-message-signatures-directory';
const der = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'der' })
  .toString('base64');
const key = parseWebBotAuthKey(der);

describe('webBotAuthFromServer', () => {
  it('derives this deployment directory without receiving its private key', async () => {
    const seen: string[] = [];
    const config = webBotAuthFromServer(
      'https://patch.example/some/path',
      async (url, directory) => {
        seen.push(url, directory);
        return signRequestHeaders(url, key, directory);
      },
    );
    expect(config.directoryUrl).toBe(DIR);
    expect(await config.sign('https://shop.example/item')).toMatchObject({
      'Signature-Agent': `"${DIR}"`,
    });
    expect(seen).toEqual(['https://shop.example/item', DIR]);
  });
});

describeRealBrowser('BrowserManager — Web Bot Auth, real Chromium', () => {
  let server: Server | undefined;
  let manager: BrowserManager | undefined;
  let root: string | undefined;
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];

  afterEach(async () => {
    await manager?.dispose();
    manager = undefined;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    seen.length = 0;
  });

  async function start(webBotAuth: boolean, display: string): Promise<string> {
    server = createServer((req, res) => {
      seen.push({ path: req.url ?? '', headers: req.headers });
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><body><h1>hi</h1><img src="/pixel.png"></body>');
      } else {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from('iVBORw0KGgo=', 'base64'));
      }
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    root = mkdtempSync(join(tmpdir(), 'patch-wba-'));
    manager = new BrowserManager({
      root,
      logger: silent,
      virtualDisplay: display,
      ...(webBotAuth
        ? {
            webBotAuth: {
              directoryUrl: DIR,
              sign: async (url: string) => signRequestHeaders(url, key, DIR),
            },
          }
        : {}),
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function assertSigned(h: IncomingHttpHeaders, authority: string): void {
    expect(h['signature-agent']).toBe(`"${DIR}"`);
    const input = String(h['signature-input']);
    const params = input.replace(/^sig1=/, '');
    expect(params).toContain('("@authority" "signature-agent")');
    expect(params).toContain('tag="web-bot-auth"');
    expect(params).toContain(`keyid="${key.keyId}"`);
    const base = `"@authority": ${authority}\n"signature-agent": "${DIR}"\n"@signature-params": ${params}`;
    const sig = Buffer.from(/^sig1=:(.+):$/.exec(String(h['signature']))![1]!, 'base64');
    const pub = createPublicKey({ key: { ...key.jwk }, format: 'jwk' });
    expect(verify(null, Buffer.from(base), pub, sig)).toBe(true);
  }

  for (const [profile, display] of [
    ['logged-in', ':96'],
    ['logged-out', ':97'],
  ] as const) {
    it(
      `signs navigation and sub-resource requests on the ${profile} profile`,
      { timeout: 60000 },
      async () => {
        const base = await start(true, display);
        await manager!.open({ url: `${base}/`, profile });
        await new Promise((r) => setTimeout(r, 500));
        const authority = new URL(base).host;
        const page = seen.find((s) => s.path === '/')!;
        const img = seen.find((s) => s.path === '/pixel.png')!;
        assertSigned(page.headers, authority);
        assertSigned(img.headers, authority);
        expect(page.headers['user-agent']).toBeTruthy();
      },
    );
  }

  it('sends no signature headers when off', { timeout: 60000 }, async () => {
    const base = await start(false, ':98');
    await manager!.open({ url: `${base}/`, profile: 'logged-out' });
    const page = seen.find((s) => s.path === '/')!;
    expect(page.headers['signature']).toBeUndefined();
    expect(page.headers['signature-agent']).toBeUndefined();
  });

  it('turns signing on and off for an existing browser session', { timeout: 60000 }, async () => {
    const base = await start(false, ':99');
    await manager!.open({ url: `${base}/?state=off`, profile: 'logged-out' });
    expect(seen.find((s) => s.path === '/?state=off')!.headers['signature']).toBeUndefined();

    manager!.setWebBotAuth({
      directoryUrl: DIR,
      sign: async (url: string) => signRequestHeaders(url, key, DIR),
    });
    await manager!.open({ url: `${base}/?state=on`, profile: 'logged-out' });
    assertSigned(seen.find((s) => s.path === '/?state=on')!.headers, new URL(base).host);

    manager!.setWebBotAuth(undefined);
    await manager!.open({ url: `${base}/?state=off-again`, profile: 'logged-out' });
    expect(seen.find((s) => s.path === '/?state=off-again')!.headers['signature']).toBeUndefined();
  });
});
