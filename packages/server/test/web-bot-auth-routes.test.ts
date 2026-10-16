import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { build } from '../src/app.js';
import { InProcessHostLink } from '../src/host-link.js';
import { Registry } from '../src/registry.js';
import type { WireEvent } from '@patch/wire';
import { agentPageHtml } from '../src/web-bot-auth-routes.js';

describe('Web Bot Auth public routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wba-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const mk = () =>
    build({
      logger: false,
      dataDir: dir,
      hostLink: new InProcessHostLink(),
    });

  it('serves a directory, unauthenticated, signed over the request authority', async () => {
    const app = await mk();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/http-message-signatures-directory',
        headers: { host: 'patch.tomchambers.me' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe(
        'application/http-message-signatures-directory+json',
      );
      const { keys } = res.json() as { keys: { kty: string; crv: string; x: string }[] };
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
      const params = String(res.headers['signature-input']).replace(/^sig1=/, '');
      expect(params).toContain('tag="http-message-signatures-directory"');
      expect(params).toContain('("@authority";req)');
      const base = `"@authority";req: patch.tomchambers.me\n"@signature-params": ${params}`;
      const sig = Buffer.from(
        /^sig1=:(.+):$/.exec(String(res.headers['signature']))![1]!,
        'base64',
      );
      const pub = createPublicKey({ key: keys[0]!, format: 'jwk' });
      expect(verify(null, Buffer.from(base), pub, sig)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('creates its identity itself and retains it across a restart', async () => {
    const app = await mk();
    let first: { keys: { x: string }[] };
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/http-message-signatures-directory',
      });
      expect(res.statusCode).toBe(200);
      first = res.json();
    } finally {
      await app.close();
    }
    const restarted = await mk();
    try {
      const res = await restarted.inject({
        method: 'GET',
        url: '/.well-known/http-message-signatures-directory',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(first!);
    } finally {
      await restarted.close();
    }
  });

  it('keeps the private key on the server and signs for an authenticated host', async () => {
    const hostLink = new InProcessHostLink();
    const app = await build({ logger: false, dataDir: dir, hostLink });
    try {
      const adopt = hostLink.sent.find((x) => x.event.type === 'settings.adopt.request')
        ?.event as Extract<WireEvent, { type: 'settings.adopt.request' }>;
      hostLink.emit({
        type: 'settings.adopt.response',
        hostId: 'd1',
        requestId: adopt.requestId,
        ok: true,
        result: {
          kind: 'import',
          import: { settings: {}, secrets: { claude: [], codex: [], providerKeys: {} } },
        },
      });
      await expect
        .poll(() => hostLink.sent.find((x) => x.event.type === 'settings.snapshot')?.event)
        .toBeDefined();
      const snapshot = hostLink.sent.find((x) => x.event.type === 'settings.snapshot')!
        .event as Extract<WireEvent, { type: 'settings.snapshot' }>;
      expect(snapshot?.secrets).not.toHaveProperty('webBotAuthKey');

      hostLink.emit({
        type: 'web_bot_auth.sign_request',
        hostId: 'd1',
        requestId: 'sign-1',
        authority: 'shop.example',
        directoryUrl: 'https://patch.example/.well-known/http-message-signatures-directory',
      });
      const response = hostLink.sent.find((x) => x.event.type === 'web_bot_auth.sign_response')
        ?.event as Extract<WireEvent, { type: 'web_bot_auth.sign_response' }> | undefined;
      expect(response).toMatchObject({ requestId: 'sign-1', hostId: 'd1', ok: true });
      expect(response?.result?.headers['Signature-Agent']).toBe(
        '"https://patch.example/.well-known/http-message-signatures-directory"',
      );
      expect(response?.result?.headers.Signature).toMatch(/^sig1=:.+:$/);
      const directory = await app.inject({
        method: 'GET',
        url: '/.well-known/http-message-signatures-directory',
        headers: { host: 'patch.example' },
      });
      const publicJwk = (directory.json() as { keys: JsonWebKey[] }).keys[0]!;
      const params = response!.result!.headers['Signature-Input']!.replace(/^sig1=/, '');
      const base =
        `"@authority": shop.example\n` +
        `"signature-agent": "https://patch.example/.well-known/http-message-signatures-directory"\n` +
        `"@signature-params": ${params}`;
      const signature = Buffer.from(
        /^sig1=:(.+):$/.exec(response!.result!.headers.Signature!)![1]!,
        'base64',
      );
      expect(
        verify(
          null,
          Buffer.from(base),
          createPublicKey({ key: publicJwk, format: 'jwk' }),
          signature,
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('refuses a signing request that claims to come from another host', async () => {
    const hostLink = new InProcessHostLink();
    const app = await build({ logger: false, dataDir: dir, hostLink });
    try {
      hostLink.emit(
        {
          type: 'web_bot_auth.sign_request',
          hostId: 'another-host',
          requestId: 'sign-wrong-host',
          authority: 'shop.example',
          directoryUrl: 'https://patch.example/.well-known/http-message-signatures-directory',
        },
        'd1',
      );
      expect(
        hostLink.sent.find((x) => x.event.type === 'web_bot_auth.sign_response')?.event,
      ).toMatchObject({
        ok: false,
        error: { code: 'wrong_host' },
      });
    } finally {
      await app.close();
    }
  });

  it('serves the public description page', async () => {
    const app = await mk();
    try {
      const res = await app.inject({ method: 'GET', url: '/agent' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      for (const needle of [
        'User-directed AI agent',
        'robots.txt',
        'low request rates',
        '/.well-known/http-message-signatures-directory',
      ]) {
        expect(res.body).toContain(needle);
      }
    } finally {
      await app.close();
    }
  });

  it('renders deployment-owned public details without exposing editable HTML', async () => {
    const html = agentPageHtml(
      'https://patch.example/.well-known/http-message-signatures-directory',
      {
        name: '<My agent>',
        description: 'Browses for me & only me.',
        contact: 'operator@example.com',
      },
    );
    expect(html).toContain('<h1>&lt;My agent&gt;</h1>');
    expect(html).toContain('Browses for me &amp; only me.');
    expect(html).toContain('operator@example.com');
    expect(html).not.toContain('<h1><My agent></h1>');
  });

  it('reports the deployment URLs and key id to an authenticated settings surface', async () => {
    const registry = Registry.load(dir);
    const user = generateUserKeypair(() => new Uint8Array(32).fill(21));
    registry.bootstrapAccount({ keypair: user });
    const credential = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'web-identity-test',
      surfaceKind: 'web',
      label: 'browser',
    });
    const app = await build({
      logger: false,
      registry,
      hostLink: new InProcessHostLink(),
    });
    try {
      const unauthenticated = await app.inject({ method: 'GET', url: '/api/web-bot-auth' });
      expect(unauthenticated.statusCode).toBe(401);
      const response = await app.inject({
        method: 'GET',
        url: '/api/web-bot-auth',
        headers: {
          authorization: `Bearer ${credential}`,
          host: 'internal:3000',
          'x-forwarded-host': 'patch.example',
          'x-forwarded-proto': 'https',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ready: true,
        origin: 'https://patch.example',
        agentUrl: 'https://patch.example/agent',
        directoryUrl: 'https://patch.example/.well-known/http-message-signatures-directory',
      });
      expect((response.json() as { keyId: string }).keyId).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const localOnly = await app.inject({
        method: 'GET',
        url: '/api/web-bot-auth',
        headers: {
          authorization: `Bearer ${credential}`,
          host: 'localhost:3000',
          'x-forwarded-proto': 'https',
        },
      });
      expect(localOnly.json()).toMatchObject({
        ready: false,
        issue: 'Web Bot Auth requires a publicly accessible HTTPS server',
      });
    } finally {
      await app.close();
    }
  });
});
