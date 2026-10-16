// ImageAnnotatorModal (spec/15 § Composer — attachments): a full-screen modal
// around a WebView page that draws on the pending image. Done writes the
// flattened PNG to the cache and hands it back; bad messages are errors.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  byLabel,
  hasText,
  flush,
  actAsync,
  actSync,
} from './testUtils/render';
import { useUiStore } from '../src/stores/uiStore';

const { readSpy, writeSpy } = vi.hoisted(() => ({ readSpy: vi.fn(), writeSpy: vi.fn() }));
vi.mock('expo-file-system', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  readAsStringAsync: readSpy,
  writeAsStringAsync: writeSpy,
}));

import { ImageAnnotatorModal } from '../src/components/ImageAnnotatorModal';
import type { PendingAttachment } from '../src/stores/composerAttachmentStore';

const att: PendingAttachment = {
  key: 'k1',
  uri: 'file:///cache/shot.jpg',
  name: 'shot.jpg',
  mimeType: 'image/jpeg',
  kind: 'image',
};
const PNG_B64 = 'iVBORw0KGgo=';

const mounted: ReactTestRenderer[] = [];
let onDone: ReturnType<typeof vi.fn>;
let onCancel: ReturnType<typeof vi.fn>;

async function open(a: PendingAttachment | null = att): Promise<ReactTestRenderer> {
  const r = renderRN(<ImageAnnotatorModal attachment={a} onDone={onDone} onCancel={onCancel} />);
  mounted.push(r);
  await flush();
  return r;
}
const post = (r: ReactTestRenderer, data: unknown) =>
  actAsync(async () => {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    (findHost(r.root, byTestId('annotator-webview')).props['onMessage'] as (e: unknown) => void)({
      nativeEvent: { data: raw },
    });
    await flush();
  });

describe('ImageAnnotatorModal', () => {
  beforeEach(() => {
    readSpy.mockReset().mockResolvedValue('QUJD');
    writeSpy.mockReset().mockResolvedValue(undefined);
    onDone = vi.fn();
    onCancel = vi.fn();
    useUiStore.setState({ errors: [] });
  });
  afterEach(() => {
    actSync(() => {
      for (const r of mounted.splice(0)) r.unmount();
    });
  });

  it('renders nothing without an attachment', async () => {
    const r = await open(null);
    expect(queryHost(r.root, byTestId('annotator-webview'))).toBeNull();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('reads the image as base64 and loads it into the page', async () => {
    const r = await open();
    expect(readSpy).toHaveBeenCalledWith('file:///cache/shot.jpg', { encoding: 'base64' });
    const html = (
      findHost(r.root, byTestId('annotator-webview')).props['source'] as { html: string }
    ).html;
    expect(html).toContain('data:image/jpeg;base64,QUJD');
  });

  it('writes the posted PNG to the cache and hands back the annotated attachment', async () => {
    const r = await open();
    await post(r, { type: 'done', png: `data:image/png;base64,${PNG_B64}`, width: 40, height: 30 });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [uri, contents, opts] = writeSpy.mock.calls[0] as [string, string, { encoding: string }];
    expect(uri.startsWith('file:///cache/')).toBe(true);
    expect(uri.endsWith('.png')).toBe(true);
    expect(contents).toBe(PNG_B64);
    expect(opts).toEqual({ encoding: 'base64' });
    expect(onDone).toHaveBeenCalledWith({
      uri,
      name: 'shot-annotated.png',
      mimeType: 'image/png',
      width: 40,
      height: 30,
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('gives each annotated file its own cache path', async () => {
    const r = await open();
    const msg = { type: 'done', png: `data:image/png;base64,${PNG_B64}`, width: 1, height: 1 };
    await post(r, msg);
    await post(r, msg);
    expect(writeSpy.mock.calls[0]![0]).not.toBe(writeSpy.mock.calls[1]![0]);
  });

  it('cancel from the page calls onCancel and writes nothing', async () => {
    const r = await open();
    await post(r, { type: 'cancel' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('the system back gesture cancels', async () => {
    const r = await open();
    actSync(() => {
      (findHost(r.root, (i) => i.type === 'Modal').props['onRequestClose'] as () => void)();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not JSON', 'garbage', /not JSON/],
    ['an unknown type', { type: 'wat' }, /unknown message type/],
    ['a done with no PNG', { type: 'done', width: 1, height: 1 }, /no PNG/],
  ])('shows and reports a malformed message (%s)', async (_n, data, re) => {
    const r = await open();
    await post(r, data);
    expect(onDone).not.toHaveBeenCalled();
    const err = findHost(r.root, byTestId('annotator-error'));
    expect(String(err.props['children'])).toMatch(re);
    expect(useUiStore.getState().errors.some((e) => re.test(e.message))).toBe(true);
  });

  it('surfaces an error the page itself reports', async () => {
    const r = await open();
    await post(r, { type: 'error', message: 'the image could not be decoded' });
    expect(hasText(r.root, 'the image could not be decoded')).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('surfaces a failed read and offers Close', async () => {
    readSpy.mockRejectedValue(new Error('no such file'));
    const r = await open();
    expect(hasText(r.root, 'no such file')).toBe(true);
    expect(queryHost(r.root, byTestId('annotator-webview'))).toBeNull();
    actSync(() => {
      (findHost(r.root, byLabel('Close')).props['onPress'] as () => void)();
    });
    expect(onCancel).toHaveBeenCalled();
  });

  it('surfaces a failed write and does not call onDone', async () => {
    writeSpy.mockRejectedValue(new Error('disk full'));
    const r = await open();
    await post(r, { type: 'done', png: `data:image/png;base64,${PNG_B64}`, width: 1, height: 1 });
    expect(hasText(r.root, 'disk full')).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('a non-image attachment is an error, not a blank page', async () => {
    const r = await open({ ...att, mimeType: 'application/pdf' });
    expect(hasText(r.root, 'not an image')).toBe(true);
  });
});
