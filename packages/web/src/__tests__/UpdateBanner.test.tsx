// The one update prompt. What these pin: there is only ever one banner, one
// sentence and one Restart button; the button does whatever is needed (relaunch
// the shell into its staged build, or reload the page); and nothing restarts on
// its own.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import {
  UPDATE_FAILED_TITLE,
  UPDATE_READY_DETAIL,
  UPDATE_READY_TITLE,
  UpdateBanner,
  updateUrgency,
} from '../components/UpdateBanner.js';
import type { DesktopUpdaterState } from '../lib/desktopBridge.js';
import { useWebUpdateStore } from '../stores/webUpdateStore.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function state(over: Partial<DesktopUpdaterState> = {}): DesktopUpdaterState {
  return {
    currentVersion: '0.1.900',
    gitSha: 'abc1234',
    builtAt: '2026-09-10T09:00:00Z',
    feedUrl: 'https://patch.example/api/desktop/latest-mac.yml',
    disabledReason: null,
    lastCheckedAt: '2026-09-17T09:00:00Z',
    lastResult: 'downloaded',
    lastError: null,
    lastErrorKind: null,
    availableVersion: '0.1.971',
    downloaded: true,
    checking: false,
    staleSince: new Date(Date.now() - HOUR).toISOString(),
    ...over,
  };
}

function installBridge(s: DesktopUpdaterState, installUpdate = vi.fn()): typeof installUpdate {
  (window as unknown as { patch?: unknown }).patch = {
    getUpdaterState: () => Promise.resolve(s),
    onUpdaterState: () => () => {},
    installUpdate,
  };
  return installUpdate;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { patch?: unknown }).patch;
  useWebUpdateStore.getState().clear();
  vi.useRealTimers();
});

describe('updateUrgency', () => {
  it('escalates with age, and only with age', () => {
    const now = Date.parse('2026-09-17T12:00:00Z');
    expect(updateUrgency(null, now)).toBe('none');
    expect(updateUrgency(new Date(now - HOUR).toISOString(), now)).toBe('ready');
    expect(updateUrgency(new Date(now - 9 * HOUR).toISOString(), now)).toBe('due');
    expect(updateUrgency(new Date(now - 4 * DAY).toISOString(), now)).toBe('overdue');
  });
});

describe('UpdateBanner', () => {
  it('shows nothing when nothing is newer', () => {
    render(<UpdateBanner />);
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('a staged shell build: one sentence, and Restart relaunches the shell', async () => {
    const install = installBridge(state());
    render(<UpdateBanner />);
    const banner = await screen.findByTestId('update-banner');
    expect(banner).toHaveTextContent(UPDATE_READY_TITLE);
    expect(banner).toHaveTextContent(UPDATE_READY_DETAIL);
    expect(install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('update-banner-restart'));
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('a new page and a staged shell together are still one banner', async () => {
    installBridge(state());
    act(() => useWebUpdateStore.getState().setAvailable('bundle-2', new Date().toISOString()));
    render(<UpdateBanner />);
    await screen.findByTestId('update-banner');
    expect(screen.getAllByTestId('update-banner')).toHaveLength(1);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('a new page only: the same banner, offered in a browser too', () => {
    act(() => useWebUpdateStore.getState().setAvailable('bundle-2', new Date().toISOString()));
    render(<UpdateBanner />);
    expect(screen.getByTestId('update-banner')).toHaveTextContent(UPDATE_READY_TITLE);
    expect(screen.getByTestId('update-banner-restart')).toHaveTextContent('Restart');
  });

  it('a shell that never restarts says so and says what to do', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installBridge(state());
    render(<UpdateBanner />);
    await screen.findByTestId('update-banner');
    fireEvent.click(screen.getByTestId('update-banner-restart'));
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    await waitFor(() =>
      expect(screen.getByTestId('update-banner')).toHaveTextContent(UPDATE_FAILED_TITLE),
    );
    expect(screen.getByTestId('update-banner-detail')).toHaveTextContent('open it again');
    expect(screen.getByTestId('update-banner-restart')).toHaveTextContent('Try again');
  });
});
