// Todoist: "new chat button next to folder is very slow in patch".
// A navigation re-rendered every chat row (each called `useNavigate`, which
// subscribes to router context), so the folder "+" cost a full pass over the
// list. Rows draw their title through stripMarkdown, so its call count is the
// row render count.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const stripSpy = vi.hoisted(() => vi.fn());
vi.mock('../lib/stripMarkdown.js', async (orig) => {
  const mod = await orig<typeof import('../lib/stripMarkdown.js')>();
  return {
    ...mod,
    stripMarkdown: (s: string) => {
      stripSpy();
      return mod.stripMarkdown(s);
    },
  };
});

import { Sidebar } from '../components/Sidebar.js';
import { useChatStore } from '../stores/chatStore.js';
import type { ChatRow } from '../stores/types.js';

const FOLDER = '/home/tom/projects/portfolio';

function row(i: number): ChatRow {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId: `c${i}`,
    hostId: 'd1',
    permissionMode: 'bypassPermissions',
    name: `chat ${i}`,
    folder: FOLDER,
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 1000 + i,
    lastUserActivity: 1000 + i,
    jobId: null,
    model: null,
    effort: null,
    rateLimitResumingAt: null,
    resumeKind: null,
  } as unknown as ChatRow;
}

describe('Sidebar — navigating does not re-render the chat rows', () => {
  beforeEach(() => {
    useChatStore.setState({ chats: {}, hydrated: true });
    useChatStore.getState().hydrate(Array.from({ length: 40 }, (_, i) => row(i)));
  });
  afterEach(cleanup);

  it('the folder + navigates without a pass over every row', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar />
      </MemoryRouter>,
    );
    stripSpy.mockClear();
    fireEvent.click(screen.getByTestId(`folder-new-chat-${FOLDER}`));
    // Before the fix: 40 rows x every navigation. Now only rows whose own
    // props changed (none here) draw again.
    expect(stripSpy.mock.calls.length).toBeLessThan(5);
  });
});
