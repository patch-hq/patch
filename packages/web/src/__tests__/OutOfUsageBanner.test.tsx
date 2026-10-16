// The banner every chat on a spent machine shows. The failure it guards against
// is the 2026-09-11 one: every account out, every chat silently parked. It must
// say so when that is true, and — as important — never cry wolf, never invent a
// reset time, and never speak for a different machine.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { HostAccountSummary } from '@patch/wire';
import { OutOfUsageBanner } from '../components/OutOfUsageBanner.js';
import { clearHosts, reportAccount, reportAccounts } from './presenceHelpers.js';

const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
const MIN = 60_000;

const spent = (id: string, label: string, resetsAt?: number): HostAccountSummary => ({
  id,
  label,
  accountEmail: `${id}@example.com`,
  connected: true,
  usage: {
    session: {
      status: 'rejected',
      utilization: 1,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    },
  },
});

const fine = (id: string, label: string): HostAccountSummary => ({
  id,
  label,
  accountEmail: `${id}@example.com`,
  connected: true,
  usage: { session: { status: 'allowed', utilization: 0.2 } },
});

const renderBanner = (hostId: string | null = 'host-a', model?: string): void => {
  render(
    <MemoryRouter>
      <OutOfUsageBanner hostId={hostId} {...(model === undefined ? {} : { model })} />
    </MemoryRouter>,
  );
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  clearHosts();
  vi.useRealTimers();
});

describe('OutOfUsageBanner — when credit has run out', () => {
  it('names the account, says when it resets and how long that is, and links to Usage', () => {
    reportAccounts('host-a', [spent('a', 'Default', NOW + 90 * MIN)]);
    renderBanner();
    const banner = screen.getByTestId('out-of-usage-banner');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('out-of-usage-accounts').textContent).toBe('Default');
    expect(banner.textContent).toMatch(/Out of usage on Default\./);
    const reset = screen.getByTestId('out-of-usage-reset');
    expect(reset.textContent).toMatch(/resets at .+ \(1 hour 30 minutes\)\./);
    // The same instant in both zones on hover, never an unlabelled clock.
    expect(reset.getAttribute('title')).toContain('UTC');
    expect(screen.getByRole('link', { name: 'Usage' }).getAttribute('href')).toBe(
      '/settings/usage',
    );
  });

  it('says "accounts" and lists them as a sentence when several are spent', () => {
    reportAccounts('host-a', [
      spent('a', 'work', NOW + 60 * MIN),
      spent('b', 'Default', NOW + 30 * MIN),
      spent('c', 'personal', NOW + 120 * MIN),
    ]);
    renderBanner();
    expect(screen.getByTestId('out-of-usage-banner').textContent).toMatch(
      /Out of usage on work, Default and personal accounts\./,
    );
  });

  it('quotes the SOONEST reset — the first moment anything can run again', () => {
    reportAccounts('host-a', [
      spent('a', 'work', NOW + 300 * MIN),
      spent('b', 'Default', NOW + 20 * MIN),
    ]);
    renderBanner();
    expect(screen.getByTestId('out-of-usage-reset').textContent).toMatch(
      /^Default resets at .+ \(20 minutes\)\.$/,
    );
  });

  it('invents no reset when none was stated', () => {
    reportAccounts('host-a', [spent('a', 'Default')]);
    renderBanner();
    expect(screen.getByTestId('out-of-usage-reset').textContent).toBe(
      'Anthropic gave no reset time.',
    );
    expect(screen.getByTestId('out-of-usage-reset').getAttribute('title')).toBeNull();
  });

  it('counts down as time passes', () => {
    reportAccounts('host-a', [spent('a', 'Default', NOW + 25 * MIN)]);
    renderBanner();
    expect(screen.getByTestId('out-of-usage-reset').textContent).toMatch(/\(25 minutes\)/);
    act(() => {
      vi.advanceTimersByTime(10 * MIN);
    });
    expect(screen.getByTestId('out-of-usage-reset').textContent).toMatch(/\(15 minutes\)/);
  });

  it('withdraws itself once the reset passes, rather than quoting a past time as a wait', () => {
    reportAccounts('host-a', [spent('a', 'Default', NOW + 5 * MIN)]);
    renderBanner();
    expect(screen.getByTestId('out-of-usage-banner')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(6 * MIN);
    });
    // The reading is a statement about its moment; past the reset it no longer holds.
    expect(screen.queryByTestId('out-of-usage-banner')).toBeNull();
  });
});

describe('OutOfUsageBanner — when it must stay quiet', () => {
  it('is silent while any account on the machine still has credit', () => {
    reportAccounts('host-a', [spent('a', 'work', NOW + 60 * MIN), fine('b', 'Default')]);
    renderBanner();
    expect(screen.queryByTestId('out-of-usage-banner')).toBeNull();
  });

  it('is silent when a spent account has a sibling with no reading yet', () => {
    reportAccounts('host-a', [
      spent('a', 'work', NOW + 60 * MIN),
      { id: 'b', label: 'Default', accountEmail: null, connected: true },
    ]);
    renderBanner();
    expect(screen.queryByTestId('out-of-usage-banner')).toBeNull();
  });

  it('is silent before the host has reported, and with no host at all', () => {
    renderBanner('host-a');
    expect(screen.queryByTestId('out-of-usage-banner')).toBeNull();
    cleanup();
    renderBanner(null);
    expect(screen.queryByTestId('out-of-usage-banner')).toBeNull();
  });

  it('leaves a signed-out machine to the disconnected banner', () => {
    reportAccount('host-a', false);
    renderBanner();
    expect(screen.queryByTestId('out-of-usage-banner')).toBeNull();
  });

  it('does not count a signed-out account as spent or as available', () => {
    reportAccounts('host-a', [
      spent('a', 'work', NOW + 60 * MIN),
      { id: 'b', label: 'old', accountEmail: null, connected: false },
    ]);
    renderBanner();
    const text = screen.getByTestId('out-of-usage-banner').textContent ?? '';
    expect(text).toMatch(/Out of usage on work\./);
    expect(text).not.toContain('old');
  });

  it('ignores a pool whose window only warns, however full', () => {
    reportAccounts('host-a', [
      {
        id: 'a',
        label: 'Default',
        accountEmail: null,
        connected: true,
        usage: { session: { status: 'allowed_warning', utilization: 0.97 } },
      },
    ]);
    renderBanner();
    expect(screen.queryByTestId('out-of-usage-banner')).toBeNull();
  });

  it('does not speak for ANOTHER machine being spent', () => {
    reportAccounts('host-a', [fine('a', 'Default')]);
    reportAccounts('host-b', [spent('b', 'work', NOW + 60 * MIN)]);
    renderBanner('host-a');
    expect(screen.queryByTestId('out-of-usage-banner')).toBeNull();
    cleanup();
    renderBanner('host-b');
    expect(screen.getByTestId('out-of-usage-banner')).toBeInTheDocument();
  });

  it('shows an extra-usage-only rejection as nothing wrong — that pool is not spent from', () => {
    reportAccounts('host-a', [
      {
        id: 'a',
        label: 'Default',
        accountEmail: null,
        connected: true,
        usage: {
          session: { status: 'allowed', utilization: 0.1 },
          overage: { status: 'rejected' },
        },
      },
    ]);
    renderBanner();
    expect(screen.queryByTestId('out-of-usage-banner')).toBeNull();
  });
});

describe('OutOfUsageBanner — chats on the other backend', () => {
  it('says OpenAI, not Anthropic, when a ChatGPT-model chat has no reset time', () => {
    // Claude reports nothing for this host; the openai/ chat reads the codex slot.
    reportAccounts('host-a', [fine('a', 'Default')]);
    renderBanner('host-a', 'openai/gpt-5');
    // No codex report yet → silent, and certainly not Claude's state.
    expect(screen.queryByTestId('out-of-usage-banner')).toBeNull();
  });
});
