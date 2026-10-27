// Task 1 & 2: auto-resume once limit has reset — the RateLimitBanner shows
// different text for a rate-limit vs an overloaded (529) pause. Absent or null
// rateLimitResumingAt → no banner.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { DEFAULT_SHARED_SETTINGS, type WireEvent } from '@patch/wire';
import { fireEvent } from '@testing-library/react';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    skills: vi.fn(async () => ({ skills: [] })),
    models: vi.fn(async () => ({ models: [], fetchedAt: '' })),
    setGoal: vi.fn(async () => undefined),
    setReminder: vi.fn(async () => undefined),
    setPreferences: vi.fn(async (patch: Record<string, unknown>) => ({
      preferences: { ...DEFAULT_SHARED_SETTINGS, ...patch },
    })),
  },
}));

const RESUME_AT = new Date('2026-08-19T14:30:00.000Z').getTime();

function seed(
  rateLimitResumingAt: number | null,
  resumeKind: 'rate_limit' | 'overloaded' | null = null,
  limitBlock: import('../stores/types.js').ChatRow['limitBlock'] = null,
): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      hostId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'test chat',
      folder: '/tmp/foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      goal: null,
      reminder: null,
      rateLimitResumingAt,
      resumeKind,
      limitBlock,
    },
  ]);
}

function renderChat(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ChatRoute — the limit bubble', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('shows nothing when rateLimitResumingAt is null', () => {
    seed(null);
    renderChat();
    expect(screen.queryByTestId('rate-limit-bar')).toBeNull();
  });

  it('tells you which limit and how long, in a sentence', () => {
    seed(RESUME_AT, 'rate_limit');
    renderChat();
    expect(screen.getByTestId('rate-limit-headline').textContent).toMatch(/usage limit/i);
    expect(screen.getByTestId('rate-limit-countdown').textContent?.trim()).not.toBe('');
  });

  it('reads the same on an older host that sends no resumeKind', () => {
    seed(RESUME_AT, null);
    renderChat();
    expect(screen.getByTestId('rate-limit-headline').textContent).toMatch(/usage limit/i);
    expect(screen.getByTestId('rate-limit-bar').textContent).not.toMatch(/busy/i);
  });

  it('a 529 overload is a different sentence — nobody reached a limit', () => {
    seed(RESUME_AT, 'overloaded');
    renderChat();
    expect(screen.getByTestId('rate-limit-headline').textContent).toMatch(/busy/i);
    expect(screen.getByTestId('rate-limit-bar').textContent).not.toMatch(/reached your/i);
  });

  // It is a message about the turn you sent, so it belongs under that turn —
  // not in the stack of permanent-looking strips above the transcript.
  it('sits inside the transcript, not in the banner stack', () => {
    seed(RESUME_AT, 'rate_limit');
    renderChat();
    const stream = screen.getByTestId('chat-stream');
    expect(stream.contains(screen.getByTestId('rate-limit-bar'))).toBe(true);
  });

  it('has no model picker and no Try now — a model change cannot escape the limit', () => {
    seed(RESUME_AT, 'rate_limit', { scope: 'session', resetsAt: Date.now() + 60_000 });
    renderChat();
    expect(screen.queryByTestId('rate-limit-change-model')).toBeNull();
    expect(screen.queryByTestId('rate-limit-retry')).toBeNull();
    expect(screen.getByTestId('rate-limit-bar')).not.toHaveTextContent(/other accounts?/i);
  });

  describe('the card', () => {
    const accounts = [
      { id: 'a1', label: 'Work', connected: true },
      { id: 'a2', label: 'Home', connected: true },
    ];
    const OUT = { session: { status: 'rejected', resetsAt: Date.now() + 3_600_000 } };
    function setup(opts: {
      resetsAt: number;
      other?: 'left' | 'out';
      codex?: boolean;
      overageBlocked?: boolean;
    }): WireEvent[] {
      const sent: WireEvent[] = [];
      setActiveWs({ send: (e: WireEvent) => void sent.push(e) } as never);
      seed(opts.resetsAt, 'rate_limit', {
        scope: 'session',
        accountId: 'a1',
        accountLabel: 'Work',
        resetsAt: opts.resetsAt,
        ...(opts.overageBlocked ? { overageBlocked: true } : {}),
      } as never);
      useChatStore.setState((st) => ({
        chats: {
          ...st.chats,
          c1: { ...st.chats.c1!, model: 'claude-opus-5', preferredAccountId: 'a1' },
        },
      }));
      usePreferencesStore.setState({
        shared: {
          secrets: {
            claude: accounts,
            codex: opts.codex ? [{ id: 'g1', label: 'GPT', kind: 'chatgpt', connected: true }] : [],
          },
        } as never,
      });
      usePresenceStore.setState((st) => ({
        hosts: {
          ...st.hosts,
          d1: {
            ...(st.hosts.d1 as object),
            accounts: {
              'claude-code': {
                accounts: [
                  { id: 'a1', usage: OUT },
                  { id: 'a2', usage: opts.other === 'out' ? OUT : undefined },
                ],
              },
            },
          } as never,
        },
      }));
      return sent;
    }

    it('before the reset: heading, reset corner, Send disabled with the time', () => {
      setup({ resetsAt: Date.now() + 16 * 60_000 + 5_000 });
      renderChat();
      expect(screen.getByTestId('rate-limit-headline')).toHaveTextContent('Session limit · Work');
      expect(screen.getByTestId('rate-limit-countdown').textContent).toMatch(
        /^Resets in 16 min · /,
      );
      const send = screen.getByTestId('rate-limit-send');
      expect(send).toHaveAttribute('aria-disabled', 'true');
      expect(send.getAttribute('title')).toMatch(/^Available at /);
      expect(screen.queryByTestId('rate-limit-unsent')).toBeNull();
    });

    it('after the reset: says so, and that the message was not sent', () => {
      setup({ resetsAt: Date.now() - 4 * 60_000 - 5_000, other: 'out' });
      renderChat();
      expect(screen.getByTestId('rate-limit-headline')).toHaveTextContent(
        'Session limit reset · Work',
      );
      expect(screen.getByTestId('rate-limit-countdown')).toHaveTextContent('4 min ago');
      expect(screen.getByTestId('rate-limit-unsent')).toHaveTextContent('Message not sent');
      expect(screen.getByTestId('rate-limit-send')).not.toHaveAttribute('aria-disabled');
      expect(screen.getByTestId('rate-limit-send').className).toMatch(/limit-btn-main/);
    });

    it('Change account lists accounts with usage left, is the main button, and re-sends', () => {
      const sent = setup({ resetsAt: Date.now() + 60_000 });
      renderChat();
      const btn = screen.getByTestId('rate-limit-change-account');
      expect(btn.className).toMatch(/limit-btn-main/);
      fireEvent.click(btn);
      const options = screen.getAllByTestId('rate-limit-account-option');
      expect(options.map((o) => o.textContent)).toEqual(['Home']);
      fireEvent.click(options[0]!);
      expect(sent).toContainEqual({
        type: 'chat.account_request',
        chatId: 'c1',
        preferredAccountId: 'a2',
      });
      expect(sent).toContainEqual({ type: 'chat.resume_now_request', chatId: 'c1' });
    });

    it('every other account out: Change account is greyed with the reason, not hidden', () => {
      setup({ resetsAt: Date.now() + 60_000, other: 'out' });
      renderChat();
      const btn = screen.getByTestId('rate-limit-change-account');
      expect(btn).toHaveAttribute('aria-disabled', 'true');
      expect(btn.getAttribute('title')).toBe('No other account has usage left');
      fireEvent.click(btn);
      expect(screen.queryByTestId('rate-limit-account-menu')).toBeNull();
    });

    it('Change provider offers a connected provider with usage left', () => {
      setup({ resetsAt: Date.now() + 60_000, other: 'out', codex: true });
      renderChat();
      const btn = screen.getByTestId('rate-limit-change-provider');
      expect(btn.className).toMatch(/limit-btn-main/);
      fireEvent.click(btn);
      expect(screen.getAllByTestId('rate-limit-provider-option').map((o) => o.textContent)).toEqual(
        [expect.stringMatching(/./)],
      );
    });

    it('no other provider: Change provider is greyed with the reason', () => {
      setup({ resetsAt: Date.now() + 60_000, other: 'out' });
      renderChat();
      expect(screen.getByTestId('rate-limit-change-provider').getAttribute('title')).toBe(
        'No other provider has usage left',
      );
    });

    it('Extra usage links out while off, and is greyed once on', () => {
      setup({ resetsAt: Date.now() + 60_000, overageBlocked: true });
      const { unmount } = renderChat();
      expect(screen.getByTestId('rate-limit-extra-usage').getAttribute('href')).toMatch(
        /claude\.ai/,
      );
      unmount();
      setup({ resetsAt: Date.now() + 60_000 });
      renderChat();
      const el = screen.getByTestId('rate-limit-extra-usage');
      expect(el.getAttribute('href')).toBeNull();
      expect(el).toHaveAttribute('aria-disabled', 'true');
      expect(el.getAttribute('title')).toBe('Extra usage is already on');
    });

    it('past reset with nothing else to try, Send re-sends', () => {
      const sent = setup({ resetsAt: Date.now() - 60_000, other: 'out' });
      renderChat();
      fireEvent.click(screen.getByTestId('rate-limit-send'));
      expect(sent).toContainEqual({ type: 'chat.resume_now_request', chatId: 'c1' });
    });

    it('a small retry icon in the header re-sends even while the reset is still ahead', () => {
      const sent = setup({ resetsAt: Date.now() + 60_000 });
      renderChat();
      const retry = screen.getByTestId('rate-limit-retry-icon');
      expect(retry).not.toHaveAttribute('aria-disabled');
      expect(retry.getAttribute('aria-label')).toBe('Retry now');
      expect(sent).not.toContainEqual({ type: 'chat.resume_now_request', chatId: 'c1' });
      fireEvent.click(retry);
      expect(sent).toContainEqual({ type: 'chat.resume_now_request', chatId: 'c1' });
    });

    it('always shows the auto-resume toggle', () => {
      setup({ resetsAt: Date.now() + 60_000 });
      renderChat();
      expect(screen.getByTestId('rate-limit-auto-resume')).toBeInTheDocument();
    });
  });

  it('a 529 overload keeps its own heading', () => {
    seed(RESUME_AT, 'overloaded');
    renderChat();
    expect(screen.getByTestId('rate-limit-headline')).toHaveTextContent(/busy/i);
  });

  it('disappears when rateLimitResumingAt is cleared via chat.state', () => {
    seed(RESUME_AT, 'rate_limit');
    renderChat();
    expect(screen.getByTestId('rate-limit-bar')).toBeInTheDocument();

    // Simulate the host clearing rateLimitResumingAt (timer fired, retry sent).
    act(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        chatId: 'c1',
        hostId: 'd1',
        activity: 'running',
        folder: '/tmp/foo',
        lastUpdated: 1,
        permissionMode: 'bypassPermissions' as const,
        rateLimitResumingAt: null,
      });
    });
    expect(screen.queryByTestId('rate-limit-bar')).toBeNull();
  });
});
