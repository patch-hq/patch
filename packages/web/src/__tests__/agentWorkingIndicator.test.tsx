// Favicon + tray icon go orange while any agent is working, and back when idle.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { useAgentWorkingIndicator } from '../lib/agentWorkingIndicator.js';
import { useChatStore } from '../stores/chatStore.js';
import type { ChatRow } from '../stores/types.js';

function Host(): null {
  useAgentWorkingIndicator();
  return null;
}

function row(chatId: string, over: Partial<ChatRow>): ChatRow {
  return {
    chatId,
    hostId: 'd1',
    status: 'active',
    activity: 'idle',
    pendingPermissions: [],
    ...over,
  } as ChatRow;
}

const icon = (): string =>
  document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.getAttribute('href')!;

describe('agent working indicator', () => {
  const setAgentWorking = vi.fn();
  beforeEach(() => {
    document.head.innerHTML = '<link rel="icon" href="/app/favicon.svg" />';
    (window as unknown as { patch: unknown }).patch = { setAgentWorking };
    setAgentWorking.mockClear();
    useChatStore.setState({ chats: {} });
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { patch?: unknown }).patch;
  });

  it('is idle with no working chat', () => {
    render(<Host />);
    expect(icon()).toBe('/app/favicon.svg');
    expect(setAgentWorking).toHaveBeenLastCalledWith(false);
  });

  it('turns orange while a chat is working and returns when it stops', () => {
    render(<Host />);
    act(() => {
      useChatStore.setState({
        chats: { a: row('a', { activity: 'running' } as Partial<ChatRow>) },
      });
    });
    expect(icon()).toBe('/app/favicon-working.svg');
    expect(setAgentWorking).toHaveBeenLastCalledWith(true);
    act(() => {
      useChatStore.setState({ chats: { a: row('a', { activity: 'idle' }) } });
    });
    expect(icon()).toBe('/app/favicon.svg');
    expect(setAgentWorking).toHaveBeenLastCalledWith(false);
  });

  it('ignores an archived chat', () => {
    render(<Host />);
    act(() => {
      useChatStore.setState({
        chats: { a: row('a', { activity: 'running', status: 'archived' } as Partial<ChatRow>) },
      });
    });
    expect(icon()).toBe('/app/favicon.svg');
  });
});
