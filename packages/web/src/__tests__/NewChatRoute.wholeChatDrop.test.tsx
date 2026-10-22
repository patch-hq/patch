// Todoist 6hpc6f3V2MHrFXRc — "file drop should be whole of new chat in patch
// not just bottom bit". The whole-chat drop zone (spec/14 § Composer) must
// cover the new-chat screen too, not only the composer strip.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NewChatRoute } from '../routes/NewChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { clearHosts, clearSharedAccounts, reportHost } from './presenceHelpers.js';

function renderNew(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chats/new']}>
        <Routes>
          <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NewChatRoute — whole-chat drop zone', () => {
  beforeEach(() => {
    clearHosts();
    clearSharedAccounts();
    localStorage.removeItem('patch.newChat.last.v1');
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportHost('d1', {});
  });
  afterEach(cleanup);

  it('dragging a file over the folder pill (outside the composer) shows the panel-wide hint', () => {
    renderNew();
    expect(screen.queryByTestId('chat-drop-hint')).toBeNull();
    const pill = screen.getByTestId('new-chat-folder-pill');
    fireEvent.dragEnter(pill, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByTestId('chat-drop-hint')).toHaveTextContent('Drop to attach');
    fireEvent.dragLeave(pill, { dataTransfer: { types: ['Files'] } });
    expect(screen.queryByTestId('chat-drop-hint')).toBeNull();
  });

  it('dropping a file outside the composer attaches it', async () => {
    renderNew();
    const main = screen.getByTestId('new-chat-main');
    const file = new File(['bytes'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.dragEnter(main, { dataTransfer: { types: ['Files'] } });
    fireEvent.drop(main, { dataTransfer: { types: ['Files'], files: [file] } });
    await waitFor(() => expect(screen.getByTestId('composer-attachment')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-drop-hint')).toBeNull();
  });
});
