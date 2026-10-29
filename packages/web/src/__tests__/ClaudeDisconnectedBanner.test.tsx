// Provider accounts belong to the user, not to a host (spec/10): the banner
// reads the server's shared accounts, so which host a chat is on, and which
// hosts are alive or have reported, never changes the answer.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ClaudeDisconnectedBanner } from '../components/ClaudeDisconnectedBanner.js';
import {
  clearHosts,
  clearSharedAccounts,
  reportAccount,
  setSharedAccounts,
} from './presenceHelpers.js';

const renderBanner = (model?: string): void => {
  render(
    <MemoryRouter>
      <ClaudeDisconnectedBanner {...(model ? { model } : {})} />
    </MemoryRouter>,
  );
};

afterEach(() => {
  cleanup();
  clearHosts();
  clearSharedAccounts();
});

describe('ClaudeDisconnectedBanner', () => {
  it('warns, and points at where to fix it, when no Claude account is connected', () => {
    setSharedAccounts({ claude: [{ connected: false }] });
    renderBanner();
    const el = screen.getByTestId('claude-disconnected-banner');
    expect(el.textContent).toMatch(/can’t run/);
    expect(el.getAttribute('role')).toBe('alert');
    expect(screen.getByRole('link').getAttribute('href')).toBe('/settings/usage');
  });

  it('stays silent when any Claude account is connected', () => {
    setSharedAccounts({ claude: [{ connected: false }, { connected: true }] });
    renderBanner();
    expect(screen.queryByTestId('claude-disconnected-banner')).toBeNull();
  });

  it('stays silent before the shared state has loaded', () => {
    renderBanner();
    expect(screen.queryByTestId('claude-disconnected-banner')).toBeNull();
  });

  it('ignores what any host reports: a host saying "logged out" changes nothing', () => {
    setSharedAccounts({ claude: [{ connected: true }] });
    reportAccount('host-a', false);
    renderBanner();
    expect(screen.queryByTestId('claude-disconnected-banner')).toBeNull();
  });

  it('is not silenced by a host reporting connected when the shared list has none', () => {
    setSharedAccounts({ claude: [] });
    reportAccount('host-a', true, 'a@b.c');
    renderBanner();
    expect(screen.getByTestId('claude-disconnected-banner')).toBeInTheDocument();
  });

  it('checks the right provider for an OpenAI model, and the right kind', () => {
    setSharedAccounts({ claude: [{ connected: true }], codex: [{ connected: false }] });
    renderBanner('openai/gpt-5');
    expect(screen.getByTestId('claude-disconnected-banner').textContent).toMatch(/Codex/);
    cleanup();
    setSharedAccounts({ codex: [{ connected: true, kind: 'apiKey' }] });
    renderBanner('openai/gpt-5');
    expect(screen.getByTestId('claude-disconnected-banner')).toBeInTheDocument();
    cleanup();
    renderBanner('openai/api/gpt-5');
    expect(screen.queryByTestId('claude-disconnected-banner')).toBeNull();
  });
});
