// Phone updates from the followed release (spec/11 § Mobile updates): the
// update check expo-updates makes, and the one notice a new APK gets.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import {
  MobileUpdateNotifier,
  manifestResponse,
  registerMobileUpdateRoutes,
  type MobileUpdate,
} from '../src/mobile-updates.js';

const MANIFEST = JSON.stringify({ id: 'AB12-cd34', runtimeVersion: '0.1.6', launchAsset: {} });
const UPDATE: MobileUpdate = {
  platform: 'android',
  runtimeVersion: '0.1.6',
  version: '1.2.3',
  gitSha: 'abc1234',
  builtAt: '2026-10-19T00:00:00Z',
  manifest: MANIFEST,
  signature: 'sig="c2ln", keyid="main"',
};
const logger = { warn: vi.fn(), info: vi.fn() };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-mobile-updates-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function server() {
  const app = Fastify();
  registerMobileUpdateRoutes(app, { downloadsDir: dir, logger });
  await app.ready();
  return app;
}
const ask = (app: Awaited<ReturnType<typeof server>>, headers: Record<string, string>) =>
  app.inject({ method: 'GET', url: '/api/mobile/updates', headers });
const PHONE = {
  'expo-platform': 'android',
  'expo-runtime-version': '0.1.6',
  'expo-protocol-version': '1',
};

describe('GET /api/mobile/updates', () => {
  it('relays the signed manifest byte for byte, with its signature, as protocol v1 multipart', async () => {
    writeFileSync(join(dir, 'mobile-update.json'), JSON.stringify(UPDATE));
    const app = await server();
    const res = await ask(app, PHONE);
    expect(res.statusCode).toBe(200);
    expect(res.headers['expo-protocol-version']).toBe('1');
    expect(res.headers['expo-sfv-version']).toBe('0');
    const boundary = /boundary=(\S+)/.exec(String(res.headers['content-type']))?.[1];
    expect(boundary).toBeDefined();
    const parts = res.body.split(`--${boundary}`);
    const manifestPart = parts.find((p) => p.includes('name="manifest"'))!;
    const [head, body] = manifestPart.split('\r\n\r\n');
    expect(head).toContain('expo-signature: sig="c2ln", keyid="main"');
    // Exactly the signed bytes: one changed character and the phone refuses it.
    expect(body!.replace(/\r\n$/, '')).toBe(MANIFEST);
    expect(parts.some((p) => p.includes('name="extensions"'))).toBe(true);
    await app.close();
  });

  it('tells a phone on another runtime there is nothing for it — that bundle would not run on its APK', async () => {
    writeFileSync(join(dir, 'mobile-update.json'), JSON.stringify(UPDATE));
    const app = await server();
    const res = await ask(app, { ...PHONE, 'expo-runtime-version': '0.1.5' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    await app.close();
  });

  it('says nothing new to a phone already running this update', async () => {
    writeFileSync(join(dir, 'mobile-update.json'), JSON.stringify(UPDATE));
    const app = await server();
    const res = await ask(app, { ...PHONE, 'expo-current-update-id': 'ab12-CD34' });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it('says so when nothing is published, and refuses a request that is not from the app', async () => {
    const app = await server();
    expect((await ask(app, PHONE)).statusCode).toBe(404);
    expect((await ask(app, { 'expo-runtime-version': '0.1.6' })).statusCode).toBe(400);
    expect((await ask(app, { 'expo-platform': 'android' })).statusCode).toBe(400);
    writeFileSync(join(dir, 'mobile-update.json'), '{"runtimeVersion":"0.1.6"}');
    expect((await ask(app, PHONE)).statusCode).toBe(500);
    await app.close();
  });

  it('builds a fresh boundary that cannot occur in the manifest', () => {
    const a = manifestResponse(UPDATE);
    const b = manifestResponse(UPDATE);
    expect(a.boundary).not.toBe(b.boundary);
    expect(MANIFEST.includes(a.boundary)).toBe(false);
  });
});

describe('MobileUpdateNotifier', () => {
  let data: string;
  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), 'patch-mobile-announce-'));
  });
  afterEach(() => rmSync(data, { recursive: true, force: true }));

  const notifier = (route = vi.fn(async () => undefined)) => ({
    route,
    n: new MobileUpdateNotifier({
      downloadsDir: dir,
      dataDir: data,
      repo: 'o/r',
      router: { route },
      logger,
    }),
  });
  const publish = (version: string, runtimeVersion?: string) =>
    writeFileSync(
      join(dir, 'android-latest.json'),
      JSON.stringify({
        version,
        file: `patch-${version}.apk`,
        ...(runtimeVersion ? { runtimeVersion } : {}),
      }),
    );

  it('announces an APK on a new runtime once, linking the release’s own copy', async () => {
    publish('1.2.3', '0.1.6');
    writeFileSync(join(dir, 'release-mirror.json'), JSON.stringify({ tag: 'dev-1.2.3' }));
    const { route, n } = notifier();
    expect(await n.check()).toBe(true);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'app-update',
        channel: 'push',
        priority: 'silent',
        message: expect.stringMatching(/Patch 1\.2\.3 .*download/),
        deepLink: 'https://github.com/o/r/releases/download/dev-1.2.3/patch-1.2.3.apk',
      }),
      {},
    );
    // A restart (a fresh notifier over the same disk) does not say it again.
    expect(await notifier(route).n.check()).toBe(false);
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for a new build on the same runtime — the update check brings that', async () => {
    publish('1.2.3', '0.1.6');
    const { route, n } = notifier();
    await n.check();
    publish('1.2.4', '0.1.6');
    expect(await n.check()).toBe(false);
    publish('1.3.0', '0.1.7');
    expect(await n.check()).toBe(true);
    expect(route).toHaveBeenCalledTimes(2);
  });

  it('says nothing about an APK that does not state its runtime, or when none is published', async () => {
    const { route, n } = notifier();
    expect(await n.check()).toBe(false);
    publish('1.2.3');
    expect(await n.check()).toBe(false);
    expect(route).not.toHaveBeenCalled();
  });

  it('does not record a notice that failed to send, so the next check tries again', async () => {
    publish('1.2.3', '0.1.6');
    const failing = vi.fn(async () => {
      throw new Error('push: no push backend configured');
    });
    await expect(notifier(failing).n.check()).rejects.toThrow('no push backend');
    expect(existsSync(join(data, 'announced-apk.json'))).toBe(false);
    const { route, n } = notifier();
    expect(await n.check()).toBe(true);
    expect(route).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(data, 'announced-apk.json'), 'utf8'))).toEqual({
      runtimeVersion: '0.1.6',
      version: '1.2.3',
    });
  });
});
