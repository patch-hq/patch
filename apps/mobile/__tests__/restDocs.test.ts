// api/rest.ts — chat-folder files and the document editor's calls
// (spec/14 § Document editor). NO FALLBACK: a non-2xx throws ApiError.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { api, ApiError } from '../src/api/rest';
import { bytesToBase64 } from '../src/lib/base64';
import { saveCredential, clearCredential } from '../src/lib/credential';
import { TEST_SERVER_URL as SERVER_URL } from './stubs/mmkv';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  clearCredential();
});
const last = (): [string, RequestInit] => fetchMock.mock.calls.at(-1) as [string, RequestInit];

describe('chat folder files', () => {
  it('lists a folder by relative path, the root as an empty path', async () => {
    fetchMock.mockImplementation(async () => json({ path: '', entries: [] }));
    await api.chatFilesList('c 1');
    expect(last()[0]).toBe(`${SERVER_URL}/api/chats/c%201/files?path=`);
    await api.chatFilesList('c1', 'my docs/sub');
    expect(last()[0]).toBe(`${SERVER_URL}/api/chats/c1/files?path=my%20docs%2Fsub`);
  });

  it('reads a file with content=1', async () => {
    fetchMock.mockResolvedValue(json({ path: 'a.md', content: '# a\n', size: 4 }));
    expect(await api.chatFileRead('c1', 'a b.md')).toEqual({
      path: 'a.md',
      content: '# a\n',
      size: 4,
    });
    expect(last()[0]).toBe(`${SERVER_URL}/api/chats/c1/files?path=a%20b.md&content=1`);
  });

  it('throws the host error', async () => {
    fetchMock.mockResolvedValue(json({ error: 'not_found', message: 'no such file' }, 404));
    await expect(api.chatFileRead('c1', 'x.md')).rejects.toMatchObject({
      status: 404,
      message: 'not_found: no such file',
    });
  });
});

describe('document calls', () => {
  it('getDoc GETs the view', async () => {
    fetchMock.mockResolvedValue(
      json({ mode: 'change', suggestions: [], threads: [], versions: [] }),
    );
    await api.getDoc('c1', 'a/b.md');
    expect(last()[0]).toBe(`${SERVER_URL}/api/chats/c1/doc?path=a%2Fb.md`);
  });

  it('docAction POSTs path and action and returns the view', async () => {
    const view = { mode: 'propose', suggestions: [], threads: [], versions: [] };
    fetchMock.mockResolvedValue(json(view));
    expect(await api.docAction('c1', 'a.md', { op: 'set_mode', mode: 'propose' })).toEqual(view);
    const [url, init] = last();
    expect(url).toBe(`${SERVER_URL}/api/chats/c1/doc/action`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(
      JSON.stringify({ path: 'a.md', action: { op: 'set_mode', mode: 'propose' } }),
    );
  });

  it('convertDocx POSTs the path', async () => {
    fetchMock.mockResolvedValue(json({ mdPath: 'r.md', warnings: ['w'], reused: false }));
    expect(await api.convertDocx('c1', 'r.docx')).toEqual({
      mdPath: 'r.md',
      warnings: ['w'],
      reused: false,
    });
    expect(last()[0]).toBe(`${SERVER_URL}/api/chats/c1/doc/convert`);
    expect(last()[1].body).toBe(JSON.stringify({ path: 'r.docx' }));
  });
});

describe('exportDoc', () => {
  const bytes = new Uint8Array([72, 105, 33, 255]);
  const ok = (headers: Record<string, string>): Response =>
    new Response(bytes, { status: 200, headers });

  it('POSTs path+format and returns base64 bytes, the file name and warnings', async () => {
    saveCredential('tok');
    fetchMock.mockResolvedValue(
      ok({
        'x-patch-doc-path': 'docs/r.pdf',
        'x-patch-doc-warnings': JSON.stringify(['image skipped']),
      }),
    );
    const out = await api.exportDoc('c1', 'docs/r.md', 'pdf');
    expect(out).toEqual({
      base64: bytesToBase64(bytes),
      filename: 'r.pdf',
      warnings: ['image skipped'],
    });
    const [url, init] = last();
    expect(url).toBe(`${SERVER_URL}/api/chats/c1/doc/export`);
    expect(init.body).toBe(JSON.stringify({ path: 'docs/r.md', format: 'pdf' }));
    expect((init.headers as Headers).get('authorization')).toBe('Bearer tok');
  });

  it('treats a missing warnings header as none', async () => {
    fetchMock.mockResolvedValue(ok({ 'x-patch-doc-path': 'r.md' }));
    expect((await api.exportDoc('c1', 'r.md', 'md')).warnings).toEqual([]);
  });

  it('throws when the host names no file', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await expect(api.exportDoc('c1', 'r.md', 'md')).rejects.toThrow(/named no file/);
  });

  it('throws ApiError with the host reason, JSON or not', async () => {
    fetchMock.mockResolvedValue(json({ error: 'browser_missing', message: 'no chromium' }, 503));
    await expect(api.exportDoc('c1', 'r.md', 'pdf')).rejects.toMatchObject({
      status: 503,
      message: 'browser_missing: no chromium',
    });
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const err = await api.exportDoc('c1', 'r.md', 'pdf').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });
});

describe('bytesToBase64', () => {
  it.each([
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
  ])('encodes %j', (text, b64) => {
    expect(bytesToBase64(new TextEncoder().encode(text))).toBe(b64);
  });
});
