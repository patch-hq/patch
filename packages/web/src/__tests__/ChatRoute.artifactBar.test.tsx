// spec/14 § Main chat panel — Artifact bar. Every artifact this chat has
// published, as a row of chips above the transcript, so an earlier one is one
// click away instead of a scroll back to find its card.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
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

const artifact = (chatId: string, artifactId: string, title: string, seq: number): WireEvent =>
  ({
    type: 'chat.artifact',
    chatId,
    artifactId,
    title,
    url: `/api/chats/${chatId}/artifact/${artifactId}`,
    path: `out/${artifactId}.html`,
    updatedAt: 1_700_000_000_000,
    seq,
  }) as WireEvent;

describe('ChatRoute — artifact bar', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().setArtifactsOpen(false);
  });
  afterEach(() => {
    delete (window as unknown as { patch?: unknown }).patch;
    vi.restoreAllMocks();
  });

  it('shows no bar for a chat that has published nothing', () => {
    const chatId = 'c-bar-empty';
    useChatStore.getState().setActiveChat(chatId);

    renderChat(chatId);

    expect(screen.queryByTestId('artifact-bar')).not.toBeInTheDocument();
  });

  it('shows one chip per published artifact, newest first', () => {
    const chatId = 'c-bar-multi';
    const store = useChatStore.getState();
    store.applyEvent(artifact(chatId, 'a1', 'Bristol bus times', 1));
    store.applyEvent(artifact(chatId, 'a2', 'Garden plan', 2));
    store.setActiveChat(chatId);

    renderChat(chatId);

    // Folded and everything fits: the links sit on the one Artifacts row.
    expect(screen.queryByTestId('artifact-bar-toggle')).not.toBeInTheDocument();
    const chips = screen.getAllByTestId('artifact-bar-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent('Garden plan');
    expect(chips[1]).toHaveTextContent('Bristol bus times');
  });

  it('clicking an earlier chip opens that artifact', () => {
    const chatId = 'c-bar-click';
    const openPanel = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { openPanel };
    const store = useChatStore.getState();
    store.applyEvent(artifact(chatId, 'a1', 'Bristol bus times', 1));
    store.applyEvent(artifact(chatId, 'a2', 'Garden plan', 2));
    store.setActiveChat(chatId);

    renderChat(chatId);
    const chips = screen.getAllByTestId('artifact-bar-chip');
    fireEvent.click(chips[1]!); // the older one, "Bristol bus times"

    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(openPanel.mock.calls[0]![0]).toContain(`/api/chats/${chatId}/artifact/a1`);
  });

  it('republishing the same artifact updates its chip instead of adding one', () => {
    const chatId = 'c-bar-republish';
    const store = useChatStore.getState();
    store.applyEvent(artifact(chatId, 'a1', 'Bristol bus times', 1));
    store.applyEvent(artifact(chatId, 'a1', 'Bristol bus times v2', 9));
    store.setActiveChat(chatId);

    renderChat(chatId);

    const chips = screen.getAllByTestId('artifact-bar-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent('Bristol bus times v2');
  });
});

describe('ChatRoute — artifact bar, single artifact', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });

  it('one artifact is one Artifacts row with no pill', () => {
    const chatId = 'c-bar-one';
    useChatStore.getState().applyEvent(artifact(chatId, 'a1', 'Garden plan', 1));
    useChatStore.getState().setActiveChat(chatId);

    renderChat(chatId);

    expect(screen.queryByTestId('artifact-bar-toggle')).not.toBeInTheDocument();
    expect(screen.getByTestId('artifact-bar-chip')).toHaveTextContent('Garden plan');
    expect(screen.getByText('Artifacts')).toBeInTheDocument();
    expect(screen.getByTestId('status-list')).toContainElement(screen.getByTestId('artifact-bar'));
  });
});

describe('ChatRoute — artifact bar, overflow', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().setArtifactsOpen(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('links that do not fit fold into "+N more", which opens one row each under a pill', () => {
    // jsdom has no layout: give the links row a width and each link 300px.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(700);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      const sibs = Array.from(this.parentElement?.children ?? []);
      return sibs.indexOf(this) * 316;
    });
    const chatId = 'c-bar-overflow';
    const store = useChatStore.getState();
    for (let i = 1; i <= 5; i++) store.applyEvent(artifact(chatId, `a${i}`, `Page ${i}`, i));
    store.setActiveChat(chatId);

    renderChat(chatId);

    expect(screen.getByTestId('artifact-bar-more')).toHaveTextContent('+3 more');
    fireEvent.click(screen.getByTestId('artifact-bar-more'));
    expect(screen.getByTestId('artifact-bar-toggle')).toHaveTextContent('5 published');
    const chips = screen.getAllByTestId('artifact-bar-chip');
    expect(chips).toHaveLength(5);
    expect(chips[0]).toHaveTextContent('Page 5');
  });
});
