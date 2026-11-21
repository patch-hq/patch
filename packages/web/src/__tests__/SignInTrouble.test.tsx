import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SignInTrouble } from '../components/SignInTrouble.js';

describe('SignInTrouble', () => {
  it('says what went wrong once the options open, beside Try again', () => {
    const onRetry = vi.fn();
    render(
      <SignInTrouble testId="x" happened="Claude did not approve the sign-in." onRetry={onRetry} />,
    );
    expect(screen.queryByTestId('x-trouble-reason')).toBeNull();
    fireEvent.click(screen.getByTestId('x-trouble'));
    expect(screen.getByTestId('x-trouble-reason')).toHaveTextContent(
      'Claude did not approve the sign-in.',
    );
    fireEvent.click(screen.getByTestId('x-retry'));
    expect(onRetry).toHaveBeenCalled();
  });
});
