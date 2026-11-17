import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContextRing } from '../components/ContextRing.js';

describe('ContextRing before the chat is measured', () => {
  it('says in visible text what the gauge is, not only on hover', () => {
    render(<ContextRing chatId="nope" />);
    expect(screen.getByTestId('context-ring-label')).toHaveTextContent(/context/i);
  });
});
