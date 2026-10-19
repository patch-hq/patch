// The sidebar's job-alert items: what each shows, and that dismissing calls
// the server and removes the item. A load failure is shown, never "no alerts".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api, type JobAlertView } from '../api/rest.js';
import { useJobAlertsStore } from '../stores/jobAlertsStore.js';
import { JobAlerts } from '../components/JobAlerts.js';

const alert = (over: Partial<JobAlertView> = {}): JobAlertView => ({
  jobId: 'j_1',
  jobName: 'Cadence monitor agents',
  status: 'dispatch-error',
  ts: 1,
  reason: 'ChatGPT is not signed in on the host that runs this job.',
  fix: 'Sign in to ChatGPT in Settings → Hosts.',
  detail: 'x',
  fixPath: '/settings/hosts',
  ...over,
});

const mount = () =>
  render(
    <MemoryRouter>
      <JobAlerts />
    </MemoryRouter>,
  );

beforeEach(() => useJobAlertsStore.setState({ alerts: null, error: null }));
afterEach(() => vi.restoreAllMocks());

describe('JobAlerts', () => {
  it('names the job, gives the reason and links the fix', async () => {
    vi.spyOn(api, 'listJobAlerts').mockResolvedValue({ alerts: [alert()] });
    mount();
    expect(await screen.findByTestId('job-alert-name')).toHaveTextContent('Cadence monitor agents');
    expect(screen.getByTestId('job-alert-reason')).toHaveTextContent('not signed in');
    expect(screen.getByRole('link', { name: /Sign in to ChatGPT in Settings/ })).toHaveAttribute(
      'href',
      '/settings/hosts',
    );
  });

  it('shows the fix as plain text when it is not a page', async () => {
    vi.spyOn(api, 'listJobAlerts').mockResolvedValue({
      alerts: [alert({ fixPath: undefined, fix: 'Edit the job.' })],
    });
    mount();
    expect(await screen.findByTestId('job-alert-fix')).toHaveTextContent('Edit the job.');
    expect(screen.queryByRole('link', { name: 'Edit the job.' })).toBeNull();
  });

  it('renders nothing when there are no alerts', async () => {
    const spy = vi.spyOn(api, 'listJobAlerts').mockResolvedValue({ alerts: [] });
    const { container } = mount();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('dismiss calls the server and removes the item', async () => {
    vi.spyOn(api, 'listJobAlerts').mockResolvedValue({
      alerts: [alert(), alert({ jobId: 'j_2', jobName: 'B' })],
    });
    const del = vi.spyOn(api, 'dismissJobAlert').mockResolvedValue({ ok: true });
    mount();
    fireEvent.click((await screen.findAllByTestId('job-alert-dismiss'))[0]!);
    await waitFor(() => expect(screen.getAllByTestId('job-alert')).toHaveLength(1));
    expect(del).toHaveBeenCalledWith('j_1');
  });

  it('keeps the item and shows the error when dismiss fails', async () => {
    vi.spyOn(api, 'listJobAlerts').mockResolvedValue({ alerts: [alert()] });
    vi.spyOn(api, 'dismissJobAlert').mockRejectedValue(new Error('nope'));
    mount();
    fireEvent.click(await screen.findByTestId('job-alert-dismiss'));
    expect(await screen.findByTestId('job-alerts-error')).toHaveTextContent('nope');
  });

  it('shows a load failure instead of an empty list', async () => {
    vi.spyOn(api, 'listJobAlerts').mockRejectedValue(new Error('offline'));
    mount();
    expect(await screen.findByTestId('job-alerts-error')).toHaveTextContent('offline');
  });
});
