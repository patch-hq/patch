// Message hooks on the phone (spec/20-hooks.md § On the user's message).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { adviseNotes, checkHooks, HOOK_CHECK_TIMEOUT_MS } from '../src/lib/hookCheck';
import * as credential from '../src/lib/credential';
import * as FileSystem from 'expo-file-system';
import { HOOK_IMAGES_MAX, HOOK_IMAGE_MAX_BASE64 } from '@patch/wire/hooks';
import type { PendingAttachment } from '../src/stores/composerAttachmentStore';

const img = (uri: string, mimeType: string): PendingAttachment => ({
  key: uri + Math.random(),
  uri,
  name: uri.split('/').pop()!,
  mimeType,
  kind: 'image',
  width: 100,
  height: 100,
});

const okBody = { decision: 'pass', results: [] };

const hooksList = (hooks: unknown[]) =>
  new Response(JSON.stringify({ hooks }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const enabledHook = { id: 'h1', name: 'h', when: 'user_message', enabled: true };

// The list call that gates a check is answered with one enabled hook unless
// `list` says otherwise; `impl` answers the check itself.
function stubFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>,
  list: () => Response = () => hooksList([enabledHook]),
) {
  const f = vi.fn((url: string, init: RequestInit) =>
    String(url).endsWith('/api/hooks') ? Promise.resolve(list()) : impl(url, init),
  );
  vi.stubGlobal('fetch', f);
  return f;
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('checkHooks with nothing enabled', () => {
  it('passes without reading images or posting a check', async () => {
    const read = vi.spyOn(FileSystem, 'readAsStringAsync');
    const f = stubFetch(
      async () => json(200, okBody),
      () =>
        hooksList([
          { ...enabledHook, enabled: false },
          { ...enabledHook, when: 'agent_response' },
        ]),
    );
    expect(await checkHooks('c1', 'hi', [img('file:///a.png', 'image/png')])).toEqual(okBody);
    expect(f).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('checkHooks', () => {
  it('posts chatId + message with the bearer and returns the server answer', async () => {
    vi.spyOn(credential, 'loadCredential').mockReturnValue('tok');
    const f = stubFetch(async () => json(200, okBody));
    expect(await checkHooks('c1', 'hi')).toEqual(okBody);
    const [url, init] = f.mock.calls.find(([u]) => String(u).includes('/api/hooks/check'))!;
    expect(String(url)).toContain('/api/hooks/check');
    expect(JSON.parse(init.body as string)).toEqual({ chatId: 'c1', message: 'hi' });
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
  });

  it('sends no authorization header without a credential', async () => {
    vi.spyOn(credential, 'loadCredential').mockReturnValue(null);
    const f = stubFetch(async () => json(200, okBody));
    await checkHooks('c1', 'hi');
    expect(
      (
        f.mock.calls.find(([u]) => String(u).includes('/api/hooks/check'))![1].headers as Record<
          string,
          string
        >
      )['authorization'],
    ).toBeUndefined();
  });

  it('a block stays a block', async () => {
    const body = {
      decision: 'block',
      results: [{ hookId: 'h', hookName: 'H', status: 'ok', decision: 'block', durationMs: 1 }],
    };
    stubFetch(async () => json(200, body));
    expect((await checkHooks('c1', 'hi')).decision).toBe('block');
  });

  it('sends image attachments as downscaled base64 images', async () => {
    await FileSystem.writeAsStringAsync('file:///a.png', 'QUJD');
    const f = stubFetch(async () => json(200, okBody));
    const res = await checkHooks('c1', 'hi', [img('file:///a.png', 'image/png')]);
    expect(res).toEqual(okBody);
    expect(
      JSON.parse(
        f.mock.calls.find(([u]) => String(u).includes('/api/hooks/check'))![1].body as string,
      ),
    ).toEqual({
      chatId: 'c1',
      message: 'hi',
      images: [{ mediaType: 'image/png', data: 'QUJD' }],
    });
  });

  it('sends no images key when there are no image attachments; files are not sent', async () => {
    const f = stubFetch(async () => json(200, okBody));
    const res = await checkHooks('c1', 'hi', [
      { key: 'f', uri: 'file:///x.pdf', name: 'x.pdf', mimeType: 'application/pdf', kind: 'file' },
    ]);
    expect(res).toEqual(okBody);
    expect(
      JSON.parse(
        f.mock.calls.find(([u]) => String(u).includes('/api/hooks/check'))![1].body as string,
      ),
    ).toEqual({ chatId: 'c1', message: 'hi' });
  });

  it('an unsupported image type is reported, never silently dropped', async () => {
    await FileSystem.writeAsStringAsync('file:///a.png', 'QUJD');
    const f = stubFetch(async () => json(200, okBody));
    const res = await checkHooks('c1', 'hi', [
      img('file:///a.png', 'image/png'),
      img('file:///b.heic', 'image/heic'),
    ]);
    expect(
      JSON.parse(
        f.mock.calls.find(([u]) => String(u).includes('/api/hooks/check'))![1].body as string,
      ).images,
    ).toHaveLength(1);
    expect(res.decision).toBe('advise');
    expect(res.results[0]!.error).toMatch(/b\.heic.*image\/heic/);
  });

  it('more than the allowed number of images is reported', async () => {
    await FileSystem.writeAsStringAsync('file:///a.png', 'QUJD');
    const f = stubFetch(async () => json(200, okBody));
    const many = Array.from({ length: HOOK_IMAGES_MAX + 1 }, () =>
      img('file:///a.png', 'image/png'),
    );
    const res = await checkHooks('c1', 'hi', many);
    expect(
      JSON.parse(
        f.mock.calls.find(([u]) => String(u).includes('/api/hooks/check'))![1].body as string,
      ).images,
    ).toHaveLength(HOOK_IMAGES_MAX);
    expect(res.results[0]!.error).toMatch(/too many/);
  });

  it('an image too large to send is reported', async () => {
    await FileSystem.writeAsStringAsync('file:///big.png', 'A'.repeat(HOOK_IMAGE_MAX_BASE64 + 1));
    const f = stubFetch(async () => json(200, okBody));
    const res = await checkHooks('c1', 'hi', [img('file:///big.png', 'image/png')]);
    expect(
      JSON.parse(
        f.mock.calls.find(([u]) => String(u).includes('/api/hooks/check'))![1].body as string,
      ).images,
    ).toBeUndefined();
    expect(res.results[0]!.error).toMatch(/too large/);
  });

  it('an unreadable image is reported as a failed hook, not a stopped send', async () => {
    vi.spyOn(FileSystem, 'readAsStringAsync').mockRejectedValue(new Error('gone'));
    stubFetch(async () => json(200, okBody));
    const res = await checkHooks('c1', 'hi', [img('file:///a.png', 'image/png')]);
    expect(res.decision).toBe('advise');
    expect(res.results[0]!.error).toMatch(/gone/);
  });

  it('image problems do not soften a block', async () => {
    stubFetch(async () => json(200, { decision: 'block', results: [] }));
    const res = await checkHooks('c1', 'hi', [img('file:///b.heic', 'image/heic')]);
    expect(res.decision).toBe('block');
    expect(res.results).toHaveLength(1);
  });

  it('a 503 names the restarting server; other statuses name the status', async () => {
    stubFetch(async () => json(503, {}));
    expect((await checkHooks('c1', 'hi')).results[0]!.error).toMatch(/HTTP 503.*restarting/);
    stubFetch(async () => json(500, {}));
    expect((await checkHooks('c1', 'hi')).results[0]!.error).toBe('HTTP 500');
  });

  it('a network error rides the message as a failed hook, not a stopped send', async () => {
    stubFetch(async () => {
      throw new Error('offline');
    });
    const res = await checkHooks('c1', 'hi');
    expect(res.decision).toBe('advise');
    expect(res.results[0]!.error).toBe('offline');
  });

  it('times out instead of leaving Checking… forever', async () => {
    vi.useFakeTimers();
    stubFetch(
      (_u, init) =>
        new Promise((_res, rej) => {
          init.signal!.addEventListener('abort', () => rej(new Error('aborted')));
        }),
    );
    const p = checkHooks('c1', 'hi');
    await vi.advanceTimersByTimeAsync(HOOK_CHECK_TIMEOUT_MS + 1);
    expect((await p).results[0]!.error).toBe('timed out waiting for hooks');
  });
});

describe('adviseNotes', () => {
  it('keeps advice and failures, drops passes, and words failures', () => {
    const base = { durationMs: 0 };
    expect(
      adviseNotes([
        { hookId: 'a', hookName: 'A', status: 'ok', decision: 'pass', ...base },
        { hookId: 'b', hookName: 'B', status: 'ok', decision: 'advise', analysis: 'hm', ...base },
        { hookId: 'c', hookName: 'C', status: 'ok', decision: 'advise', ...base },
        { hookId: 'd', hookName: 'D', status: 'failed', error: 'boom', ...base },
        { hookId: 'e', hookName: 'E', status: 'timeout', ...base },
      ]),
    ).toEqual([
      { hookId: 'b', hookName: 'B', analysis: 'hm' },
      { hookId: 'c', hookName: 'C' },
      { hookId: 'd', hookName: 'D', analysis: 'Hook failed: boom' },
      { hookId: 'e', hookName: 'E', analysis: 'Hook failed: timeout' },
    ]);
  });
});
