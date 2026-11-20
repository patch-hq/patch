// spec/04 § Provider switches — linked chats read as one thread: the newer chat
// opens with a divider naming the chat it continues and what changed, the older
// one ends with a divider naming its continuation, each linking to the other.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ContinuationDivider, continuationChange } from '../components/ContinuationDivider.js';
import { useChatStore } from '../stores/chatStore.js';
import type { ChatRow } from '../stores/types.js';

const row = (o: Partial<ChatRow>): ChatRow =>
  ({ chatId: 'x', hostId: 'd1', name: null, model: null, ...o }) as ChatRow;

beforeEach(() => {
  useChatStore.getState()._reset();
  useChatStore.setState((s) => ({
    chats: {
      ...s.chats,
      old: row({ chatId: 'old', name: 'Plan', model: 'claude-opus-5-5', continuedIn: 'new' }),
      new: row({ chatId: 'new', name: 'Plan again', model: 'openai/gpt-5', continuedFrom: 'old' }),
    },
  }));
});
afterEach(() => cleanup());

describe('ContinuationDivider', () => {
  it('opens the newer chat naming the one it continues and the switch', () => {
    const r = useChatStore.getState().chats['new']!;
    render(
      <MemoryRouter>
        <ContinuationDivider row={r} edge="start" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('continuation-start').textContent).toBe(
      'Continued from Plan · Opus 5.5 → openai/gpt-5',
    );
    expect(screen.getByTestId('continuation-start-link').getAttribute('href')).toBe('/chats/old');
  });

  it('ends the older chat naming the one that continues it', () => {
    const r = useChatStore.getState().chats['old']!;
    render(
      <MemoryRouter>
        <ContinuationDivider row={r} edge="end" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('continuation-end-link').getAttribute('href')).toBe('/chats/new');
    expect(screen.getByTestId('continuation-end').textContent).toContain('Continued in Plan again');
  });

  it('draws nothing on a chat with no link, and names the hosts for a move', () => {
    render(
      <MemoryRouter>
        <ContinuationDivider row={row({ chatId: 'solo' })} edge="start" />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('continuation-start')).toBeNull();
    expect(
      continuationChange({ hostId: 'a', model: 'm' }, { hostId: 'b', model: 'm' }, (h) => h),
    ).toBe('a → b');
  });
});
