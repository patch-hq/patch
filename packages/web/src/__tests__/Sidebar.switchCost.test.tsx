// Opening another chat must not re-render the whole roster. The sidebar used to
// hand every row the open chat's id, so each switch re-rendered every row —
// seconds on an account with thousands of chats.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const titleRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../lib/stripMarkdown.js', async (orig) => {
  const real = await orig<typeof import('../lib/stripMarkdown.js')>();
  return {
    ...real,
    stripMarkdown: (s: string) => {
      titleRenders.count++;
      return real.stripMarkdown(s);
    },
  };
});

import { Sidebar } from '../components/Sidebar.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';

const ROWS = 60;

describe('Sidebar — switching chats', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useChatStore.getState().hydrate(
      Array.from({ length: ROWS }, (_, i) => ({
        chatId: `c${i}`,
        hostId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: `chat ${i}`,
        folder: '~/proj',
        activity: 'idle' as const,
        status: 'active' as const,
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: i + 1,
      })),
    );
  });
  afterEach(cleanup);

  it('re-renders only the rows whose highlight changed', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/chats/c0']}>
        <Sidebar />
      </MemoryRouter>,
    );
    act(() => useChatStore.getState().setActiveChat('c0'));
    expect(container.querySelectorAll('.sb-row').length).toBeGreaterThanOrEqual(ROWS);
    titleRenders.count = 0;
    act(() => useChatStore.getState().setActiveChat('c1'));
    expect(titleRenders.count).toBeLessThanOrEqual(4);
  });
});
