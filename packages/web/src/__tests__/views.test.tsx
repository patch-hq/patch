// Views in the web app (spec/14 § Views): the card in the chat, the pane, the
// marks, Send, and the pane following the agent's changes in place.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, type ViewJson } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore, tabKey, isTabDescriptor } from '../stores/layoutStore.js';
import { ViewCard, viewIdOfArtifact } from '../components/ViewCard.js';
import { ViewPane } from '../components/ViewPane.js';

const view = (over: Partial<ViewJson> = {}): ViewJson => ({
  id: 'v1',
  chatId: 'c1',
  title: 'Which names?',
  template: 'review-list',
  rev: 1,
  data: {
    heading: 'Pick the ones you like',
    items: [
      { id: 'a', title: 'Alder', detail: 'a tree' },
      { id: 'b', title: 'Birch' },
    ],
  },
  marks: {},
  unsent: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function wrap(ui: Parameters<typeof render>[0]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui as never}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useLayoutStore.getState()._reset();
  useChatStore.getState()._reset();
  useChatStore
    .getState()
    .applyEvent({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '/x' } as never);
  useChatStore.getState().setName('c1', 'Naming chat');
});
afterEach(() => vi.restoreAllMocks());

describe('view tab descriptor', () => {
  it('is keyed by view and survives a saved layout', () => {
    const d = { kind: 'page', page: 'view', viewId: 'v1' } as const;
    expect(tabKey(d)).toBe('page:view:v1');
    expect(isTabDescriptor(d)).toBe(true);
    expect(isTabDescriptor({ kind: 'page', page: 'view' })).toBe(false);
  });
});

describe('ViewCard', () => {
  it('names the view, counts items and marks to send, and opens it beside the chat', async () => {
    vi.spyOn(api, 'getView').mockResolvedValue(view({ unsent: 2 }));
    wrap(<ViewCard viewId="v1" title="Which names?" chatId="c1" />);
    await screen.findByText(/2 items · 2 to send/);
    fireEvent.click(screen.getByTestId('view-card-open'));
    expect(
      useLayoutStore.getState().findTab({ kind: 'page', page: 'view', viewId: 'v1' }),
    ).not.toBeNull();
  });
  it('says so when the view is gone', async () => {
    vi.spyOn(api, 'getView').mockRejectedValue(new Error('no view "v1"'));
    wrap(<ViewCard viewId="v1" title="Which names?" chatId="c1" />);
    expect(await screen.findByTestId('view-card-error')).toHaveTextContent('no view "v1"');
    expect(screen.getByTestId('view-card-open')).toBeDisabled();
  });
  it('reads a view id out of a chat.artifact id', () => {
    expect(viewIdOfArtifact('view-v1')).toBe('v1');
    expect(viewIdOfArtifact('pad-v1')).toBeNull();
  });
});

describe('ViewPane', () => {
  it('draws the items and saves a verdict and a note', async () => {
    vi.spyOn(api, 'getView').mockResolvedValue(view());
    const mark = vi
      .spyOn(api, 'markView')
      .mockResolvedValue(
        view({ unsent: 1, marks: { a: { verdict: 'yes', note: '', unsent: true, at: 2 } } }),
      );
    wrap(<ViewPane viewId="v1" />);
    await screen.findByText('Alder');
    expect(screen.getByText('a tree')).toBeInTheDocument();
    expect(screen.getByTestId('view-send')).toBeDisabled();
    const first = screen.getAllByTestId('view-item')[0]!;
    fireEvent.click(within(first).getByTestId('view-yes'));
    await waitFor(() => expect(mark).toHaveBeenCalledWith('v1', { itemId: 'a', verdict: 'yes' }));
    await screen.findByText('Send 1 to agent');
    expect(within(first).getByTestId('view-yes')).toHaveAttribute('aria-pressed', 'true');

    const note = within(screen.getAllByTestId('view-item')[1]!).getByTestId('view-note');
    fireEvent.focus(note);
    fireEvent.change(note, { target: { value: 'too plain' } });
    fireEvent.blur(note);
    await waitFor(() =>
      expect(mark).toHaveBeenCalledWith('v1', { itemId: 'b', note: 'too plain' }),
    );
  });

  it('sends the marks to the agent', async () => {
    vi.spyOn(api, 'getView').mockResolvedValue(
      view({ unsent: 1, marks: { a: { verdict: 'no', note: '', unsent: true, at: 2 } } }),
    );
    const send = vi.spyOn(api, 'sendView').mockResolvedValue({
      sent: 1,
      view: view({ unsent: 0, marks: { a: { verdict: 'no', note: '', unsent: false, at: 2 } } }),
    });
    wrap(<ViewPane viewId="v1" />);
    fireEvent.click(await screen.findByText('Send 1 to agent'));
    await waitFor(() => expect(send).toHaveBeenCalledWith('v1'));
    await screen.findByText('Nothing to send');
  });

  it('follows the agent in place and keeps a note being typed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.spyOn(api, 'getView').mockResolvedValue(view());
      const poll = vi.spyOn(api, 'pollView').mockResolvedValue(
        view({
          rev: 2,
          data: {
            items: [
              { id: 'a', title: 'Alder, renamed' },
              { id: 'b', title: 'Birch' },
              { id: 'c', title: 'Cedar' },
            ],
          },
        }),
      );
      wrap(<ViewPane viewId="v1" />);
      await screen.findByText('Alder');
      const note = within(screen.getAllByTestId('view-item')[1]!).getByTestId('view-note');
      fireEvent.focus(note);
      fireEvent.change(note, { target: { value: 'half typed' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      await screen.findByText('Cedar');
      expect(poll).toHaveBeenCalledWith('v1', 1);
      expect(screen.getByText('Alder, renamed')).toBeInTheDocument();
      expect(screen.getAllByTestId('view-note')[1]).toHaveValue('half typed');
      expect(screen.getByText('rev 2')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when the view cannot be read', async () => {
    vi.spyOn(api, 'getView').mockRejectedValue(new Error('HTTP 404'));
    wrap(<ViewPane viewId="v1" />);
    expect(await screen.findByTestId('view-error')).toHaveTextContent('HTTP 404');
  });
});
