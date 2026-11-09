import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { IssueFiler, hostTurnFailureReport } from '../src/issue-filer.js';
import { scrub } from '../src/issue-scrub.js';

describe('scrub', () => {
  it('removes paths, emails, urls, ips and credentials', () => {
    const out = scrub(
      'ENOENT /home/tom/projects/x/a.ts by tom.chambers@gmail.com at https://patch.example.me/api?k=1 ' +
        'from 10.0.0.12 with ' +
        ['gh', 'p_'].join('') +
        'abcdefghijklmnopqrstuvwxyz0123 and Authorization: Bearer abcdef123456',
    );
    expect(out).not.toMatch(/tom|gmail|patch\.example|10\.0\.0|ghp_|abcdef123456/);
    expect(out).toContain('~/projects/x/a.ts');
  });
  it('removes uuids and long opaque ids', () => {
    expect(
      scrub('chat 123e4567-e89b-12d3-a456-426614174000 and deadbeefdeadbeefdeadbeefdeadbeef'),
    ).toBe('chat <id> and <id>');
  });
});

describe('IssueFiler', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-filer-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function make(fetchImpl: typeof fetch, token: string | null = 'tok') {
    return new IssueFiler({
      dataDir: dir,
      logger: pino({ level: 'silent' }),
      repo: 'o/r',
      token: token ?? undefined,
      version: '1.2.3',
      fetch: fetchImpl,
    });
  }
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('is off by default and files nothing', async () => {
    const f = vi.fn();
    const filer = make(f as unknown as typeof fetch);
    expect(filer.status().enabled).toBe(false);
    filer.reportAuto({ kind: 'server-error', message: 'boom' });
    await filer.flush();
    expect(f).not.toHaveBeenCalled();
    expect(filer.status().pending).toBe(0);
  });

  it('files an automatic report once, scrubbed, and collapses repeats', async () => {
    const calls: { url: string; body?: string }[] = [];
    const f = vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
      if (url.includes('/search/')) return json({ items: [] });
      return json({ number: 7, html_url: 'https://github.com/o/r/issues/7' }, 201);
    });
    const filer = make(f as unknown as typeof fetch);
    filer.setEnabled(true);
    const report = {
      kind: 'server-error' as const,
      message: 'failed reading /home/tom/data/x.json',
      stack: 'Error: x\n    at read (/home/tom/app/a.ts:10:5)',
    };
    filer.reportAuto(report);
    await filer.flush();
    filer.reportAuto(report);
    await filer.flush();
    const created = calls.filter((c) => c.body);
    expect(created).toHaveLength(1);
    const body = JSON.parse(created[0]!.body!) as { title: string; body: string; labels: string[] };
    expect(body.labels).toEqual(['auto-filed', 'bug']);
    expect(body.body).not.toContain('/home/tom');
    expect(body.body).toContain('patch-fp-');
    expect(filer.status()).toMatchObject({ pending: 0, filed: 1, lastError: null });
  });

  it('does not file when GitHub search already has the fingerprint', async () => {
    const f = vi.fn((url: string) =>
      url.includes('/search/')
        ? json({ items: [{ number: 3, html_url: 'https://github.com/o/r/issues/3' }] })
        : json({}, 500),
    );
    const filer = make(f as unknown as typeof fetch);
    filer.setEnabled(true);
    filer.reportAuto({ kind: 'server-error', message: 'boom' });
    await filer.flush();
    expect(f).toHaveBeenCalledTimes(1);
    expect(filer.status().pending).toBe(0);
  });

  it('keeps a report queued and says why when filing fails', async () => {
    const f = vi.fn(() => json({ message: 'nope' }, 403));
    const filer = make(f as unknown as typeof fetch);
    filer.setEnabled(true);
    filer.reportAuto({ kind: 'server-error', message: 'boom' });
    await filer.flush();
    expect(filer.status().pending).toBe(1);
    expect(filer.status().lastError).toMatch(/GitHub 403/);
  });

  it('reports a missing token instead of dropping reports', async () => {
    const filer = make(vi.fn() as unknown as typeof fetch, null);
    filer.setEnabled(true);
    filer.reportAuto({ kind: 'server-error', message: 'boom' });
    await filer.flush();
    expect(filer.status()).toMatchObject({ pending: 1, tokenConfigured: false });
    expect(filer.status().lastError).toMatch(/token/);
  });

  it('persists the switch and the queue across restarts', async () => {
    const f = vi.fn(() => json({}, 500));
    const a = make(f as unknown as typeof fetch);
    a.setEnabled(true);
    a.reportAuto({ kind: 'uncaught', message: 'died' });
    const b = make(f as unknown as typeof fetch);
    expect(b.status()).toMatchObject({ enabled: true, pending: 1 });
    expect(JSON.parse(readFileSync(join(dir, 'issue-reporting.json'), 'utf8'))).toEqual({
      enabled: true,
    });
  });

  it('files a manual report even with automatic reporting off, with its own label', async () => {
    let sent = '';
    const f = vi.fn((_u: string, init?: RequestInit) => {
      sent = String(init?.body);
      return json({ number: 9, html_url: 'https://github.com/o/r/issues/9' }, 201);
    });
    const filer = make(f as unknown as typeof fetch);
    const url = await filer.fileManual({
      kind: 'manual',
      message: 'Send button dead',
      description: 'tap does nothing, mail me at a@b.co',
      route: 'chat',
    });
    expect(url).toBe('https://github.com/o/r/issues/9');
    const body = JSON.parse(sent) as { body: string; labels: string[] };
    expect(body.labels).toContain('user-reported');
    expect(body.body).toContain('Send button dead'.slice(0, 4));
    expect(body.body).not.toContain('a@b.co');
  });
});

describe('hostTurnFailureReport', () => {
  const err = (code: string, message: string) =>
    ({ type: 'chat.error', chatId: 'c', seq: 1, error: { code, message } }) as unknown as WireEvent;
  it('files a host turn failure', () => {
    expect(
      hostTurnFailureReport(
        err('sdk_error', 'The Claude Code process ended mid-turn without finishing'),
        'host-1',
      ),
    ).toMatchObject({ kind: 'server-error', surface: 'host' });
  });
  it('ignores server-generated, non-sdk and limit errors', () => {
    expect(hostTurnFailureReport(err('sdk_error', 'boom'), null)).toBeNull();
    expect(hostTurnFailureReport(err('daemon_unavailable', 'lost'), 'host-1')).toBeNull();
    expect(hostTurnFailureReport(err('sdk_error', 'Usage limit reached'), 'host-1')).toBeNull();
    expect(
      hostTurnFailureReport(
        { type: 'chat.stopped', chatId: 'c' } as unknown as WireEvent,
        'host-1',
      ),
    ).toBeNull();
  });
});
