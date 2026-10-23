// A file attached to a draft must show as ONE chip even when the server's
// `attachments_changed` broadcast for it lands before the upload's own HTTP
// response does (spec/14 § Composer → Attachments).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useComposerAttachmentStore,
  waitForAttachmentUpload,
} from '../stores/composerAttachmentStore.js';
import { api } from '../api/rest.js';

const ref = {
  id: 'srv1',
  name: 'image.png',
  kind: 'image' as const,
  mimeType: 'image/png',
  url: '/api/chats/c1/attachment/srv1',
};

describe('composerAttachmentStore — echo racing the upload response', () => {
  beforeEach(() => {
    useComposerAttachmentStore.getState()._reset();
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
    globalThis.URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps one chip when the broadcast arrives before the upload resolves', async () => {
    let resolveUpload!: (v: { ok: true; ref: typeof ref }) => void;
    vi.spyOn(api, 'uploadAttachment').mockReturnValue(
      new Promise((r) => {
        resolveUpload = r as typeof resolveUpload;
      }),
    );
    const store = useComposerAttachmentStore;
    store
      .getState()
      .attach('c1', { kind: 'chat', chatId: 'c1' }, [
        new File(['x'], 'image.png', { type: 'text/plain' }),
      ]);
    const localKey = store.getState().byKey['c1']![0]!.key;
    // The server announces the file before the HTTP response comes back.
    store.getState().applyAttachmentsChanged('c1', [ref]);
    const settled = waitForAttachmentUpload('c1', localKey);
    resolveUpload({ ok: true, ref });
    await settled;
    const list = store.getState().byKey['c1'] ?? [];
    expect(list.map((a) => a.key)).toEqual(['srv1']);
  });
});
