// Composer — annotating a pending image (spec/15 § Composer — attachments).
// A pencil on an image chip opens the annotator; Done swaps the annotated PNG
// in for the original, in the same place in the row.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import {
  findHost,
  queryHost,
  byLabel,
  byTestId,
  renderRN,
  actSync,
  actAsync,
  flush,
} from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useComposerAttachmentStore } from '../src/stores/composerAttachmentStore';
import { useUiStore } from '../src/stores/uiStore';
import { _resetSendQueue } from '../src/lib/sendQueue';

vi.mock('../src/lib/hookCheck', async (orig) => ({
  ...(await orig<typeof import('../src/lib/hookCheck')>()),
  checkHooks: async () => ({ decision: 'pass' as const, results: [] }),
}));
const { readSpy, writeSpy, uploadSpy, deleteSpy } = vi.hoisted(() => ({
  readSpy: vi.fn(),
  writeSpy: vi.fn(),
  uploadSpy: vi.fn(),
  deleteSpy: vi.fn(),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: uploadSpy,
    deleteAttachment: deleteSpy,
    detachAttachments: vi.fn().mockResolvedValue({ ok: true }),
  },
}));
vi.mock('expo-file-system', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  readAsStringAsync: readSpy,
  writeAsStringAsync: writeSpy,
}));

import { Composer } from '../src/components/Composer';

const IMG = {
  key: 'img-1',
  uri: 'file:///cache/shot.png',
  name: 'shot.png',
  mimeType: 'image/png',
  kind: 'image' as const,
};
const DOC = {
  key: 'doc-1',
  uri: 'file:///cache/notes.pdf',
  name: 'notes.pdf',
  mimeType: 'application/pdf',
  kind: 'file' as const,
};

// Attachments already uploaded to the chat's draft, as another attach would leave them.
const seed = (list: Array<typeof IMG | typeof DOC>): void =>
  useComposerAttachmentStore.setState({
    byKey: { c1: list.map((a) => ({ ...a, status: 'uploaded' as const })) },
  });

const names = (): string[] =>
  (useComposerAttachmentStore.getState().byKey['c1'] ?? []).map((a) => a.name);

const mounted: ReactTestRenderer[] = [];
function mount(): ReactTestRenderer {
  const r = renderRN(<Composer chatId="c1" folder="work" />);
  mounted.push(r);
  return r;
}

beforeEach(() => {
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useChatStore.getState()._reset();
  _resetSendQueue();
  useComposerAttachmentStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  uploadSpy
    .mockReset()
    .mockImplementation((chatId: string, f: { name: string; mimeType: string }) =>
      Promise.resolve({
        ok: true,
        ref: {
          id: `srv-${f.name}`,
          name: f.name,
          mimeType: f.mimeType,
          kind: 'image',
          url: `/api/chats/${chatId}/attachment/srv-${f.name}`,
        },
      }),
    );
  deleteSpy.mockReset().mockResolvedValue({ ok: true });
  readSpy.mockReset().mockResolvedValue('QUJD');
  writeSpy.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  actSync(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

describe('Composer — annotate pencil', () => {
  it('is offered on an image chip and not on a file chip', () => {
    actSync(() => seed([IMG, DOC]));
    const r = mount();
    expect(findHost(r.root, byLabel('Annotate shot.png'))).toBeTruthy();
    expect(queryHost(r.root, byLabel('Annotate notes.pdf'))).toBeNull();
  });

  it('opens the annotator on the chosen image', async () => {
    actSync(() => seed([DOC, IMG]));
    const r = mount();
    expect(queryHost(r.root, byTestId('image-annotator'))).toBeNull();
    await actAsync(async () => {
      findHost(r.root, byLabel('Annotate shot.png')).props['onPress']();
      await flush();
    });
    expect(queryHost(r.root, byTestId('annotator-webview'))).not.toBeNull();
    expect(readSpy).toHaveBeenCalledWith('file:///cache/shot.png', { encoding: 'base64' });
  });

  it('Done replaces the attachment in place with the annotated PNG', async () => {
    actSync(() => seed([DOC, IMG, { ...DOC, key: 'doc-2', name: 'b.pdf' }]));
    const r = mount();
    await actAsync(async () => {
      findHost(r.root, byLabel('Annotate shot.png')).props['onPress']();
      await flush();
    });
    await actAsync(async () => {
      (findHost(r.root, byTestId('annotator-webview')).props['onMessage'] as (e: unknown) => void)({
        nativeEvent: {
          data: JSON.stringify({
            type: 'done',
            png: 'data:image/png;base64,iVBORw0KGgo=',
            width: 9,
            height: 7,
          }),
        },
      });
      await flush();
    });
    expect(names()).toEqual(['notes.pdf', 'shot-annotated.png', 'b.pdf']);
    const next = useComposerAttachmentStore.getState().byKey['c1']![1]!;
    expect(next).toMatchObject({ mimeType: 'image/png', kind: 'image', width: 9, height: 7 });
    expect(next.key).not.toBe('img-1');
    expect(next.uri?.startsWith('file:///cache/')).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith('c1', 'img-1');
    // The chip re-renders as the annotated image, and the annotator has closed.
    expect(findHost(r.root, byLabel('Remove shot-annotated.png'))).toBeTruthy();
    expect(queryHost(r.root, byLabel('Remove shot.png'))).toBeNull();
    expect(queryHost(r.root, byTestId('image-annotator'))).toBeNull();
  });

  it('Cancel leaves the attachment untouched and closes the annotator', async () => {
    actSync(() => seed([IMG]));
    const r = mount();
    await actAsync(async () => {
      findHost(r.root, byLabel('Annotate shot.png')).props['onPress']();
      await flush();
    });
    await actAsync(async () => {
      (findHost(r.root, byTestId('annotator-webview')).props['onMessage'] as (e: unknown) => void)({
        nativeEvent: { data: '{"type":"cancel"}' },
      });
      await flush();
    });
    expect(names()).toEqual(['shot.png']);
    expect(queryHost(r.root, byTestId('image-annotator'))).toBeNull();
  });

  it('reports an annotation whose original was removed meanwhile', async () => {
    actSync(() => seed([IMG]));
    const r = mount();
    await actAsync(async () => {
      findHost(r.root, byLabel('Annotate shot.png')).props['onPress']();
      await flush();
    });
    actSync(() =>
      useComposerAttachmentStore.getState().remove('c1', { kind: 'chat', chatId: 'c1' }, 'img-1'),
    );
    await actAsync(async () => {
      (findHost(r.root, byTestId('annotator-webview')).props['onMessage'] as (e: unknown) => void)({
        nativeEvent: {
          data: JSON.stringify({
            type: 'done',
            png: 'data:image/png;base64,AA',
            width: 1,
            height: 1,
          }),
        },
      });
      await flush();
    });
    expect(names()).toEqual([]);
    expect(useUiStore.getState().errors.some((e) => /annotate failed/.test(e.message))).toBe(true);
  });
});

describe('Composer — sketch without a photo', () => {
  const sketchMsg = {
    nativeEvent: {
      data: JSON.stringify({
        type: 'done',
        png: 'data:image/png;base64,iVBORw0KGgo=',
        width: 1200,
        height: 1600,
      }),
    },
  };

  it('Sketch opens a blank annotator without reading any file', async () => {
    const r = mount();
    await actAsync(async () => {
      findHost(r.root, byLabel('Sketch')).props['onPress']();
      await flush();
    });
    const html = (
      findHost(r.root, byTestId('annotator-webview')).props['source'] as { html: string }
    ).html;
    expect(html).toContain('var IMAGE = null;');
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('Done attaches the drawing as a new sketch-*.png image chip', async () => {
    actSync(() => seed([DOC]));
    const r = mount();
    await actAsync(async () => {
      findHost(r.root, byLabel('Sketch')).props['onPress']();
      await flush();
    });
    await actAsync(async () => {
      (findHost(r.root, byTestId('annotator-webview')).props['onMessage'] as (e: unknown) => void)(
        sketchMsg,
      );
      await flush();
    });
    expect(names()).toHaveLength(2);
    expect(names()[0]).toBe('notes.pdf');
    expect(names()[1]).toMatch(/^sketch-\d+\.(png|jpg)$/);
    // The chip is the uploaded copy: the attach-time upload downscales an image,
    // so its type and name come from the server's ref, not from the PNG drawn.
    expect(useComposerAttachmentStore.getState().byKey['c1']![1]).toMatchObject({
      kind: 'image',
      width: 1200,
      height: 1600,
    });
    expect(queryHost(r.root, byTestId('image-annotator'))).toBeNull();
  });

  it('Cancel attaches nothing', async () => {
    const r = mount();
    await actAsync(async () => {
      findHost(r.root, byLabel('Sketch')).props['onPress']();
      await flush();
    });
    await actAsync(async () => {
      (findHost(r.root, byTestId('annotator-webview')).props['onMessage'] as (e: unknown) => void)({
        nativeEvent: { data: '{"type":"cancel"}' },
      });
      await flush();
    });
    expect(names()).toEqual([]);
    expect(queryHost(r.root, byTestId('image-annotator'))).toBeNull();
  });
});
