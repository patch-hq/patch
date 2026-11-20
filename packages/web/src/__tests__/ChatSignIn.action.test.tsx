// A chat Waiting for sign-in carries a Sign in action (spec/05 § Chat status):
// in the chat, and on its sidebar row.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { ChatSignInBanner } from '../components/ChatSignInBanner.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { clearSharedAccounts, setSharedAccounts } from './presenceHelpers.js';

const waiting = { state: 'waiting_for_sign_in', since: 1, reason: 'not_signed_in' };

afterEach(() => {
  cleanup();
  clearSharedAccounts();
});

describe('ChatSignInBanner', () => {
  const renderBanner = (
    status: typeof waiting | { state: string; since: number } | null,
    model?: string,
  ) =>
    render(
      <MemoryRouter>
        <ChatSignInBanner status={status} {...(model ? { model } : {})} />
      </MemoryRouter>,
    );

  it('offers Sign in on a chat waiting for sign-in, naming the provider', () => {
    setSharedAccounts({ claude: [{ connected: true }, { connected: false }] });
    renderBanner(waiting);
    expect(screen.getByTestId('chat-signin-banner').textContent).toMatch(/Claude/);
    expect(screen.getByTestId('chat-signin-action').getAttribute('href')).toBe('/connect');
  });

  it('names ChatGPT for an OpenAI model', () => {
    setSharedAccounts({ codex: [{ connected: true }] });
    renderBanner(waiting, 'openai/gpt-5');
    expect(screen.getByTestId('chat-signin-banner').textContent).toMatch(/Codex|ChatGPT/);
  });

  it('is absent for any other status', () => {
    setSharedAccounts({ claude: [{ connected: true }] });
    renderBanner({ state: 'idle', since: 1 });
    expect(screen.queryByTestId('chat-signin-banner')).toBeNull();
  });

  it('leaves it to the not-signed-in banner when no account is connected', () => {
    setSharedAccounts({ claude: [{ connected: false }] });
    renderBanner(waiting);
    expect(screen.queryByTestId('chat-signin-banner')).toBeNull();
  });
});

describe('Sidebar row', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
  });

  const seed = (chatStatus?: typeof waiting): void =>
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        hostId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'a chat',
        folder: '~/proj',
        chatStatus: { state: 'failed', since: 0 },
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
        ...(chatStatus ? { chatStatus } : {}),
      } as never,
    ]);

  it('the badge of a waiting chat is a Sign in action that goes to the sign-in, not the chat', () => {
    seed(waiting);
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar />
        <Routes>
          <Route path="/connect" element={<div data-testid="connect-page" />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('row-signin-c1'));
    expect(screen.getByTestId('connect-page')).toBeTruthy();
  });

  it('a chat not waiting for sign-in has no Sign in action', () => {
    seed();
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('row-signin-c1')).toBeNull();
  });
});
