// The composer's account select (spec/10 § Backend credentials — preferred
// account). Its closed label must follow the account the chat is actually on,
// and it must not carry a native tooltip: a tooltip that is already showing
// when the option list opens draws over the list.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { AccountControl } from '../components/ChatModelControl.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import type { ChatRow } from '../stores/types.js';

function seed(account: { id: string; label: string } | null): void {
  const row = {
    chatId: 'c1',
    hostId: 'd1',
    model: 'claude-sonnet',
    preferredAccountId: null,
    account,
  } as unknown as ChatRow;
  useChatStore.setState((s) => ({ chats: { ...s.chats, c1: row } }));
}

function seedAccounts(): void {
  const mk = (id: string, label: string) => ({ id, label, connected: true });
  usePreferencesStore.setState({
    shared: { secrets: { claude: [mk('a1', 'Default'), mk('a2', 'work')], codex: [] } },
  } as unknown as Parameters<typeof usePreferencesStore.setState>[0]);
}

beforeEach(() => {
  seedAccounts();
  seed({ id: 'a2', label: 'work' });
});
afterEach(cleanup);

describe('AccountControl', () => {
  it('has no native tooltip on the select', () => {
    render(<AccountControl chatId="c1" />);
    expect(screen.getByTestId('chat-account')).not.toHaveAttribute('title');
  });

  it('reads the account the chat is on, and the list says what each choice does', () => {
    render(<AccountControl chatId="c1" />);
    expect(screen.getByTestId('chat-account')).toHaveTextContent('work');
    act(() => seed({ id: 'a1', label: 'Default' }));
    expect(screen.getByTestId('chat-account')).toHaveTextContent('Default');
    fireEvent.click(screen.getByTestId('chat-account'));
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('Switch automatically');
    expect(options[0]).toHaveTextContent(
      'Now on Default. Moves to another account when one runs out.',
    );
    expect(options.slice(1).every((o) => o.textContent?.startsWith('Always '))).toBe(true);
  });
});
