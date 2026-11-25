// Done on an action-request card (spec/04 § Current status): shown only for the
// ask still outstanding, and it asks the server to clear it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AskHumanCard } from '../components/AskHumanCard.js';
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
        chatStatus: { state: 'waiting_for_user' },
        pendingPermissions: [],
      },
    } as never,
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('AskHumanCard Done', () => {
  it('shows Done for the outstanding ask and calls the server', () => {
    seed('question', 'plug it in', true);
    render(<AskHumanCard task="plug it in" chatId="c1" />);
    fireEvent.click(screen.getByTestId('ask-human-done'));
    expect(api.askDone).toHaveBeenCalledWith('c1');
  });

  it('has no Done once the ask is cleared, or for an older ask', () => {
    seed(null, null, false);
    render(<AskHumanCard task="plug it in" chatId="c1" />);
    expect(screen.queryByTestId('ask-human-done')).toBeNull();
    cleanup();
    seed('question', 'something newer', true);
    render(<AskHumanCard task="plug it in" chatId="c1" />);
    expect(screen.queryByTestId('ask-human-done')).toBeNull();
  });
});
