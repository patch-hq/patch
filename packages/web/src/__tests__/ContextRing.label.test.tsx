import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContextRing } from '../components/ContextRing.js';

describe('ContextRing', () => {
  it('shows only the ring, with no text beside it', () => {
    render(<ContextRing chatId="nope" />);
    const ring = screen.getByTestId('context-ring');
    expect(ring.textContent).toBe('');
    expect(screen.queryByTestId('context-ring-label')).toBeNull();
  });
});
