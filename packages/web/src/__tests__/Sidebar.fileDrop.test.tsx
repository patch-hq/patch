// A file dragged from the desktop onto a sidebar chat row attaches to that
// chat's draft without opening the chat.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useComposerAttachmentStore } from '../stores/composerAttachmentStore.js';

function chat(chatId: string) {
  return {
    chatId,
    hostId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: `chat ${chatId}`,
    folder: '~/proj',
    chatStatus: { state: 'idle' as const, since: 0 },
    status: 'active' as const,
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 1,
  };
}

describe('Sidebar — drop a file on a chat row', () => {
  const attach = vi.fn();
  beforeEach(() => {
    useChatStore.getState()._reset();
    useChatStore.getState().hydrate([chat('c1'), chat('c2')]);
    useUiStore.setState({ forgottenFolders: [], errors: [] });
    attach.mockReset();
    vi.spyOn(useComposerAttachmentStore, 'getState').mockReturnValue({
      ...useComposerAttachmentStore.getState(),
      attach,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('attaches the dropped file to that chat and highlights the row while over it', async () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    const row = screen.getByTestId('chat-row-c2');
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    const dataTransfer = { types: ['Files'], files: [file], items: [], dropEffect: '' };
    fireEvent.dragOver(row, { dataTransfer });
    expect(row.className).toContain('drop-target');
    fireEvent.drop(row, { dataTransfer });
    expect(row.className).not.toContain('drop-target');
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
    expect(attach).toHaveBeenCalledWith('c2', { kind: 'chat', chatId: 'c2' }, [file]);
  });
});
