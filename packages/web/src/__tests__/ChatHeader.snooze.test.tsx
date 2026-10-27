// Snooze from the chat header (spec/14 § Chat panel header → Snooze, spec/04
// § Snooze) — patch/todo.md: "ability to snooze a chat for 2, 5, 30, 1 hour,
// 1 day, next week or custom amount of time, like in gmail".
//
// The header's Snooze row opens the Snooze sheet. Choosing a preset only selects
// it; confirming resolves `now + delta` to an ABSOLUTE timestamp, optimistically
// stamps the row and POSTs it; failure reverts and toasts (NO FALLBACK). On a
// snoozed chat the row is a direct Unsnooze.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { JSX } from 'react';
import { render as rtlRender, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatHeader } from '../components/ChatHeader.js';
import { SnoozeSheet } from '../components/SnoozeSheet.js';
import type { ChatRow } from '../stores/types.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePreferencesStore, DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';
import { api } from '../api/rest.js';

vi.mock('../api/rest.js', () => ({
  api: { deleteChat: vi.fn(), pinChat: vi.fn(), snoozeChat: vi.fn(async () => undefined) },
}));

vi.mock('../lib/voiceController.js', () => ({
  startVoiceCall: vi.fn(async () => {}),
}));

const NOW = 1_700_000_000_000;

function render(ui: JSX.Element): ReturnType<typeof rtlRender> {
  return rtlRender(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              {ui}
              <SnoozeSheet />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    chatId: 'c1',
    hostId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: 'fix layout',
    folder: '~/projects/foo',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    lastUserActivity: 0,
    awaitingPermission: false,
    lastReadSeq: -1,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    pendingWake: null,
    todos: [],
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 0,
    jobId: null,
    model: null,
    effort: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    snoozedUntil: null,
    ...overrides,
  };
}

function seed(r: ChatRow): void {
  useChatStore.setState({ chats: { [r.chatId]: r } });
}

describe('ChatHeader — snooze', () => {
  beforeEach(() => {
    // jsdom has no picker; the sheet opens it on choosing Custom.
    HTMLInputElement.prototype.showPicker = vi.fn();
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    useUiStore.getState().closeSnoozeSheet();
    vi.mocked(api.snoozeChat)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('offers every Gmail-style preset plus Custom', () => {
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    const menu = screen.getByTestId('snooze-sheet');
    for (const label of [
      '30 minutes',
      '1 hour',
      '5pm',
      'Tomorrow 9am',
      '1 day',
      'Next Monday',
      'Custom…',
    ]) {
      expect(menu).toHaveTextContent(label);
    }
  });

  it('choosing "1 hour" posts an absolute now+1h and stamps the row optimistically', async () => {
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-sheet-preset-1-hour'));
    fireEvent.click(screen.getByTestId('snooze-sheet-confirm'));
    await waitFor(() =>
      expect(api.snoozeChat).toHaveBeenCalledWith('c1', NOW + 3_600_000, expect.any(String)),
    );
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBe(NOW + 3_600_000);
    // The sheet closes once confirmed.
    expect(screen.queryByTestId('snooze-sheet')).toBeNull();
  });

  it('Next Monday resolves to the coming Monday at 8am local', async () => {
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-sheet-preset-next-monday'));
    fireEvent.click(screen.getByTestId('snooze-sheet-confirm'));
    await waitFor(() => expect(api.snoozeChat).toHaveBeenCalled());
    const at = new Date((api.snoozeChat as any).mock.calls[0][1]);
    expect(at.getDay()).toBe(1);
    expect(at.getHours()).toBe(9);
    expect(at.getTime()).toBeGreaterThan(NOW);
    expect(at.getTime() - NOW).toBeLessThanOrEqual(7 * 24 * 3_600_000);
  });

  it('each preset resolves to its own delta', async () => {
    const cases: Array<[string, number]> = [
      ['snooze-sheet-preset-30-minutes', 30 * 60_000],
      ['snooze-sheet-preset-1-day', 24 * 3_600_000],
    ];
    for (const [testId, delta] of cases) {
      const r = row();
      seed(r);
      render(<ChatHeader row={r} />);
      fireEvent.click(screen.getByTestId('action-more'));
      fireEvent.click(screen.getByTestId('action-snooze'));
      fireEvent.click(screen.getByTestId(testId));
      fireEvent.click(screen.getByTestId('snooze-sheet-confirm'));
      await waitFor(() =>
        expect(api.snoozeChat).toHaveBeenCalledWith('c1', NOW + delta, expect.any(String)),
      );
      vi.mocked(api.snoozeChat).mockClear();
      cleanup();
    }
  });

  // These three mock Date.now (like beforeEach does for NOW) rather than
  // vi.useFakeTimers — fake timers also stub setTimeout, which stalls RTL's
  // waitFor polling since nothing here advances the fake clock.
  it('"5pm" preset snoozes to today 17:00 when it is currently before 5pm', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 7, 25, 9, 0, 0).getTime());
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-sheet-preset-evening'));
    fireEvent.click(screen.getByTestId('snooze-sheet-confirm'));
    await waitFor(() =>
      expect(api.snoozeChat).toHaveBeenCalledWith(
        'c1',
        new Date(2026, 7, 25, 17, 0, 0, 0).getTime(),
        expect.any(String),
      ),
    );
  });

  it('"5pm" preset snoozes to tomorrow 17:00 when it is currently after 5pm', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 7, 25, 18, 30, 0).getTime());
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-sheet-preset-evening'));
    fireEvent.click(screen.getByTestId('snooze-sheet-confirm'));
    await waitFor(() =>
      expect(api.snoozeChat).toHaveBeenCalledWith(
        'c1',
        new Date(2026, 7, 26, 17, 0, 0, 0).getTime(),
        expect.any(String),
      ),
    );
  });

  it('"Tomorrow 9am" preset always snoozes to tomorrow 09:00, regardless of current time', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 7, 25, 23, 59, 0).getTime());
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-sheet-preset-tomorrow-morning'));
    fireEvent.click(screen.getByTestId('snooze-sheet-confirm'));
    await waitFor(() =>
      expect(api.snoozeChat).toHaveBeenCalledWith(
        'c1',
        new Date(2026, 7, 26, 9, 0, 0, 0).getTime(),
        expect.any(String),
      ),
    );
  });

  it("wakes at the account's snooze morning hour, and labels the preset with it", async () => {
    usePreferencesStore.getState().set({ ...DEFAULT_PREFERENCES, snoozeMorningHour: 7 });
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 7, 25, 12, 0, 0).getTime());
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    expect(screen.getByTestId('snooze-sheet')).toHaveTextContent('Tomorrow 7am');
    fireEvent.click(screen.getByTestId('snooze-sheet-preset-tomorrow-morning'));
    fireEvent.click(screen.getByTestId('snooze-sheet-confirm'));
    await waitFor(() =>
      expect(api.snoozeChat).toHaveBeenCalledWith(
        'c1',
        new Date(2026, 7, 26, 7, 0, 0, 0).getTime(),
        expect.any(String),
      ),
    );
    usePreferencesStore.getState().set(DEFAULT_PREFERENCES);
  });

  it('the cog closes the sheet and asks Settings to open on Chats', () => {
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-sheet-settings'));
    expect(screen.queryByTestId('snooze-sheet')).toBeNull();
    expect(useUiStore.getState().settingsPageRequest).toBe('chats');
  });

  it('Custom… snoozes to the picked date/time', async () => {
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-sheet-preset-custom'));
    const input = screen.getByTestId('snooze-sheet-custom-input') as HTMLInputElement;
    // A local datetime string, as `datetime-local` produces.
    const target = new Date(NOW + 3 * 3_600_000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const local = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}`;
    fireEvent.change(input, { target: { value: local } });
    fireEvent.click(screen.getByTestId('snooze-sheet-confirm'));
    await waitFor(() => expect(api.snoozeChat).toHaveBeenCalledTimes(1));
    const [, until] = vi.mocked(api.snoozeChat).mock.calls[0]!;
    // Minute precision — the datetime-local field has no seconds.
    expect(Math.abs((until as number) - (NOW + 3 * 3_600_000))).toBeLessThan(60_000);
  });

  it('a custom time in the past is refused without posting', async () => {
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-sheet-preset-custom'));
    const past = new Date(NOW - 3 * 3_600_000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const local = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.getMinutes())}`;
    fireEvent.change(screen.getByTestId('snooze-sheet-custom-input'), { target: { value: local } });
    fireEvent.click(screen.getByTestId('snooze-sheet-confirm'));
    expect(api.snoozeChat).not.toHaveBeenCalled();
    await waitFor(() => expect(useUiStore.getState().errors.length).toBe(1));
  });

  it('a snoozed chat’s Snooze row is a direct Unsnooze, with no sheet', async () => {
    const r = row({ snoozedUntil: NOW + 60_000 });
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    expect(screen.getByTestId('action-snooze')).toHaveTextContent('Unsnooze');
    fireEvent.click(screen.getByTestId('action-snooze'));
    expect(screen.queryByTestId('snooze-sheet')).toBeNull();
    await waitFor(() => expect(api.snoozeChat).toHaveBeenCalledWith('c1', null));
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBe(null);
  });

  it('a failed snooze reverts the row and toasts', async () => {
    vi.mocked(api.snoozeChat).mockRejectedValue(new Error('boom') as never);
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-sheet-preset-1-hour'));
    fireEvent.click(screen.getByTestId('snooze-sheet-confirm'));
    await waitFor(() =>
      expect(useUiStore.getState().errors.filter((e) => e.level === 'error').length).toBe(1),
    );
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBe(null);
  });

  it('Esc closes the sheet without snoozing', () => {
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    expect(screen.getByTestId('snooze-sheet')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('snooze-sheet')).toBeNull();
    expect(api.snoozeChat).not.toHaveBeenCalled();
  });

  it('special threads cannot be snoozed', () => {
    const r = row({ chatId: 'thread_manager' });
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    expect(screen.queryByTestId('action-snooze')).toBeNull();
  });
});
