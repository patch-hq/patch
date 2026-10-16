// The public desktop update feed (/api/desktop/:name).
//
// electron-updater fetches the zip's .blockmap and then asks for just the
// changed byte ranges. A server that answers every Range request with the whole
// file makes the blockmap pointless: each update downloads the full zip.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

describe('desktop feed', () => {
  let dir: string;
  let downloadsDir: string;
  const originalEnv = process.env.PATCH_DOWNLOADS_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-desktop-feed-'));
    downloadsDir = mkdtempSync(join(tmpdir(), 'patch-desktop-feed-dl-'));
    process.env.PATCH_DOWNLOADS_DIR = downloadsDir;
    writeFileSync(join(downloadsDir, 'Patch-0.1.9-arm64-mac.zip'), '0123456789');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(downloadsDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.PATCH_DOWNLOADS_DIR;
    else process.env.PATCH_DOWNLOADS_DIR = originalEnv;
  });

  async function get(headers: Record<string, string>) {
    const registry = Registry.load(dir);
    const app = await build({ logger: false, registry, hostLink: new InProcessHostLink() });
    try {
      return await app.inject({
        method: 'GET',
        url: '/api/desktop/Patch-0.1.9-arm64-mac.zip',
        headers,
      });
    } finally {
      await app.close();
    }
  }

  it('answers a byte range with 206 and only those bytes', async () => {
    const res = await get({ range: 'bytes=2-5' });
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe('2345');
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['content-length']).toBe('4');
  });

  it('answers an open-ended range', async () => {
    const res = await get({ range: 'bytes=7-' });
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe('789');
    expect(res.headers['content-range']).toBe('bytes 7-9/10');
  });

  it('rejects a range past the end with 416', async () => {
    const res = await get({ range: 'bytes=50-60' });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */10');
  });

  it('advertises range support on a plain request', async () => {
    const res = await get({});
    expect(res.statusCode).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.body).toBe('0123456789');
  });

  // electron-updater (generic provider) sends ALL the changed blocks in one
  // request — `Range: bytes=a-b, c-d, …` — and rejects anything but
  // 206 multipart/byteranges ("Content-Type multipart/byteranges is expected"),
  // falling back to a full download. Answering with the whole file defeated the
  // blockmap for every update with more than one changed region.
  it('answers several ranges with 206 multipart/byteranges, parts in request order', async () => {
    const res = await get({ range: 'bytes=6-8, 0-1' });
    expect(res.statusCode).toBe(206);
    const type = res.headers['content-type'] as string;
    const boundary = /^multipart\/byteranges;\s*boundary=(.+)$/.exec(type)?.[1];
    expect(boundary).toBeTruthy();
    expect(res.body).toBe(
      `--${boundary}\r\n` +
        'Content-Type: application/octet-stream\r\n' +
        'Content-Range: bytes 6-8/10\r\n\r\n' +
        '678\r\n' +
        `--${boundary}\r\n` +
        'Content-Type: application/octet-stream\r\n' +
        'Content-Range: bytes 0-1/10\r\n\r\n' +
        '01\r\n' +
        `--${boundary}--\r\n`,
    );
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(res.body)));
  });

  it('serves a single surviving range as a plain 206 when the others fall outside the file', async () => {
    const res = await get({ range: 'bytes=50-60, 2-3' });
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe('23');
    expect(res.headers['content-range']).toBe('bytes 2-3/10');
  });
});
