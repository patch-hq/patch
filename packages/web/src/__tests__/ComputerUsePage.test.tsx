// Settings → Computer use: the "Patch is using your computer" state with its
// hands-off copy and Stop, and the idle states.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { usePresenceStore } from '../stores/presenceStore.js';
import { setActiveWs } from '../api/ws.js';
import { json, makeFetch, renderSettings, resetSettingsState } from './settingsHarness.js';

beforeEach(() => {
  resetSettingsState();
  usePresenceStore.getState().setHostOnline('d1', true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setActiveWs(null);
});

describe('Settings → Computer use', () => {
  it('says plainly that Patch is using the computer, asks for hands off, and Stop cancels', async () => {
    let active = true;
    const stops: string[] = [];
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u, init) => {
        if (u.endsWith('/api/browser-use/d1/stop') && init?.method === 'POST') {
          stops.push(u);
          active = false;
          return json({ hostId: 'd1', name: 'Mac', active: false, tabs: 0, closed: 2 });
        }
        if (u.endsWith('/api/browser-use')) {
          return json({
            hosts: [
              active
                ? { hostId: 'd1', name: 'Mac', active: true, actionLabel: 'Clicking', tabs: 1 }
                : { hostId: 'd1', name: 'Mac', active: false, tabs: 0 },
            ],
          });
        }
        return null;
      }),
    );
    renderSettings('/settings/computer');
    expect(await screen.findByTestId('computer-use-active')).toHaveTextContent(
      'Patch is using Mac right now',
    );
    expect(screen.getByText(/Hands off for a moment/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('computer-use-stop'));
    await waitFor(() => expect(stops).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('computer-use-active')).toBeNull());
    expect(await screen.findByText('Patch isn’t using this computer.')).toBeInTheDocument();
  });

  it('idle with windows left open offers to close them', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u) =>
        u.endsWith('/api/browser-use')
          ? json({ hosts: [{ hostId: 'd1', name: 'Mac', active: false, tabs: 2 }] })
          : null,
      ),
    );
    renderSettings('/settings/computer');
    expect(await screen.findByText(/2 browser windows left open/)).toBeInTheDocument();
    expect(screen.getByTestId('computer-use-stop')).toHaveTextContent('Close windows');
    expect(screen.queryByTestId('computer-use-active')).toBeNull();
  });

  it('a host that does not answer is shown as unchecked, never as idle', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u) =>
        u.endsWith('/api/browser-use')
          ? json({ hosts: [{ hostId: 'd1', name: 'Mac', error: 'did not answer' }] })
          : null,
      ),
    );
    renderSettings('/settings/computer');
    expect(await screen.findByText(/Couldn’t check: did not answer/)).toBeInTheDocument();
  });
});
