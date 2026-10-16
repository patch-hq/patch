// Settings → Activity ("things agents did"): lists the account's cross-chat
// tool-call log (GET /api/tool-log).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { json, makeFetch, renderSettings, resetSettingsState } from './settingsHarness.js';

beforeEach(() => {
  resetSettingsState();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Settings → Activity', () => {
  it('shows the empty state when there are none', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (url) => {
        if (url.includes('/api/tool-log')) return json({ entries: [], truncated: false });
        return null;
      }),
    );
    renderSettings('/settings/activity');
    await waitFor(() =>
      expect(screen.getByTestId('activity-empty')).toHaveTextContent('No tool calls'),
    );
  });

  it('lists entries newest-first, with host, caller/target chat and failure reason', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (url) => {
        if (url.includes('/api/tool-log')) {
          return json({
            entries: [
              {
                ts: 1000,
                tool: 'patch_peek',
                callerChatId: 'c-1',
                targetChatId: 'c-2',
                durationMs: 3,
                ok: true,
                hostId: 'hetzner',
              },
              {
                ts: 2000,
                tool: 'patch_send_to',
                targetChatId: 'c-2',
                durationMs: 5,
                ok: false,
                err: 'rate_limited',
                hostId: 'hetzner',
              },
            ],
            truncated: false,
          });
        }
        return null;
      }),
    );
    renderSettings('/settings/activity');
    await waitFor(() => expect(screen.getByTestId('activity-row-0')).toBeTruthy());
    // Newest first: the rate-limited send_to (ts 2000) leads.
    expect(screen.getByTestId('activity-row-0')).toHaveTextContent('patch_send_to');
    expect(screen.getByTestId('activity-row-0')).toHaveTextContent('rate_limited');
    expect(screen.getByTestId('activity-row-1')).toHaveTextContent('patch_peek');
    expect(screen.getByTestId('activity-row-1')).toHaveTextContent('hetzner');
    expect(screen.getByTestId('activity-row-1')).toHaveTextContent('from c-1');
    expect(screen.getByTestId('activity-row-1')).toHaveTextContent('to c-2');
  });

  it('shows the truncated note and a load-older button that pages the window back', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (url) => {
        if (url.includes('/api/tool-log')) {
          seen.push(url);
          return json({
            entries: [{ ts: 1000, tool: 'patch_peek', durationMs: 1, ok: true, hostId: 'hetzner' }],
            truncated: true,
          });
        }
        return null;
      }),
    );
    renderSettings('/settings/activity');
    await waitFor(() => expect(screen.getByTestId('activity-truncated')).toBeTruthy());
    const before = seen.length;
    screen.getByTestId('activity-load-older').click();
    await waitFor(() => expect(seen.length).toBeGreaterThan(before));
  });

  it('shows the error state when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (url) => {
        if (url.includes('/api/tool-log')) {
          return json({ message: 'boom' }, 502);
        }
        return null;
      }),
    );
    renderSettings('/settings/activity');
    await waitFor(() => expect(screen.getByTestId('activity-error')).toHaveTextContent('boom'));
  });
});
