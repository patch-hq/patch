import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DraftAttachmentStore, type DraftAttachmentsChange } from '../src/draft-attachments.js';

const REF = {
  id: 'a1',
  name: 'shot.png',
  mimeType: 'image/png',
  kind: 'image' as const,
  url: '/api/chats/c1/attachment/a1',
};

describe('DraftAttachmentStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-draft-att-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (nowMs?: () => number) =>
    new DraftAttachmentStore({
      fileName: 'att.json',
      dataDir: dir,
      ...(nowMs ? { nowMs } : {}),
    });

  it('holds the whole list per key and emits every set, stamped by the injected clock', () => {
    const store = make(() => 42);
    const seen: DraftAttachmentsChange[] = [];
    store.onChange((c) => seen.push(c));
    store.set('c1', [REF]);
    expect(store.get('c1')).toEqual([REF]);
    expect(store.list()).toEqual([{ key: 'c1', attachments: [REF], updatedAt: 42 }]);
    store.set('c1', []);
    expect(store.get('c1')).toEqual([]);
    expect(store.list()).toEqual([]);
    expect(seen).toEqual([
      { key: 'c1', attachments: [REF], updatedAt: 42 },
      { key: 'c1', attachments: [], updatedAt: 42 },
    ]);
  });

  it('survives a restart', () => {
    make().set('c1', [REF]);
    expect(make().get('c1')).toEqual([REF]);
  });

  it('a corrupt file is reported and the store starts empty', () => {
    writeFileSync(join(dir, 'att.json'), '{not json');
    const warns: unknown[] = [];
    const store = new DraftAttachmentStore({
      fileName: 'att.json',
      dataDir: dir,
      logger: { warn: (...a: unknown[]) => void warns.push(a) } as never,
    });
    expect(store.list()).toEqual([]);
    expect(warns).toHaveLength(1);
  });

  it('drops persisted entries that are not valid refs', () => {
    writeFileSync(
      join(dir, 'att.json'),
      JSON.stringify({
        good: { attachments: [REF], updatedAt: 1 },
        bad: { attachments: [{ id: 1 }], updatedAt: 1 },
      }),
    );
    expect(
      make()
        .list()
        .map((e) => e.key),
    ).toEqual(['good']);
  });

  it('works in memory with no dataDir', () => {
    const store = new DraftAttachmentStore({ fileName: 'att.json' });
    store.set('c1', [REF]);
    expect(store.get('c1')).toEqual([REF]);
  });
});
