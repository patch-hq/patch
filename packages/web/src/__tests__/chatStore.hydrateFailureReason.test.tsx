// A reload or reconnect loads chats from `GET /api/chats`. The failed badge's
// tooltip must still say WHY the chat failed on that path, not just "Failed".
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useChatStore } from '../stores/chatStore.js';
import { ChatStatusBadge } from '../components/ChatStatusBadge.js';

function row(extra: Record<string, unknown> = {}): never {
  return {
    chatId: 'c1',
    hostId: 'd1',
    permissionMode: 'auto',
    name: 'c1',
    folder: '/tmp/x',
    activity: 'errored',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 1000,
    lastError: { code: 'sdk_error', message: 'Claude session expired', at: 900 },
    ...extra,
  } as never;
}

describe('hydrated errored chat explains the failure', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    cleanup();
  });

  it('a chat loaded from the REST list carries its reason into the badge tooltip', () => {
    useChatStore.getState().hydrate([row()]);
    const r = useChatStore.getState().chats['c1']!;
    expect(r.lastError?.message).toBe('Claude session expired');
    render(<ChatStatusBadge row={r} />);
    expect(screen.getByTestId('badge-errored').getAttribute('title')).toBe(
      'Claude session expired',
    );
  });
});
