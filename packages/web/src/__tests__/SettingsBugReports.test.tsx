// Settings → Bug reports: the automatic-filing switch and the Report a bug form.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { makeFetch, renderSettings, resetSettingsState } from './settingsHarness.js';

const STATUS = {
  enabled: false,
  repo: 'o/r',
  tokenConfigured: true,
  pending: 0,
  filed: 2,
  lastError: null,
};

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fetchWith(extra: (u: string, init?: RequestInit) => Response | undefined) {
  return makeFetch({}, (u, init) => {
    if (u.includes('/api/issue-')) return extra(u, init) ?? null;
    return null;
  });
}

beforeEach(() => resetSettingsState());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Settings → Bug reports', () => {
  it('shows automatic filing off by default and turns it on', async () => {
    let enabled = false;
    const f = fetchWith((u, init) => {
      if (init?.method === 'PUT') {
        enabled = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled;
      }
      return respond({ ...STATUS, enabled });
    });
    vi.stubGlobal('fetch', f);
    renderSettings('/settings/bugs');
    const toggle = (await screen.findByTestId('issue-reporting-toggle')) as HTMLInputElement;
    await waitFor(() =>
      expect(screen.getByTestId('issue-reporting-counts-value')).toHaveTextContent('2 / 0'),
    );
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect((screen.getByTestId('issue-reporting-toggle') as HTMLInputElement).checked).toBe(true),
    );
    expect(enabled).toBe(true);
  });

  it('says so when it is on but the server has no token', async () => {
    vi.stubGlobal(
      'fetch',
      fetchWith(() => respond({ ...STATUS, enabled: true, tokenConfigured: false })),
    );
    renderSettings('/settings/bugs');
    expect(await screen.findByTestId('issue-reporting-no-token')).toBeInTheDocument();
  });

  it('files a manual report and links the issue', async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      fetchWith((u, init) => {
        if (u.endsWith('/api/issue-reports')) {
          sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return respond({ ok: true, url: 'https://github.com/o/r/issues/5' });
        }
        return respond(STATUS);
      }),
    );
    renderSettings('/settings/bugs');
    const send = await screen.findByTestId('bug-send');
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByTestId('bug-title'), { target: { value: 'Send is dead' } });
    fireEvent.change(screen.getByTestId('bug-description'), {
      target: { value: 'nothing happens' },
    });
    fireEvent.click(send);
    expect(await screen.findByTestId('bug-filed')).toHaveTextContent('issues/5');
    expect(sent).toMatchObject({
      title: 'Send is dead',
      surface: 'web',
      description: 'nothing happens',
    });
  });

  it('shows the reason when filing fails', async () => {
    vi.stubGlobal(
      'fetch',
      fetchWith((u) =>
        u.endsWith('/api/issue-reports') ? respond({ error: 'GitHub 403' }, 502) : respond(STATUS),
      ),
    );
    renderSettings('/settings/bugs');
    fireEvent.change(await screen.findByTestId('bug-title'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('bug-send'));
    expect(await screen.findByTestId('bug-error')).toHaveTextContent('GitHub 403');
  });
});
