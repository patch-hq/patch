// Document editor screen (spec/14 § Document editor, spec/15 § Document
// editor): the file verbatim in a monospace text area, an explicit Save that
// refuses to overwrite a changed file, mode + panels, ask-about-this, comment,
// export, and Word import.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import type { DocView } from '@patch/wire';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  hasText,
  flush,
  actSync,
  actAsync,
} from './testUtils/render';
import ChatDoc from '../app/chats/[chatId]/doc';
import { routerMock, __resetRouterMock, __setLocalSearchParams } from './stubs/expo-router';
import { __clearLastAlert, __getLastAlert, __pressBack } from './stubs/react-native';

const h = vi.hoisted(() => ({
  read: vi.fn(),
  getDoc: vi.fn(),
  docAction: vi.fn(),
  convert: vi.fn(),
  exportDoc: vi.fn(),
  write: vi.fn(),
  confirm: vi.fn(),
  saveExport: vi.fn(),
  getDraft: vi.fn(),
  setDraft: vi.fn(),
}));
vi.mock('../src/api/rest', async (orig) => ({
  ...(await orig<typeof import('../src/api/rest')>()),
  api: {
    chatFileRead: h.read,
    getDoc: h.getDoc,
    docAction: h.docAction,
    convertDocx: h.convert,
    exportDoc: h.exportDoc,
  },
}));
vi.mock('../src/lib/chatFileWrite', () => ({
  writeChatFile: h.write,
  confirmWritten: h.confirm,
}));
vi.mock('../src/lib/docExport', () => ({ saveExport: h.saveExport }));
vi.mock('../src/lib/composerDraft', () => ({
  getComposerDraft: h.getDraft,
  setComposerDraft: h.setDraft,
}));

const view = (over: Partial<DocView> = {}): DocView => ({
  mode: 'change',
  suggestions: [],
  threads: [],
  versions: [],
  ...over,
});
// Frontmatter, CRLF, trailing spaces and a missing final newline: all of it
// must survive a load and a save untouched.
const RAW = '---\r\ntitle: x\r\n---\r\n\r\nHello world  \r\n\t- tab\r\nend';

const mounted: ReactTestRenderer[] = [];
async function open(): Promise<ReactTestRenderer> {
  const r = renderRN(<ChatDoc />);
  mounted.push(r);
  await flush();
  return r;
}
const text = (r: ReactTestRenderer) => findHost(r.root, byTestId('doc-text'));
const type = (r: ReactTestRenderer, t: string): void =>
  actSync(() => {
    (text(r).props['onChangeText'] as (t: string) => void)(t);
  });
const select = (r: ReactTestRenderer, start: number, end: number): void =>
  actSync(() => {
    (text(r).props['onSelectionChange'] as (e: unknown) => void)({
      nativeEvent: { selection: { start, end } },
    });
  });
const press = (r: ReactTestRenderer, id: string) =>
  actAsync(async () => {
    (findHost(r.root, byTestId(id)).props['onPress'] as () => void)();
    await flush();
  });
const typeInto = (r: ReactTestRenderer, id: string, t: string): void =>
  actSync(() => {
    (findHost(r.root, byTestId(id)).props['onChangeText'] as (t: string) => void)(t);
  });

beforeEach(() => {
  __resetRouterMock();
  __clearLastAlert();
  for (const f of Object.values(h)) f.mockReset();
  __setLocalSearchParams({ chatId: 'c1', path: 'docs/plan.md' });
  h.read.mockResolvedValue({ path: 'docs/plan.md', content: RAW, size: RAW.length });
  h.getDoc.mockResolvedValue(view());
  h.confirm.mockResolvedValue(true);
  h.getDraft.mockReturnValue('');
});
afterEach(() => {
  actSync(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

describe('loading', () => {
  it('shows the file byte for byte in a monospace, no-autocorrect text area', async () => {
    const r = renderRN(<ChatDoc />);
    mounted.push(r);
    expect(queryHost(r.root, byTestId('doc-loading'))).not.toBeNull();
    await flush();
    expect(h.read).toHaveBeenCalledWith('c1', 'docs/plan.md');
    expect(h.getDoc).toHaveBeenCalledWith('c1', 'docs/plan.md');
    const p = text(r).props;
    expect(p['value']).toBe(RAW);
    expect(p['multiline']).toBe(true);
    expect(p['autoCorrect']).toBe(false);
    expect(p['autoCapitalize']).toBe('none');
    expect(hasText(r.root, 'plan.md')).toBe(true);
  });

  it('a load failure shows the reason and Retry loads again', async () => {
    h.read.mockRejectedValueOnce(new Error('not_found: no such file'));
    const r = await open();
    expect(hasText(r.root, 'not_found: no such file')).toBe(true);
    expect(queryHost(r.root, byTestId('doc-text'))).toBeNull();
    await press(r, 'doc-retry');
    expect(text(r).props['value']).toBe(RAW);
    expect(queryHost(r.root, byTestId('doc-error'))).toBeNull();
  });

  it('a failing doc view is a load failure too', async () => {
    h.getDoc.mockRejectedValueOnce(new Error('daemon_timeout'));
    const r = await open();
    expect(hasText(r.root, 'daemon_timeout')).toBe(true);
  });

  it('refuses a file that is not a document', async () => {
    __setLocalSearchParams({ chatId: 'c1', path: 'a.png' });
    const r = await open();
    expect(hasText(r.root, 'not a document')).toBe(true);
    expect(h.read).not.toHaveBeenCalled();
  });
});

describe('saving', () => {
  it('Save is off until something changes; a dot marks unsaved changes', async () => {
    const r = await open();
    expect(findHost(r.root, byTestId('doc-save')).props['disabled']).toBe(true);
    type(r, RAW + 'x');
    expect(findHost(r.root, byTestId('doc-save')).props['disabled']).toBe(false);
    expect(hasText(r.root, 'plan.md ●')).toBe(true);
    type(r, RAW);
    expect(findHost(r.root, byTestId('doc-save')).props['disabled']).toBe(true);
  });

  it('writes exactly what was typed (no trimming), confirms it, and is clean after', async () => {
    const r = await open();
    const next = RAW + '\r\nmore   \r\n';
    type(r, next);
    h.read.mockResolvedValue({ path: 'docs/plan.md', content: RAW, size: 1 });
    await press(r, 'doc-save');
    expect(h.write).toHaveBeenCalledWith('c1', 'docs/plan.md', next);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0]![1]).toBe(next);
    expect(findHost(r.root, byTestId('doc-save')).props['disabled']).toBe(true);
    expect(hasText(r.root, '●')).toBe(false);
    expect(text(r).props['value']).toBe(next);
    // History changed on the host: the view is read again.
    expect(h.getDoc).toHaveBeenCalledTimes(2);
  });

  it('an untouched file is never written back', async () => {
    const r = await open();
    expect(findHost(r.root, byTestId('doc-save')).props['disabled']).toBe(true);
    expect(h.write).not.toHaveBeenCalled();
  });

  it('a file changed on disk is not overwritten; Reload takes the disk version', async () => {
    const r = await open();
    type(r, 'my edit');
    h.read.mockResolvedValue({ path: 'docs/plan.md', content: 'agent edit', size: 10 });
    await press(r, 'doc-save');
    const alert = __getLastAlert();
    expect(alert?.title).toBe('Changed on disk');
    expect(h.write).not.toHaveBeenCalled();
    expect(hasText(r.root, 'plan.md ●')).toBe(true);
    await actAsync(async () => {
      alert?.buttons?.find((b) => b.text === 'Reload')?.onPress?.();
      await flush();
    });
    expect(text(r).props['value']).toBe('agent edit');
    expect(findHost(r.root, byTestId('doc-save')).props['disabled']).toBe(true);
  });

  it('saves when the disk already holds exactly the draft', async () => {
    const r = await open();
    type(r, 'same');
    h.read.mockResolvedValue({ path: 'docs/plan.md', content: 'same', size: 4 });
    await press(r, 'doc-save');
    expect(h.write).toHaveBeenCalledWith('c1', 'docs/plan.md', 'same');
  });

  it('a write that never lands is reported and the edits are kept', async () => {
    h.confirm.mockResolvedValue(false);
    const r = await open();
    type(r, 'my edit');
    await press(r, 'doc-save');
    expect(__getLastAlert()?.title).toBe('Save not confirmed');
    expect(hasText(r.root, 'plan.md ●')).toBe(true);
  });

  it('a send failure is reported with its reason', async () => {
    h.write.mockImplementationOnce(() => {
      throw new Error('PatchWs: not connected');
    });
    const r = await open();
    type(r, 'my edit');
    await press(r, 'doc-save');
    expect(__getLastAlert()).toMatchObject({
      title: 'Save failed',
      message: 'PatchWs: not connected',
    });
    expect(hasText(r.root, 'plan.md ●')).toBe(true);
  });
});

describe('leaving', () => {
  it('a clean back just goes back', async () => {
    const r = await open();
    actSync(() => (findHost(r.root, byTestId('host-tool-back')).props['onPress'] as () => void)());
    expect(routerMock.back).toHaveBeenCalled();
    expect(__getLastAlert()).toBeNull();
  });

  it('back with unsaved edits asks first, for the header and the system gesture alike', async () => {
    const r = await open();
    type(r, 'edit');
    actSync(() => {
      __pressBack();
    });
    expect(routerMock.back).not.toHaveBeenCalled();
    const alert = __getLastAlert();
    expect(alert?.title).toBe('Discard changes?');
    actSync(() => alert?.buttons?.find((b) => b.text === 'Discard')?.onPress?.());
    expect(routerMock.back).toHaveBeenCalled();
  });
});

describe('mode', () => {
  it('changing the mode sends set_mode and shows the host answer', async () => {
    h.docAction.mockResolvedValue(view({ mode: 'propose' }));
    const r = await open();
    await press(r, 'doc-mode-select');
    await press(r, 'doc-mode-select-option-propose');
    expect(h.docAction).toHaveBeenCalledWith('c1', 'docs/plan.md', {
      op: 'set_mode',
      mode: 'propose',
    });
    expect(hasText(r.root, 'Propose')).toBe(true);
  });

  it('a refused action is reported and the view stays as it was', async () => {
    h.docAction.mockRejectedValue(new Error('conflict: moved'));
    const r = await open();
    await press(r, 'doc-mode-select');
    await press(r, 'doc-mode-select-option-comment');
    expect(__getLastAlert()).toMatchObject({ title: 'Action failed', message: 'conflict: moved' });
    expect(hasText(r.root, 'Change')).toBe(true);
  });
});

describe('panels', () => {
  const sugView = view({
    suggestions: [{ id: 's1', find: 'Hello', replace: 'Hi', status: 'pending', createdAt: 1 }],
    threads: [
      {
        id: 't1',
        anchor: 'world',
        resolved: false,
        comments: [{ id: 'c', author: 'agent', text: 'hm', createdAt: 1 }],
      },
    ],
    versions: [{ id: 'v1', content: 'old', savedBy: 'user', createdAt: 1 }],
  });

  it('a toggle swaps the editor for the panel and a second tap swaps back', async () => {
    h.getDoc.mockResolvedValue(sugView);
    const r = await open();
    await press(r, 'doc-toggle-suggestions');
    expect(queryHost(r.root, byTestId('doc-text'))).toBeNull();
    expect(queryHost(r.root, byTestId('doc-suggestions-panel'))).not.toBeNull();
    await press(r, 'doc-toggle-comments');
    expect(queryHost(r.root, byTestId('doc-comments-panel'))).not.toBeNull();
    await press(r, 'doc-toggle-history');
    expect(queryHost(r.root, byTestId('doc-history-panel'))).not.toBeNull();
    await press(r, 'doc-toggle-history');
    expect(text(r).props['value']).toBe(RAW);
  });

  it('keeps unsaved edits while a panel is showing', async () => {
    h.getDoc.mockResolvedValue(sugView);
    const r = await open();
    type(r, 'draft in progress');
    await press(r, 'doc-toggle-comments');
    await press(r, 'doc-toggle-comments');
    expect(text(r).props['value']).toBe('draft in progress');
  });

  it('accepting a suggestion dispatches it and reloads the text it changed', async () => {
    h.getDoc.mockResolvedValue(sugView);
    h.docAction.mockResolvedValue(view());
    const r = await open();
    await press(r, 'doc-toggle-suggestions');
    h.read.mockResolvedValue({ path: 'docs/plan.md', content: 'Hi world', size: 8 });
    await press(r, 'doc-suggestion-accept-s1');
    expect(h.docAction).toHaveBeenCalledWith('c1', 'docs/plan.md', {
      op: 'accept_suggestion',
      id: 's1',
    });
    await press(r, 'doc-toggle-suggestions');
    expect(text(r).props['value']).toBe('Hi world');
    expect(hasText(r.root, '●')).toBe(false);
  });

  it('restoring a version over unsaved edits keeps the edits and flags the conflict on Save', async () => {
    h.getDoc.mockResolvedValue(sugView);
    h.docAction.mockResolvedValue(sugView);
    const r = await open();
    type(r, 'my edit');
    await press(r, 'doc-toggle-history');
    await press(r, 'doc-history-row-v1');
    h.read.mockResolvedValue({ path: 'docs/plan.md', content: 'old', size: 3 });
    await press(r, 'doc-history-restore');
    expect(h.docAction).toHaveBeenCalledWith('c1', 'docs/plan.md', {
      op: 'restore_version',
      versionId: 'v1',
    });
    await press(r, 'doc-toggle-history');
    expect(text(r).props['value']).toBe('my edit');
    await press(r, 'doc-save');
    expect(__getLastAlert()?.title).toBe('Changed on disk');
  });

  it('a non-text action (reply) does not re-read the file', async () => {
    h.getDoc.mockResolvedValue(sugView);
    h.docAction.mockResolvedValue(sugView);
    const r = await open();
    await press(r, 'doc-toggle-comments');
    const reads = h.read.mock.calls.length;
    await press(r, 'doc-thread-resolve-t1');
    expect(h.docAction).toHaveBeenCalledWith('c1', 'docs/plan.md', {
      op: 'resolve_comment',
      threadId: 't1',
      resolved: true,
    });
    expect(h.read.mock.calls.length).toBe(reads);
  });
});

describe('selection', () => {
  it('offers Ask and Comment only for a real selection', async () => {
    const r = await open();
    expect(queryHost(r.root, byTestId('doc-ask'))).toBeNull();
    select(r, 3, 3);
    expect(queryHost(r.root, byTestId('doc-ask'))).toBeNull();
    select(r, 0, 3);
    expect(queryHost(r.root, byTestId('doc-ask'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('doc-comment'))).not.toBeNull();
  });

  it('Ask about this quotes the selection into the chat draft and goes to the chat', async () => {
    h.getDraft.mockReturnValue('why is');
    __setLocalSearchParams({ chatId: 'c1', path: 'docs/plan.md' });
    h.read.mockResolvedValue({
      path: 'docs/plan.md',
      content: 'line one\nline two\nthree',
      size: 1,
    });
    const r = await open();
    select(r, 5, 17);
    await press(r, 'doc-ask');
    expect(h.setDraft).toHaveBeenCalledWith('c1', '> one\n> line two\n\nwhy is');
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c1');
  });

  it('Ask about this with unsaved edits asks before leaving, and does not touch the draft yet', async () => {
    const r = await open();
    type(r, 'hello there');
    select(r, 0, 5);
    await press(r, 'doc-ask');
    expect(__getLastAlert()?.title).toBe('Discard changes?');
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('Comment opens a form and submitting anchors a thread on the selection', async () => {
    h.docAction.mockResolvedValue(view());
    const r = await open();
    select(r, 0, 3);
    await press(r, 'doc-comment');
    expect(queryHost(r.root, byTestId('doc-ask'))).toBeNull();
    await press(r, 'doc-comment-submit');
    expect(h.docAction).not.toHaveBeenCalled();
    typeInto(r, 'doc-comment-input', 'is this right?');
    await press(r, 'doc-comment-submit');
    expect(h.docAction).toHaveBeenCalledWith('c1', 'docs/plan.md', {
      op: 'add_comment',
      anchor: '---',
      text: 'is this right?',
    });
    expect(queryHost(r.root, byTestId('doc-comments-panel'))).not.toBeNull();
  });

  it('Cancel closes the comment form without sending', async () => {
    const r = await open();
    select(r, 0, 3);
    await press(r, 'doc-comment');
    await press(r, 'doc-comment-cancel');
    expect(queryHost(r.root, byTestId('doc-comment-input'))).toBeNull();
    expect(h.docAction).not.toHaveBeenCalled();
  });
});

describe('export', () => {
  beforeEach(() => {
    h.exportDoc.mockResolvedValue({ base64: 'QUJD', filename: 'plan.docx', warnings: [] });
    h.saveExport.mockResolvedValue({ status: 'saved', uri: 'content://x' });
  });

  it('exports the chosen format and saves the bytes', async () => {
    const r = await open();
    await press(r, 'doc-export');
    await press(r, 'doc-export-docx');
    expect(h.exportDoc).toHaveBeenCalledWith('c1', 'docs/plan.md', 'docx');
    expect(h.saveExport).toHaveBeenCalledWith({
      base64: 'QUJD',
      filename: 'plan.docx',
      format: 'docx',
    });
    expect(hasText(r.root, 'Saved plan.docx')).toBe(true);
  });

  it('offers docx, pdf and md', async () => {
    const r = await open();
    await press(r, 'doc-export');
    for (const f of ['docx', 'pdf', 'md']) {
      expect(queryHost(r.root, byTestId(`doc-export-${f}`))).not.toBeNull();
    }
  });

  it('names images the export could not embed', async () => {
    h.exportDoc.mockResolvedValue({
      base64: 'x',
      filename: 'plan.pdf',
      warnings: ['img.png missing'],
    });
    const r = await open();
    await press(r, 'doc-export');
    await press(r, 'doc-export-pdf');
    expect(hasText(r.root, 'img.png missing')).toBe(true);
  });

  it('a cancelled folder pick says nothing was saved', async () => {
    h.saveExport.mockResolvedValue({ status: 'cancelled' });
    const r = await open();
    await press(r, 'doc-export');
    await press(r, 'doc-export-md');
    expect(hasText(r.root, 'Saved')).toBe(false);
  });

  it('a failed export is reported', async () => {
    h.exportDoc.mockRejectedValue(new Error('browser_missing: no chromium'));
    const r = await open();
    await press(r, 'doc-export');
    await press(r, 'doc-export-pdf');
    expect(__getLastAlert()).toMatchObject({
      title: 'Export failed',
      message: 'browser_missing: no chromium',
    });
    expect(h.saveExport).not.toHaveBeenCalled();
  });

  it('refuses to export while there are unsaved edits (the host exports what is on disk)', async () => {
    const r = await open();
    type(r, 'edit');
    await press(r, 'doc-export');
    await press(r, 'doc-export-docx');
    expect(__getLastAlert()?.title).toBe('Unsaved changes');
    expect(h.exportDoc).not.toHaveBeenCalled();
  });
});

describe('opening a .docx', () => {
  beforeEach(() => {
    __setLocalSearchParams({ chatId: 'c1', path: 'docs/report.docx' });
    h.convert.mockResolvedValue({
      mdPath: 'docs/report.md',
      warnings: ['tracked changes accepted'],
      reused: false,
    });
    h.read.mockResolvedValue({ path: 'docs/report.md', content: '# Report\n', size: 9 });
  });

  it('converts, opens the resulting md, and shows the warnings', async () => {
    const r = await open();
    expect(h.convert).toHaveBeenCalledWith('c1', 'docs/report.docx');
    expect(h.read).toHaveBeenCalledWith('c1', 'docs/report.md');
    expect(h.getDoc).toHaveBeenCalledWith('c1', 'docs/report.md');
    expect(text(r).props['value']).toBe('# Report\n');
    expect(hasText(r.root, 'report.md')).toBe(true);
    expect(hasText(r.root, 'tracked changes accepted')).toBe(true);
  });

  it('saves and acts on the converted md, not the docx', async () => {
    const r = await open();
    type(r, '# Report\nmore');
    await press(r, 'doc-save');
    expect(h.write).toHaveBeenCalledWith('c1', 'docs/report.md', '# Report\nmore');
  });

  it('shows no warnings banner when there are none', async () => {
    h.convert.mockResolvedValue({ mdPath: 'docs/report.md', warnings: [], reused: true });
    const r = await open();
    expect(queryHost(r.root, byTestId('doc-warnings'))).toBeNull();
  });

  it('a conversion failure is a load failure with Retry', async () => {
    h.convert.mockRejectedValueOnce(new Error('invalid: not a docx'));
    const r = await open();
    expect(hasText(r.root, 'invalid: not a docx')).toBe(true);
    await press(r, 'doc-retry');
    expect(text(r).props['value']).toBe('# Report\n');
  });

  it('shows the warnings the sidecar kept when a plain md is reopened', async () => {
    __setLocalSearchParams({ chatId: 'c1', path: 'docs/report.md' });
    h.getDoc.mockResolvedValue(view({ importWarnings: ['columns flattened'] }));
    const r = await open();
    expect(hasText(r.root, 'columns flattened')).toBe(true);
  });
});
