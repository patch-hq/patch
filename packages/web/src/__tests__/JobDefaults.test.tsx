// The job defaults (default model, account autonomy prompt) live on the Jobs
// page, not in Settings (spec/14 § Jobs view).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JobsRoute } from '../routes/JobsRoute.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { SETTINGS_PAGES } from '../routes/settings/pages.js';
import { reportHost } from './presenceHelpers.js';
import { json, makeFetch, preferencesServer, resetSettingsState } from './settingsHarness.js';

function renderJobsPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/jobs']}>
        <JobsRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('job defaults on the Jobs page', () => {
  beforeEach(() => resetSettingsState());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Settings no longer has a Jobs page', () => {
    expect(SETTINGS_PAGES.map((p) => p.id)).not.toContain('jobs');
  });

  it('the account autonomy prompt is edited on the Jobs page, and Reset restores the built-in default', async () => {
    const DEFAULT = "You are running autonomously, don't stop to ask the user questions";
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    renderJobsPage();
    fireEvent.click(await screen.findByTestId('job-autonomy-prompt-default-edit'));
    const box = screen.getByTestId('job-autonomy-prompt-default') as HTMLTextAreaElement;
    expect(box.value).toBe(DEFAULT);
    fireEvent.change(box, { target: { value: 'House rule.' } });
    fireEvent.click(screen.getByTestId('job-autonomy-prompt-default-save'));
    await waitFor(() => expect(server.writes).toEqual([{ jobAutonomyPrompt: 'House rule.' }]));
    fireEvent.click(screen.getByTestId('job-autonomy-prompt-default-edit'));
    expect((screen.getByTestId('job-autonomy-prompt-default') as HTMLTextAreaElement).value).toBe(
      'House rule.',
    );
    fireEvent.click(screen.getByTestId('job-autonomy-prompt-default-reset'));
    await waitFor(() => expect(server.writes[1]).toEqual({ jobAutonomyPrompt: DEFAULT }));
  });

  it('the default model for jobs is picked on the Jobs page and written to the account', async () => {
    const server = preferencesServer(() => ({ ...usePreferencesStore.getState().preferences }));
    vi.stubGlobal(
      'fetch',
      makeFetch({}, (u, init) =>
        u.includes('/api/models')
          ? json({
              models: [
                { id: 'claude-opus-5', label: 'Opus 5' },
                { id: 'claude-sonnet-5', label: 'Sonnet 5' },
              ],
            })
          : server.handler(u, init),
      ),
    );
    reportHost('d1', { hostName: 'mac' });
    renderJobsPage();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Sonnet 5' })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId('job-default-model'), {
      target: { value: 'claude-sonnet-5' },
    });
    await waitFor(() => expect(server.writes).toEqual([{ jobDefaultModel: 'claude-sonnet-5' }]));
  });
});
