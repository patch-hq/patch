// spec/14 § Main chat panel — Job bar. A chat a job created carries a bar at
// the top linking to that job; an ordinary chat carries none.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { setActiveWs } from '../api/ws.js';
import { api } from '../api/rest.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getJob: vi.fn(async () => ({ id: 'j_bus', name: 'bus check' })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
  },
}));

function seed(jobId: string | null): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      hostId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'bus check',
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      jobId,
    },
  ]);
}

function renderChat(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chats/c1']}>
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChatRoute — job bar', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => {
    cleanup();
    setActiveWs(null);
  });

  it('links a job-created chat to its job', () => {
    seed('j_bus');
    renderChat();
    expect(screen.getByTestId('job-bar')).toBeInTheDocument();
    expect(screen.getByTestId('job-bar-link')).toBeInTheDocument();
  });

  it('names the job that ran the chat', async () => {
    seed('j_bus');
    renderChat();
    expect(await screen.findByText('Run by "bus check" job')).toBeInTheDocument();
    expect(api.getJob).toHaveBeenCalledWith('j_bus');
  });

  it('shows no bar on an ordinary chat', () => {
    seed(null);
    renderChat();
    expect(screen.queryByTestId('job-bar')).not.toBeInTheDocument();
  });
});
