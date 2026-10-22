// Host search on the host (spec/02 § Host search, spec/14 § File browser —
// ⌘⇧F). Real files, a real `rg` child process — the manager's whole job is
// what comes back from walking the real filesystem.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { HOST_SEARCH_MAX_MATCHES, HostSearchManager } from '../src/hostSearch.js';

function collector(): { frames: WireEvent[]; emit: (e: WireEvent) => void } {
  const frames: WireEvent[] = [];
  return { frames, emit: (e) => frames.push(e) };
}

function matches(
  frames: WireEvent[],
): Extract<WireEvent, { type: 'patch.host_search.result' }>['matches'] {
  return frames
    .filter(
      (f): f is Extract<WireEvent, { type: 'patch.host_search.result' }> =>
        f.type === 'patch.host_search.result',
    )
    .flatMap((f) => f.matches);
}

function done(
  frames: WireEvent[],
): Extract<WireEvent, { type: 'patch.host_search.done' }> | undefined {
  return frames.find(
    (f): f is Extract<WireEvent, { type: 'patch.host_search.done' }> =>
      f.type === 'patch.host_search.done',
  );
}

async function waitForDone(frames: WireEvent[]): Promise<void> {
  const start = Date.now();
  while (!done(frames)) {
    if (Date.now() - start > 10_000)
      throw new Error('timed out waiting for patch.host_search.done');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const logger = pino({ level: 'silent' });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-hostsearch-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('HostSearchManager', () => {
  it('finds a literal substring and reports line/column/preview', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1;\nfunction findMe() {}\n');
    const { frames, emit } = collector();
    const mgr = new HostSearchManager({ emit, logger });
    mgr.handle({
      type: 'patch.host_search.request',
      searchId: 's1',
      hostId: 'd1',
      root: dir,
      query: 'findMe',
    });
    await waitForDone(frames);
    expect(matches(frames)).toEqual([
      { path: 'a.ts', line: 2, column: 10, preview: 'function findMe() {}' },
    ]);
    expect(done(frames)).toMatchObject({ ok: true });
  });

  it('is case-insensitive by default and case-sensitive when asked', async () => {
    writeFileSync(join(dir, 'a.txt'), 'Hello World\n');
    const { frames: f1, emit: e1 } = collector();
    const mgr1 = new HostSearchManager({ emit: e1, logger });
    mgr1.handle({
      type: 'patch.host_search.request',
      searchId: 's1',
      hostId: 'd1',
      root: dir,
      query: 'hello',
    });
    await waitForDone(f1);
    expect(matches(f1)).toHaveLength(1);

    const { frames: f2, emit: e2 } = collector();
    const mgr2 = new HostSearchManager({ emit: e2, logger });
    mgr2.handle({
      type: 'patch.host_search.request',
      searchId: 's2',
      hostId: 'd1',
      root: dir,
      query: 'hello',
      caseSensitive: true,
    });
    await waitForDone(f2);
    expect(matches(f2)).toHaveLength(0);
  });

  it('searches literally, not as a regex', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a.b matches literally\na*b would be a regex\n');
    const { frames, emit } = collector();
    const mgr = new HostSearchManager({ emit, logger });
    mgr.handle({
      type: 'patch.host_search.request',
      searchId: 's1',
      hostId: 'd1',
      root: dir,
      query: 'a.b',
    });
    await waitForDone(frames);
    expect(matches(frames)).toHaveLength(1);
  });

  it('groups matches by file across multiple files', async () => {
    writeFileSync(join(dir, 'a.txt'), 'needle here\n');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.txt'), 'needle there\nand needle again\n');
    const { frames, emit } = collector();
    const mgr = new HostSearchManager({ emit, logger });
    mgr.handle({
      type: 'patch.host_search.request',
      searchId: 's1',
      hostId: 'd1',
      root: dir,
      query: 'needle',
    });
    await waitForDone(frames);
    const ms = matches(frames);
    expect(ms).toHaveLength(3);
    expect(new Set(ms.map((m) => m.path))).toEqual(new Set(['a.txt', 'sub/b.txt']));
  });

  it('cancel ends the search with no done frame', async () => {
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, `f${i}.txt`), 'needle\n'.repeat(50));
    const { frames, emit } = collector();
    const mgr = new HostSearchManager({ emit, logger });
    mgr.handle({
      type: 'patch.host_search.request',
      searchId: 's1',
      hostId: 'd1',
      root: dir,
      query: 'needle',
    });
    mgr.handle({ type: 'patch.host_search.cancel', searchId: 's1' });
    await new Promise((r) => setTimeout(r, 300));
    expect(done(frames)).toBeUndefined();
  });

  it('refuses a missing root, a file as root, and a non-canonical path', async () => {
    const { frames: f1, emit: e1 } = collector();
    new HostSearchManager({ emit: e1, logger }).handle({
      type: 'patch.host_search.request',
      searchId: 's1',
      hostId: 'd1',
      root: join(dir, 'nope'),
      query: 'x',
    });
    await waitForDone(f1);
    expect(done(f1)).toMatchObject({ ok: false, error: { code: 'not_found' } });

    writeFileSync(join(dir, 'f.txt'), 'x');
    const { frames: f2, emit: e2 } = collector();
    new HostSearchManager({ emit: e2, logger }).handle({
      type: 'patch.host_search.request',
      searchId: 's2',
      hostId: 'd1',
      root: join(dir, 'f.txt'),
      query: 'x',
    });
    await waitForDone(f2);
    expect(done(f2)).toMatchObject({ ok: false, error: { code: 'not_a_directory' } });

    const { frames: f3, emit: e3 } = collector();
    new HostSearchManager({ emit: e3, logger }).handle({
      type: 'patch.host_search.request',
      searchId: 's3',
      hostId: 'd1',
      root: 'relative/dir',
      query: 'x',
    });
    await waitForDone(f3);
    expect(done(f3)).toMatchObject({ ok: false, error: { code: 'path_invalid' } });
  });

  it('stamps forSurfaceId onto every emitted frame', async () => {
    writeFileSync(join(dir, 'a.txt'), 'needle\n');
    const { frames, emit } = collector();
    const mgr = new HostSearchManager({ emit, logger });
    mgr.handle({
      type: 'patch.host_search.request',
      searchId: 's1',
      hostId: 'd1',
      root: dir,
      query: 'needle',
      forSurfaceId: 'surf-1',
    });
    await waitForDone(frames);
    expect(frames.every((f) => 'forSurfaceId' in f && f.forSurfaceId === 'surf-1')).toBe(true);
  });

  it('truncates at HOST_SEARCH_MAX_MATCHES and reports it', async () => {
    const lines = Array.from({ length: HOST_SEARCH_MAX_MATCHES + 50 }, () => 'needle').join('\n');
    writeFileSync(join(dir, 'big.txt'), lines);
    const { frames, emit } = collector();
    const mgr = new HostSearchManager({ emit, logger });
    mgr.handle({
      type: 'patch.host_search.request',
      searchId: 's1',
      hostId: 'd1',
      root: dir,
      query: 'needle',
    });
    await waitForDone(frames);
    expect(matches(frames).length).toBeLessThanOrEqual(HOST_SEARCH_MAX_MATCHES);
    expect(done(frames)).toMatchObject({ ok: true, truncated: true });
  });

  it('falls back to a manual walk when rg is not on PATH', async () => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.ts'), 'const findMeToo = 1;\n');
    writeFileSync(join(dir, 'skip-me.bin'), Buffer.from([0x00, 0x01, 0x02]));
    const { frames, emit } = collector();
    const mgr = new HostSearchManager({ emit, logger });
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      mgr.handle({
        type: 'patch.host_search.request',
        searchId: 's1',
        hostId: 'd1',
        root: dir,
        query: 'findMeToo',
      });
      await waitForDone(frames);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(matches(frames)).toEqual([
      { path: 'sub/b.ts', line: 1, column: 7, preview: 'const findMeToo = 1;' },
    ]);
    expect(done(frames)).toMatchObject({ ok: true });
  });
});
