import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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
});
