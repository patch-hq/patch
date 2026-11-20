// The Waiting page lists timer wakes and event-triggered one-off jobs per chat.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Job } from '@patch/wire/jobs';
import type { ChatRow } from '../stores/types.js';
import { deriveWaiting } from '../lib/waiting.js';
import { WaitingPage } from '../components/WaitingPage.js';
import { useChatStore } from '../stores/chatStore.js';

const listJobs = vi.fn();
vi.mock('../api/rest.js', () => ({ api: { listJobs: (): unknown => listJobs() } }));
vi.mock('../components/NavHistoryControls.js', () => ({ NavHistoryControls: () => null }));

function chat(chatId: string, over: Partial<ChatRow> = {}): ChatRow {
  return { chatId, name: chatId, status: 'active', pendingWake: null, ...over } as ChatRow;
}
function job(id: string, over: Record<string, unknown> = {}): Job {
  return {
    id,
    name: `job ${id}`,
    enabled: true,
    oneOff: true,
    createdAt: 1000,
    trigger: { type: 'webhook', scheme: 'none' },
    action: { type: 'message', chatId: 'c1', prompt: 'go' },
    ...over,
  } as unknown as Job;
}

describe('deriveWaiting', () => {
  it('lists timers soonest first, then live one-off message jobs', () => {
    const chats = {
      c1: chat('c1', { pendingWake: { message: 'late', fireAt: 900 } }),
      c2: chat('c2', { pendingWake: { message: 'soon', fireAt: 100, every: 60_000 } }),
    };
    const rows = deriveWaiting(chats, [job('a'), job('b', { createdAt: 2000 })]);
    expect(rows.map((r) => r.key)).toEqual(['wake:c2', 'wake:c1', 'job:b', 'job:a']);
  });

  it('ignores recurring, disabled, expired, archived and non-message jobs, and archived chats', () => {
    const chats = {
      c1: chat('c1'),
      gone: chat('gone', { status: 'archived', pendingWake: { message: 'x', fireAt: 1 } }),
    };
    const jobs = [
      job('recurring', { oneOff: false }),
      job('off', { enabled: false }),
      job('expired', { expiredAt: 5 }),
      job('arch', { archived: true }),
      job('spawn', { action: { type: 'spawn', hostId: 'h', folder: '/', prompt: 'x' } }),
      job('toGone', { action: { type: 'message', chatId: 'gone', prompt: 'x' } }),
    ];
    expect(deriveWaiting(chats, jobs)).toEqual([]);
  });

  it('marks a loop tick absorbed by a running turn as held', () => {
    const rows = deriveWaiting(
      { c1: chat('c1', { pendingWake: { message: 'm', fireAt: 1, every: 5, waiting: true } }) },
      [],
    );
    expect(rows[0]).toMatchObject({ kind: 'time', held: true });
  });
});

describe('WaitingPage', () => {
  beforeEach(() => {
    listJobs.mockReset();
    useChatStore.setState({ chats: {} });
  });
  afterEach(cleanup);
  const mount = (): void => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <WaitingPage />
      </QueryClientProvider>,
    );
  };

  it('says nothing is waiting when there are no waits', async () => {
    listJobs.mockResolvedValue({ jobs: [] });
    mount();
    expect(await screen.findByTestId('waiting-empty')).toBeTruthy();
  });

  it('shows an event wait and a timer', async () => {
    useChatStore.setState({
      chats: {
        c1: chat('c1', {
          name: 'deploy watcher',
          pendingWake: { message: 'check', fireAt: Date.now() + 3_600_000 },
        }),
      },
    });
    listJobs.mockResolvedValue({ jobs: [job('a')] });
    mount();
    await waitFor(() => expect(screen.getByTestId('waiting-row-job:a')).toBeTruthy());
    expect(screen.getByTestId('waiting-row-wake:c1').textContent).toContain('deploy watcher');
    expect(screen.getByTestId('waiting-row-job:a').getAttribute('data-kind')).toBe('event');
  });

  it('surfaces a failed jobs load instead of showing an empty list', async () => {
    listJobs.mockRejectedValue(new Error('boom'));
    mount();
    expect((await screen.findByTestId('waiting-error')).textContent).toContain('boom');
  });
});
