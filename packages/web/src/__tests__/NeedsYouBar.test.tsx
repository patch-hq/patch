// The standing "Needs you" bar above the composer: it says what the agent
// declared it is blocked on, and is gone once the ask is cleared.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NeedsYouBar } from '../components/NeedsYouBar.js';
import { useChatStore } from '../stores/chatStore.js';
import { api } from '../api/rest.js';

vi.mock('../api/rest.js', () => ({ api: { askDone: vi.fn(async () => ({ ok: true })) } }));

function seed(statusKind: 'question' | null, statusSummary: string | null, declared: boolean) {
  useChatStore.setState({
    chats: {
      c1: {
        chatId: 'c1',
        statusKind,
        statusSummary,
        statusDeclared: declared,
        chatStatus: { state: declared ? 'waiting_for_user' : 'idle' },
        pendingPermissions: [],
      },
    } as never,
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('NeedsYouBar', () => {
  it('says exactly what the agent declared, with Done', () => {
    seed('question', 'Detach WS3 from the template, or wait for #36728?', true);
    render(<NeedsYouBar chatId="c1" />);
    expect(screen.getByTestId('needs-you-text').textContent).toContain('Detach WS3');
    fireEvent.click(screen.getByTestId('needs-you-done'));
    expect(api.askDone).toHaveBeenCalledWith('c1');
  });

  it('is gone once the ask is cleared', () => {
    seed('question', 'plug it in', true);
    const { rerender } = render(<NeedsYouBar chatId="c1" />);
    expect(screen.getByTestId('needs-you-bar')).toBeTruthy();
    seed(null, null, false);
    rerender(<NeedsYouBar chatId="c1" />);
    expect(screen.queryByTestId('needs-you-bar')).toBeNull();
  });
});
