// Artifacts in the transcript (spec/14 § Artifacts): a `chat.artifact` event
// becomes its own card — title + source filename, nothing else — and clicking
// it opens the page as a tab in the chat's group (desktop and web alike).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import type { WireEvent } from '@patch/wire';

function renderChat(chatId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/chats/${chatId}`]}>
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const artifact = (chatId: string): WireEvent => ({
  type: 'chat.artifact',
  chatId,
  artifactId: 'abc123',
  title: 'Bristol bus times',
  url: `/api/chats/${chatId}/artifact/abc123`,
  path: 'out/buses.html',
  updatedAt: 1_700_000_000_000,
  seq: 4,
});

describe('ChatRoute — artifact card', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });
  afterEach(() => {
    delete (window as unknown as { patch?: unknown }).patch;
    vi.restoreAllMocks();
  });

  it('renders a card with the artifact title and its source file', () => {
    const chatId = 'c-art';
    useChatStore.getState().applyEvent(artifact(chatId));
    useChatStore.getState().setActiveChat(chatId);

    renderChat(chatId);

    const card = screen.getByTestId('artifact-card');
    expect(card).toHaveTextContent('Bristol bus times');
    expect(card).toHaveTextContent('out/buses.html');
  });

  it('opens the artifact as a tab in the chat group when clicked, on desktop too', () => {
    const chatId = 'c-art2';
    const openPanel = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    (window as unknown as { patch?: unknown }).patch = { openPanel };
    useChatStore.getState().applyEvent(artifact(chatId));
    useChatStore.getState().setActiveChat(chatId);

    renderChat(chatId);
    fireEvent.click(screen.getByTestId('artifact-card'));

    expect(openPanel).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    const tab = useLayoutStore.getState().findTab({
      kind: 'page',
      page: 'artifact',
      chatId,
      artifactId: 'abc123',
      url: '',
    });
    expect(tab).toBeDefined();
  });

  it('republishing the same artifact updates the existing card instead of adding one', () => {
    const chatId = 'c-art4';
    const store = useChatStore.getState();
    store.applyEvent(artifact(chatId));
    store.applyEvent({ ...artifact(chatId), title: 'Bristol bus times v2', seq: 9 } as WireEvent);
    store.setActiveChat(chatId);

    renderChat(chatId);

    const cards = screen.getAllByTestId('artifact-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('Bristol bus times v2');
  });
});
