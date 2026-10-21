import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StatusBadge } from '../components/StatusBadge.js';

afterEach(cleanup);

describe('StatusBadge failed tooltip', () => {
  it('says why the chat failed, in full', () => {
    render(<StatusBadge badge="errored" failureReason="Claude session expired — sign in again" />);
    const badge = screen.getByTestId('badge-errored');
    expect(badge.getAttribute('title')).toBe('Claude session expired — sign in again');
    expect(badge.hasAttribute('data-tooltip-full')).toBe(true);
  });

  it('falls back to the state name only when no reason is known', () => {
    render(<StatusBadge badge="errored" />);
    expect(screen.getByTestId('badge-errored').getAttribute('title')).toBe('Failed');
  });
});
