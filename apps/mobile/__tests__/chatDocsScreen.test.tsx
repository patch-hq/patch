// Chat-folder document browser (spec/15 § Document editor): lists the chat's
// folder, folders navigable, only .md and .docx files offered.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
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
import ChatDocs from '../app/chats/[chatId]/docs';
import { routerMock, __resetRouterMock, __setLocalSearchParams } from './stubs/expo-router';

const { listSpy } = vi.hoisted(() => ({ listSpy: vi.fn() }));
vi.mock('../src/api/rest', async (orig) => ({
  ...(await orig<typeof import('../src/api/rest')>()),
  api: { chatFilesList: listSpy },
}));

const mounted: ReactTestRenderer[] = [];
async function open(): Promise<ReactTestRenderer> {
  const r = renderRN(<ChatDocs />);
  mounted.push(r);
  await flush();
  return r;
}
const tap = (r: ReactTestRenderer, id: string): void =>
  actSync(() => (findHost(r.root, byTestId(id)).props['onPress'] as () => void)());

beforeEach(() => {
  __resetRouterMock();
  listSpy.mockReset();
  __setLocalSearchParams({ chatId: 'c1' });
  listSpy.mockResolvedValue({
    path: '',
    entries: [
      { name: 'plan.md', type: 'file' },
      { name: 'photo.png', type: 'file' },
      { name: 'sub', type: 'dir' },
      { name: 'report.docx', type: 'file' },
      { name: 'notes.txt', type: 'file' },
    ],
  });
});
afterEach(() => {
  actSync(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

describe('chat documents screen', () => {
  it('lists the chat folder root: folders, then .md and .docx only', async () => {
    const r = await open();
    expect(listSpy).toHaveBeenCalledWith('c1', '');
    expect(queryHost(r.root, byTestId('docs-entry-sub'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('docs-entry-plan.md'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('docs-entry-report.docx'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('docs-entry-photo.png'))).toBeNull();
    expect(queryHost(r.root, byTestId('docs-entry-notes.txt'))).toBeNull();
    expect(queryHost(r.root, byTestId('docs-up'))).toBeNull();
  });

  it('opens a document in the editor with its path from the chat folder', async () => {
    __setLocalSearchParams({ chatId: 'c1', path: 'sub' });
    listSpy.mockResolvedValue({ path: 'sub', entries: [{ name: 'a.md', type: 'file' }] });
    const r = await open();
    expect(listSpy).toHaveBeenCalledWith('c1', 'sub');
    tap(r, 'docs-entry-a.md');
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/chats/[chatId]/doc',
      params: { chatId: 'c1', path: 'sub/a.md' },
    });
  });

  it('opens a .docx the same way (the editor converts it)', async () => {
    const r = await open();
    tap(r, 'docs-entry-report.docx');
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/chats/[chatId]/doc',
      params: { chatId: 'c1', path: 'report.docx' },
    });
  });

  it('a folder pushes the next listing; Up goes to the parent', async () => {
    const r = await open();
    tap(r, 'docs-entry-sub');
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/chats/[chatId]/docs',
      params: { chatId: 'c1', path: 'sub' },
    });
    __setLocalSearchParams({ chatId: 'c1', path: 'a/b' });
    const r2 = await open();
    tap(r2, 'docs-up');
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/chats/[chatId]/docs',
      params: { chatId: 'c1', path: 'a' },
    });
  });

  it('Up from a first-level folder goes to the chat folder root', async () => {
    __setLocalSearchParams({ chatId: 'c1', path: 'sub' });
    const r = await open();
    tap(r, 'docs-up');
    expect(routerMock.push).toHaveBeenLastCalledWith({
      pathname: '/chats/[chatId]/docs',
      params: { chatId: 'c1' },
    });
  });

  it('shows the host reason when the listing fails, and Retry lists again', async () => {
    listSpy.mockRejectedValueOnce(new Error('daemon_timeout'));
    const r = await open();
    expect(hasText(r.root, 'daemon_timeout')).toBe(true);
    await actAsync(async () => {
      (findHost(r.root, byTestId('docs-retry')).props['onPress'] as () => void)();
      await flush();
    });
    expect(queryHost(r.root, byTestId('docs-entry-plan.md'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('docs-error'))).toBeNull();
  });

  it('shows an empty state for a folder with no documents', async () => {
    listSpy.mockResolvedValue({ path: '', entries: [{ name: 'x.bin', type: 'file' }] });
    const r = await open();
    expect(queryHost(r.root, byTestId('empty-state'))).not.toBeNull();
  });

  it('back goes to the chat', async () => {
    const r = await open();
    tap(r, 'host-tool-back');
    expect(routerMock.back).toHaveBeenCalled();
  });
});
