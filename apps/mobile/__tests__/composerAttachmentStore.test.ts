// stores/composerAttachmentStore.ts — draft attachments (step 3 of 3 —
// spec/14 & spec/15 § Composer → Attachments): a file attaches and uploads
// straight away, keyed by draft key, so the share sheet can put files into
// one (spec/15 § Share into Patch) and so the composer's own chips sync
// cross-surface.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  uploadAttachmentSpy,
  uploadNewChatDraftAttachmentSpy,
  deleteAttachmentSpy,
  deleteNewChatDraftAttachmentSpy,
  detachAttachmentsSpy,
} = vi.hoisted(() => ({
  uploadAttachmentSpy: vi.fn(),
  uploadNewChatDraftAttachmentSpy: vi.fn(),
  deleteAttachmentSpy: vi.fn(),
  deleteNewChatDraftAttachmentSpy: vi.fn(),
  detachAttachmentsSpy: vi.fn(),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    uploadAttachment: uploadAttachmentSpy,
    uploadNewChatDraftAttachment: uploadNewChatDraftAttachmentSpy,
    deleteAttachment: deleteAttachmentSpy,
    deleteNewChatDraftAttachment: deleteNewChatDraftAttachmentSpy,
    detachAttachments: detachAttachmentsSpy,
  },
}));

import {
  NO_ATTACHMENTS,
  attachmentKindForMime,
  newAttachmentKey,
  useComposerAttachmentStore,
  waitForAttachmentUpload,
} from '../src/stores/composerAttachmentStore';

const file = (name: string, mimeType = 'text/plain') => ({
  uri: `file:///${name}`,
  name,
  mimeType,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useComposerAttachmentStore.getState()._reset();
  uploadAttachmentSpy.mockReset();
  uploadNewChatDraftAttachmentSpy.mockReset();
  deleteAttachmentSpy.mockReset().mockResolvedValue({ ok: true });
  deleteNewChatDraftAttachmentSpy.mockReset().mockResolvedValue({ ok: true });
  detachAttachmentsSpy.mockReset().mockResolvedValue({ ok: true });
});

describe('composerAttachmentStore', () => {
  it('the empty list is one stable reference', () => {
    expect(NO_ATTACHMENTS).toEqual([]);
  });

  it('keys are unique; kinds follow the MIME type', () => {
    expect(newAttachmentKey()).not.toBe(newAttachmentKey());
    expect(attachmentKindForMime('IMAGE/PNG')).toBe('image');
    expect(attachmentKindForMime('application/pdf')).toBe('file');
  });

  it('attach adds an "uploading" entry synchronously, then resolves to "uploaded"', async () => {
    uploadAttachmentSpy.mockResolvedValue({
      ok: true,
      ref: { id: 'srv-1', name: 'a.txt', mimeType: 'text/plain', kind: 'file', url: '/x' },
    });
    const s = useComposerAttachmentStore.getState();
    s.attach('c1', { kind: 'chat', chatId: 'c1' }, [file('a.txt')]);
    const entries = useComposerAttachmentStore.getState().byKey['c1']!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe('uploading');
    await flush();
    const settled = useComposerAttachmentStore.getState().byKey['c1']![0]!;
    expect(settled.status).toBe('uploaded');
    expect(settled.key).toBe('srv-1');
    expect(uploadAttachmentSpy).toHaveBeenCalledWith('c1', file('a.txt'));
  });

  it('a failed upload flips the entry to "failed" and keeps the local uri for Retry', async () => {
    uploadAttachmentSpy.mockRejectedValue(new Error('disk full'));
    useComposerAttachmentStore
      .getState()
      .attach('c1', { kind: 'chat', chatId: 'c1' }, [file('a.txt')]);
    await flush();
    const entry = useComposerAttachmentStore.getState().byKey['c1']![0]!;
    expect(entry.status).toBe('failed');
    expect(entry.uri).toBe('file:///a.txt');
  });

  it('retry re-uploads the same file and resolves', async () => {
    uploadAttachmentSpy.mockRejectedValueOnce(new Error('boom'));
    useComposerAttachmentStore
      .getState()
      .attach('c1', { kind: 'chat', chatId: 'c1' }, [file('a.txt')]);
    await flush();
    const key = useComposerAttachmentStore.getState().byKey['c1']![0]!.key;
    uploadAttachmentSpy.mockResolvedValueOnce({
      ok: true,
      ref: { id: 'srv-2', name: 'a.txt', mimeType: 'text/plain', kind: 'file', url: '/x' },
    });
    useComposerAttachmentStore.getState().retry('c1', { kind: 'chat', chatId: 'c1' }, key);
    expect(useComposerAttachmentStore.getState().byKey['c1']![0]!.status).toBe('uploading');
    await flush();
    expect(useComposerAttachmentStore.getState().byKey['c1']![0]!.status).toBe('uploaded');
    expect(uploadAttachmentSpy).toHaveBeenCalledTimes(2);
  });

  it('remove DELETEs an uploaded entry and drops the chip; a still-uploading one is dropped without a DELETE', async () => {
    uploadAttachmentSpy.mockResolvedValue({
      ok: true,
      ref: { id: 'srv-1', name: 'a.txt', mimeType: 'text/plain', kind: 'file', url: '/x' },
    });
    const s = useComposerAttachmentStore.getState();
    s.attach('c1', { kind: 'chat', chatId: 'c1' }, [file('a.txt')]);
    await flush();
    const key = useComposerAttachmentStore.getState().byKey['c1']![0]!.key;
    s.remove('c1', { kind: 'chat', chatId: 'c1' }, key);
    expect(useComposerAttachmentStore.getState().byKey['c1']).toBeUndefined();
    await flush();
    expect(deleteAttachmentSpy).toHaveBeenCalledWith('c1', key);
  });

  it('remove on a still-uploading entry never calls DELETE (nothing server-side to remove yet)', () => {
    uploadAttachmentSpy.mockReturnValue(new Promise(() => {}));
    const s = useComposerAttachmentStore.getState();
    s.attach('c1', { kind: 'chat', chatId: 'c1' }, [file('a.txt')]);
    const key = useComposerAttachmentStore.getState().byKey['c1']![0]!.key;
    s.remove('c1', { kind: 'chat', chatId: 'c1' }, key);
    expect(deleteAttachmentSpy).not.toHaveBeenCalled();
  });

  it('a new-chat-draft target uploads/removes through the draft-scoped api calls', async () => {
    uploadNewChatDraftAttachmentSpy.mockResolvedValue({
      ok: true,
      ref: { id: 'srv-1', name: 'a.txt', mimeType: 'text/plain', kind: 'file', url: '/x' },
    });
    const s = useComposerAttachmentStore.getState();
    s.attach('draft-1', { kind: 'new-chat-draft', draftId: 'draft-1' }, [file('a.txt')]);
    await flush();
    expect(uploadNewChatDraftAttachmentSpy).toHaveBeenCalledWith('draft-1', file('a.txt'));
    const key = useComposerAttachmentStore.getState().byKey['draft-1']![0]!.key;
    s.remove('draft-1', { kind: 'new-chat-draft', draftId: 'draft-1' }, key);
    await flush();
    expect(deleteNewChatDraftAttachmentSpy).toHaveBeenCalledWith('draft-1', key);
  });

  it('detachAll drops every entry for a key WITHOUT deleting server-side (bookkeeping only)', async () => {
    uploadAttachmentSpy.mockResolvedValue({
      ok: true,
      ref: { id: 'srv-1', name: 'a.txt', mimeType: 'text/plain', kind: 'file', url: '/x' },
    });
    useComposerAttachmentStore
      .getState()
      .attach('c1', { kind: 'chat', chatId: 'c1' }, [file('a.txt')]);
    await flush();
    const removed = useComposerAttachmentStore.getState().detachAll('c1');
    expect(removed).toHaveLength(1);
    expect(useComposerAttachmentStore.getState().byKey['c1']).toBeUndefined();
    expect(deleteAttachmentSpy).not.toHaveBeenCalled();
  });

  it('applyList seeds the account-wide snapshot as uploaded entries', () => {
    useComposerAttachmentStore.getState().applyList([
      {
        draftKey: 'c1',
        attachments: [{ id: 'r1', name: 'a.txt', mimeType: 'text/plain', kind: 'file', url: '/x' }],
      },
    ]);
    expect(useComposerAttachmentStore.getState().byKey['c1']).toEqual([
      {
        key: 'r1',
        name: 'a.txt',
        mimeType: 'text/plain',
        kind: 'file',
        url: '/x',
        status: 'uploaded',
      },
    ]);
  });

  it('applyAttachmentsChanged reconciles: drops a remotely-removed entry, adds one another surface attached', async () => {
    uploadAttachmentSpy.mockResolvedValue({
      ok: true,
      ref: { id: 'srv-1', name: 'a.txt', mimeType: 'text/plain', kind: 'file', url: '/x' },
    });
    useComposerAttachmentStore
      .getState()
      .attach('c1', { kind: 'chat', chatId: 'c1' }, [file('a.txt')]);
    await flush();
    // Another surface's broadcast: this one gone, a new one from elsewhere.
    useComposerAttachmentStore
      .getState()
      .applyAttachmentsChanged('c1', [
        { id: 'other-1', name: 'b.txt', mimeType: 'text/plain', kind: 'file', url: '/y' },
      ]);
    expect(useComposerAttachmentStore.getState().byKey['c1']).toEqual([
      {
        key: 'other-1',
        name: 'b.txt',
        mimeType: 'text/plain',
        kind: 'file',
        url: '/y',
        status: 'uploaded',
      },
    ]);
  });

  it('applyAttachmentsChanged leaves a still-uploading LOCAL entry alone (it has no server id to match against yet)', () => {
    uploadAttachmentSpy.mockReturnValue(new Promise(() => {}));
    useComposerAttachmentStore
      .getState()
      .attach('c1', { kind: 'chat', chatId: 'c1' }, [file('a.txt')]);
    useComposerAttachmentStore.getState().applyAttachmentsChanged('c1', []);
    expect(useComposerAttachmentStore.getState().byKey['c1']).toHaveLength(1);
    expect(useComposerAttachmentStore.getState().byKey['c1']![0]!.status).toBe('uploading');
  });

  it('waitForAttachmentUpload resolves to the settled entry once the in-flight upload lands', async () => {
    let resolveUpload!: (v: {
      ok: true;
      ref: { id: string; name: string; mimeType: string; kind: 'file'; url: string };
    }) => void;
    uploadAttachmentSpy.mockReturnValue(new Promise((r) => (resolveUpload = r)));
    useComposerAttachmentStore
      .getState()
      .attach('c1', { kind: 'chat', chatId: 'c1' }, [file('a.txt')]);
    const key = useComposerAttachmentStore.getState().byKey['c1']![0]!.key;
    const waiter = waitForAttachmentUpload('c1', key);
    resolveUpload({
      ok: true,
      ref: { id: 'srv-1', name: 'a.txt', mimeType: 'text/plain', kind: 'file', url: '/x' },
    });
    const settled = await waiter;
    expect(settled?.status).toBe('uploaded');
    expect(settled?.key).toBe('srv-1');
  });

  it('waitForAttachmentUpload resolves to undefined for a key with nothing in flight', async () => {
    await expect(waitForAttachmentUpload('c1', 'never-attached')).resolves.toBeUndefined();
  });
});

describe('composerAttachmentStore.replace', () => {
  const CHAT = { kind: 'chat' as const, chatId: 'c1' };
  const seed = (keys: string[], status: 'uploaded' | 'failed' = 'uploaded'): void =>
    useComposerAttachmentStore.setState({
      byKey: {
        c1: keys.map((key) => ({
          key,
          uri: `file:///${key}`,
          name: key,
          mimeType: 'image/png',
          kind: 'image' as const,
          status,
        })),
      },
    });

  it('swaps one attachment for a new uploading one, keeping its position', () => {
    uploadAttachmentSpy.mockReturnValue(new Promise(() => {}));
    seed(['a', 'b', 'c']);
    useComposerAttachmentStore
      .getState()
      .replace('c1', CHAT, 'b', { ...file('b-annotated.png', 'image/png'), width: 9, height: 7 });
    const list = useComposerAttachmentStore.getState().byKey['c1']!;
    expect(list.map((a) => a.name)).toEqual(['a', 'b-annotated.png', 'c']);
    expect(list[1]).toMatchObject({ status: 'uploading', width: 9, height: 7 });
    expect(list[1]!.key).not.toBe('b');
  });

  it('deletes the replaced file server-side when it had been uploaded', () => {
    uploadAttachmentSpy.mockReturnValue(new Promise(() => {}));
    seed(['a']);
    useComposerAttachmentStore.getState().replace('c1', CHAT, 'a', file('a2.png', 'image/png'));
    expect(deleteAttachmentSpy).toHaveBeenCalledWith('c1', 'a');
  });

  it('does not call the server to delete a replaced file that never uploaded', () => {
    uploadAttachmentSpy.mockReturnValue(new Promise(() => {}));
    seed(['a'], 'failed');
    useComposerAttachmentStore.getState().replace('c1', CHAT, 'a', file('a2.png', 'image/png'));
    expect(deleteAttachmentSpy).not.toHaveBeenCalled();
  });

  it('throws when the attachment is gone (removed while the editor was open)', () => {
    seed(['a']);
    const s = useComposerAttachmentStore.getState();
    expect(() => s.replace('c1', CHAT, 'zzz', file('n.png'))).toThrow(/no attachment zzz/);
    expect(() => s.replace('nokey', CHAT, 'a', file('n.png'))).toThrow(/no attachment a/);
  });
});

describe('composerAttachmentStore.detach', () => {
  const CHAT = { kind: 'chat' as const, chatId: 'c1' };
  const landed = {
    ok: true,
    ref: { id: 'srv-1', name: 'a.txt', mimeType: 'text/plain', kind: 'file', url: '/x' },
  };

  it('removes only the named entries, so a file attached since stays', () => {
    uploadAttachmentSpy.mockReturnValue(new Promise(() => {}));
    const s = useComposerAttachmentStore.getState();
    s.attach('c1', CHAT, [file('sent.txt'), file('later.txt')]);
    const [sent] = useComposerAttachmentStore.getState().byKey['c1']!;
    s.detach('c1', [sent!.key]);
    expect(useComposerAttachmentStore.getState().byKey['c1']?.map((a) => a.name)).toEqual([
      'later.txt',
    ]);
  });

  it('a file sent while uploading leaves the draft listing once it lands, and is never deleted', async () => {
    let resolveUpload!: (v: unknown) => void;
    uploadAttachmentSpy.mockReturnValue(new Promise((r) => (resolveUpload = r)));
    const s = useComposerAttachmentStore.getState();
    s.attach('c1', CHAT, [file('a.txt')]);
    const key = useComposerAttachmentStore.getState().byKey['c1']![0]!.key;
    s.detach('c1', [key]);
    resolveUpload(landed);
    await flush();
    expect(detachAttachmentsSpy).toHaveBeenCalledWith('c1', ['srv-1']);
    expect(deleteAttachmentSpy).not.toHaveBeenCalled();
  });

  it('a file removed while uploading is deleted once it lands', async () => {
    let resolveUpload!: (v: unknown) => void;
    uploadAttachmentSpy.mockReturnValue(new Promise((r) => (resolveUpload = r)));
    const s = useComposerAttachmentStore.getState();
    s.attach('c1', CHAT, [file('a.txt')]);
    const key = useComposerAttachmentStore.getState().byKey['c1']![0]!.key;
    s.remove('c1', CHAT, key);
    resolveUpload(landed);
    await flush();
    expect(deleteAttachmentSpy).toHaveBeenCalledWith('c1', 'srv-1');
    expect(detachAttachmentsSpy).not.toHaveBeenCalled();
  });
  it('keeps one chip when the server broadcast lands before the upload response', async () => {
    const ref = { id: 'srv-1', name: 'a.txt', mimeType: 'text/plain', kind: 'file', url: '/x' };
    let resolveUpload!: (v: unknown) => void;
    uploadAttachmentSpy.mockReturnValue(new Promise((r) => (resolveUpload = r)));
    const store = useComposerAttachmentStore;
    store.getState().attach('c1', { kind: 'chat', chatId: 'c1' }, [file('a.txt')]);
    const localKey = store.getState().byKey['c1']![0]!.key;
    store.getState().applyAttachmentsChanged('c1', [ref] as never);
    const settled = waitForAttachmentUpload('c1', localKey);
    resolveUpload({ ok: true, ref });
    await settled;
    await flush();
    expect(store.getState().byKey['c1']!.map((a) => a.key)).toEqual(['srv-1']);
  });
});
