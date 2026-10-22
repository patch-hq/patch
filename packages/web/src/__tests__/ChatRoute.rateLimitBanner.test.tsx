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
import { api } from '../api/rest.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { DEFAULT_SHARED_SETTINGS, type WireEvent } from '@patch/wire';
import { fireEvent } from '@testing-library/react';
import { setModelCatalog, resetModelCatalog } from '../lib/models.js';

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

  it('offers a Change model button that moves the chat to the chosen model', () => {
    const sent: WireEvent[] = [];
    setActiveWs({ send: (e: WireEvent) => void sent.push(e) } as never);
    resetModelCatalog();
    setModelCatalog({
      status: 'ready',
      models: [
        { id: 'claude-opus-5', label: 'Opus 5' },
        { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      ],
    });
    seed(RESUME_AT, 'rate_limit');
    useChatStore.setState((st) => ({
      chats: { ...st.chats, c1: { ...st.chats.c1!, model: 'claude-opus-5' } },
    }));
    renderChat();
    const bar = screen.getByTestId('rate-limit-bar');
    const btn = screen.getByTestId('rate-limit-change-model');
    expect(bar.contains(btn)).toBe(true);
    expect(btn.textContent).toMatch(/change model/i);
    fireEvent.click(btn);
    fireEvent.click(screen.getByText('Sonnet 5'));
    expect(sent).toContainEqual({
      type: 'chat.model_request',
      chatId: 'c1',
      model: 'claude-sonnet-5',
    });
  });

  describe('a chat locked to an account', () => {
    const accounts = [
      { id: 'a1', label: 'work', connected: true },
      { id: 'a2', label: 'personal', connected: true },
    ];
    function seedLocked(preferredAccountId: string | null): void {
      seed(RESUME_AT, 'rate_limit', {
        scope: 'session',
        accountId: 'a1',
        accountLabel: 'work',
        routing: { strategy: 'priority', accounts: 2, exhausted: 1 },
      } as never);
      useChatStore.setState((st) => ({
        chats: {
          ...st.chats,
          c1: { ...st.chats.c1!, model: 'claude-opus-5', preferredAccountId },
        },
      }));
      usePreferencesStore.setState({
        shared: { secrets: { claude: accounts, codex: [] } } as never,
      });
    }

    it('says it is locked and offers Change account, which sends the pick', () => {
      const sent: WireEvent[] = [];
      setActiveWs({ send: (e: WireEvent) => void sent.push(e) } as never);
      seedLocked('a1');
      renderChat();
      expect(screen.getByTestId('rate-limit-locked').textContent).toMatch(/locked to work/);
      expect(screen.queryByTestId('rate-limit-routing')).toBeNull();
      const select = screen.getByTestId('rate-limit-change-account');
      expect(screen.getByTestId('rate-limit-bar').contains(select)).toBe(true);
      expect(select.textContent).toMatch(/Change account/);
      fireEvent.change(select, { target: { value: 'a2' } });
      expect(sent).toContainEqual({
        type: 'chat.account_request',
        chatId: 'c1',
        preferredAccountId: 'a2',
      });
    });

    it('can hand the chat back to Automatic', () => {
      const sent: WireEvent[] = [];
      setActiveWs({ send: (e: WireEvent) => void sent.push(e) } as never);
      seedLocked('a1');
      renderChat();
      fireEvent.change(screen.getByTestId('rate-limit-change-account'), { target: { value: '' } });
      expect(sent).toContainEqual({
        type: 'chat.account_request',
        chatId: 'c1',
        preferredAccountId: null,
      });
    });

    it('an Automatic chat has no lock note and no Change account', () => {
      seedLocked(null);
      renderChat();
      expect(screen.queryByTestId('rate-limit-locked')).toBeNull();
      expect(screen.queryByTestId('rate-limit-change-account')).toBeNull();
      expect(screen.getByTestId('rate-limit-routing')).toBeInTheDocument();
    });
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

  // The structured half (spec/10 § Usage). Before this the banner could only
  // replay Anthropic's own sentence — "You've hit your monthly spend limit ·
  // your session limit resets 9:40am (UTC)" — which names two different limits,
  // no account, and a time in a zone the reader is not in.
  describe('what it says when the figures are known', () => {
    it('names the pool that RAN OUT — never the overflow that failed to cover it', () => {
      seed(RESUME_AT, 'rate_limit', {
        accountId: 'acct-1',
        accountLabel: 'work',
        scope: 'session',
        utilization: 1,
        resetsAt: RESUME_AT,
        // Extra usage being off is WHY this is a hard stop — but it is not the
        // limit that was reached, and must never be the headline. "Extra usage
        // limit on Default" was that headline, and it said nothing usable.
        overageBlocked: true,
        overageReason: 'org_level_disabled_until',
      });
      renderChat();
      expect(screen.getByTestId('rate-limit-headline')).toHaveTextContent(
        /reached your session limit/i,
      );
      expect(screen.getByTestId('rate-limit-bar')).not.toHaveTextContent(/extra usage limit/i);
      expect(screen.getByTestId('rate-limit-account')).toHaveTextContent('work');
    });

    it('says plainly whether another account is available', () => {
      seed(RESUME_AT, 'rate_limit', {
        scope: 'week',
        resetsAt: RESUME_AT,
        routing: {
          strategy: 'round-robin',
          accounts: 3,
          exhausted: 3,
          nextResetsAt: RESUME_AT,
          nextLabel: 'personal',
        },
      });
      renderChat();
      const line = screen.getByTestId('rate-limit-routing');
      expect(line).toHaveTextContent(
        /^All 3 accounts are out\. The first is back .+ \(personal\)\.$/,
      );
    });

    it('reassures when another account still has room', () => {
      seed(RESUME_AT, 'rate_limit', {
        scope: 'session',
        resetsAt: RESUME_AT,
        routing: { strategy: 'priority', accounts: 2, exhausted: 1 },
      });
      renderChat();
      expect(screen.getByTestId('rate-limit-routing')).toHaveTextContent(
        'Another account is still available.',
      );
      expect(screen.getByTestId('rate-limit-bar')).not.toHaveTextContent(/1 of 2/);
    });

    it('says nothing about routing when the host reported none', () => {
      seed(RESUME_AT, 'rate_limit', { scope: 'week', resetsAt: RESUME_AT });
      renderChat();
      expect(screen.queryByTestId('rate-limit-routing')).toBeNull();
    });

    it('counts down in words, not unit symbols', () => {
      seed(RESUME_AT, 'rate_limit', { scope: 'session', resetsAt: Date.now() + 63 * 60_000 });
      renderChat();
      const countdown = screen.getByTestId('rate-limit-countdown');
      expect(countdown).toHaveTextContent(/1 hour 3 minutes/);
      expect(countdown.textContent).not.toMatch(/\d+\s?h\b/);
    });

    it('offers a way to turn extra usage on when that is what left no overflow', () => {
      seed(RESUME_AT, 'rate_limit', {
        scope: 'session',
        overageBlocked: true,
        overageReason: 'org_level_disabled_until',
        resetsAt: RESUME_AT,
      });
      renderChat();
      const link = screen.getByTestId('rate-limit-extra-usage');
      // A link, not a switch: patch cannot flip an Anthropic account setting,
      // and a control that pretends to is worse than none. The explanation
      // that used to be a paragraph lives on it.
      expect(link.getAttribute('href')).toMatch(/claude\.ai/);
      expect(link.getAttribute('title')).toMatch(/Extra usage: disabled\./i);
      // Not "this organisation": a personal subscription has no organisation
      // that did anything, and the sentence read as an accusation.
      expect(link.getAttribute('title')).not.toMatch(/organisation/i);
    });

    it('says nothing about extra usage when extra usage was not the problem', () => {
      seed(RESUME_AT, 'rate_limit', { scope: 'week', resetsAt: RESUME_AT });
      renderChat();
      expect(screen.queryByTestId('rate-limit-extra-usage')).toBeNull();
    });

    it('says "usage limit" when nothing structured said which pool', () => {
      seed(RESUME_AT, 'rate_limit', { scope: 'unknown' });
      renderChat();
      expect(screen.getByTestId('rate-limit-headline')).toHaveTextContent(/your usage limit/i);
    });

    // AUTO-RESUME DECIDES WHETHER A TIMER WAS SET, NOT WHETHER THE READER IS
    // TOLD (spec/12). With it off the host publishes the same block and no
    // resume time — and the bubble used to be gated on that time, so the whole
    // notice vanished and the only thing left in the transcript was the
    // provider's own sentence about a spend limit nobody overspent.
    it('shows the limit when no resume was armed at all', () => {
      seed(null, null, { scope: 'week', accountLabel: 'Default', resetsAt: RESUME_AT });
      renderChat();
      expect(screen.getByTestId('rate-limit-headline')).toHaveTextContent(
        /reached your weekly limit/i,
      );
      expect(screen.getByTestId('rate-limit-account')).toHaveTextContent('Default');
      expect(screen.getByTestId('rate-limit-countdown').textContent?.trim()).not.toBe('');
      // The controls are the point of it — Try now is how an unparked turn runs.
      expect(screen.getByTestId('rate-limit-retry')).toBeInTheDocument();
      expect(screen.getByTestId('rate-limit-auto-resume')).toBeInTheDocument();
    });

    it('promises no reset it was not told about', () => {
      seed(null, null, { scope: 'unknown' });
      renderChat();
      expect(screen.getByTestId('rate-limit-bar')).toBeInTheDocument();
      expect(screen.queryByTestId('rate-limit-countdown')).toBeNull();
    });

    it('asks the host to run the owed turn from the unparked state too', () => {
      const sent: unknown[] = [];
      setActiveWs({ send: (e: unknown) => sent.push(e) } as never);
      seed(null, null, { scope: 'week', resetsAt: RESUME_AT });
      renderChat();
      act(() => {
        screen.getByTestId('rate-limit-retry').click();
      });
      expect(sent.filter((e) => !(e as { type: string }).type.startsWith('meeting.'))).toEqual([
        { type: 'chat.resume_now_request', chatId: 'c1' },
      ]);
    });

    it('offers a manual retry, and asks the host to run the parked turn now', () => {
      const sent: unknown[] = [];
      setActiveWs({ send: (e: unknown) => sent.push(e) } as never);
      seed(RESUME_AT, 'rate_limit', { scope: 'session', resetsAt: RESUME_AT });
      renderChat();
      act(() => {
        screen.getByTestId('rate-limit-retry').click();
      });
      expect(sent.filter((e) => !(e as { type: string }).type.startsWith('meeting.'))).toEqual([
        { type: 'chat.resume_now_request', chatId: 'c1' },
      ]);
    });

    it('carries auto-resume, and writes the shared setting rather than inventing a second one', async () => {
      usePreferencesStore.setState({
        preferences: { ...DEFAULT_SHARED_SETTINGS, autoResumeRateLimit: true },
        loaded: true,
      });
      seed(RESUME_AT, 'rate_limit', { scope: 'session', resetsAt: RESUME_AT });
      renderChat();
      const box = screen.getByTestId('rate-limit-auto-resume') as HTMLInputElement;
      expect(box.checked).toBe(true);
      act(() => {
        box.click();
      });
      await vi.waitFor(() =>
        expect(vi.mocked(api.setPreferences)).toHaveBeenCalledWith({ autoResumeRateLimit: false }),
      );
    });
    // THE RESET HAS PASSED AND THE NOTICE IS STILL UP (spec/12). It used to read
    // "It should be back now." — a sentence that describes the limit as over
    // while the reply it is standing in for has still not been sent, and which
    // leaves the one control that would send it looking optional. A chat whose
    // turn has started clears the pause, so a notice standing past its own
    // reset is proof the turn has not run, and it says exactly that.
    describe('past its reset, with the turn still un-run', () => {
      it('states the turn has not run, and how long ago the limit lifted', () => {
        // Frozen, because the elapsed figure is rounded UP to the minute: a few
        // hundred ms of render time turns "20 minutes" into "21".
        const NOW = new Date('2026-09-13T12:00:00.000Z').getTime();
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
        seed(null, null, {
          scope: 'session',
          accountLabel: 'Default',
          resetsAt: NOW - 20 * 60_000,
        });
        renderChat();
        const countdown = screen.getByTestId('rate-limit-countdown');
        expect(countdown).toHaveTextContent(/That was 20 minutes ago and this turn has not run\./i);
        // Never the sentence that reads as "nothing to do here".
        expect(countdown.textContent).not.toMatch(/should be back now/i);
        vi.mocked(Date.now).mockRestore();
      });

      it('makes Try now the action rather than one of three equal controls', () => {
        seed(null, null, { scope: 'week', resetsAt: Date.now() - 60 * 60_000 });
        renderChat();
        const retry = screen.getByTestId('rate-limit-retry');
        expect(retry).toHaveAttribute('data-past-reset', 'true');
        expect(retry.className).toMatch(/rate-limit-retry-now/);
      });

      it('leaves Try now ordinary while the wait is still running', () => {
        seed(null, null, { scope: 'week', resetsAt: Date.now() + 60 * 60_000 });
        renderChat();
        const retry = screen.getByTestId('rate-limit-retry');
        expect(retry).toHaveAttribute('data-past-reset', 'false');
        expect(retry.className).not.toMatch(/rate-limit-retry-now/);
        expect(screen.getByTestId('rate-limit-countdown')).toHaveTextContent(
          /It resets in 1 hour/i,
        );
      });

      it('reads sensibly on the very tick the reset passes', () => {
        // `formatDurationWords(0)` is "any moment now", which would render as
        // "That was any moment now ago".
        const NOW = new Date('2026-09-13T12:00:00.000Z').getTime();
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
        seed(null, null, { scope: 'session', resetsAt: NOW });
        renderChat();
        expect(screen.getByTestId('rate-limit-countdown')).toHaveTextContent(
          /That was less than a minute ago and this turn has not run\./i,
        );
        vi.mocked(Date.now).mockRestore();
      });

      // An overload pause carries no block, only the instant it was armed for.
      // Its backoff elapsing without a retry is the same dead end.
      it('says the same of an overload whose backoff elapsed', () => {
        seed(Date.now() - 5 * 60_000, 'overloaded');
        renderChat();
        expect(screen.getByTestId('rate-limit-countdown')).toHaveTextContent(
          /and this turn has not run/i,
        );
      });
    });
  });
});
