import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('../api/rest.js', () => ({
  api: { getNotifications: vi.fn(), markNotificationsRead: vi.fn() },
}));

const { useNotificationsStore } = await import('../stores/notificationsStore.js');
const { NotificationBell } = await import('../components/NotificationBell.js');

describe('NotificationBell job-failure entries', () => {
  it('links the run and the job', () => {
    useNotificationsStore.setState({
      items: [
        {
          id: 'n1',
          jobId: 'j_1',
          runTs: 1234,
          message: 'Photo triage: gate broke',
          importance: 'normal',
          sentAt: Date.now(),
          readAt: null,
        },
      ],
      unread: 1,
      error: null,
      load: async () => {},
    });
    render(
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('notif-bell'));
    expect(screen.getByTestId('notif-run-n1').getAttribute('href')).toBe('/jobs/j_1?run=1234');
    expect(screen.getByTestId('notif-job-n1').getAttribute('href')).toBe('/jobs/j_1');
  });

  it('late-fire entry (no runTs) has no Run link and opens the job without ?run=', () => {
    useNotificationsStore.setState({
      items: [
        {
          id: 'n2',
          jobId: 'j_2',
          message: 'Photo triage: fire missed, host was down',
          importance: 'normal',
          sentAt: Date.now(),
          readAt: null,
        },
      ],
      unread: 1,
      error: null,
      load: async () => {},
    });
    const Where = () => {
      const l = useLocation();
      return <div data-testid="where">{l.pathname + l.search}</div>;
    };
    render(
      <MemoryRouter>
        <NotificationBell />
        <Where />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('notif-bell'));
    expect(screen.queryByTestId('notif-run-n2')).toBeNull();
    expect(screen.getByTestId('notif-job-n2').getAttribute('href')).toBe('/jobs/j_2');
    fireEvent.click(screen.getByTestId('notif-item-n2'));
    expect(screen.getByTestId('where').textContent).toBe('/jobs/j_2');
  });
});
