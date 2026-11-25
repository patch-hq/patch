// The setup's bar is the same length with or without an AI connected, so it
// never grows part-way through (4 dashes, then 5).

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WelcomeRoute } from '../routes/WelcomeRoute.js';
import { clearSharedAccounts, setSharedAccounts } from './presenceHelpers.js';

function steps(): number {
  const label = screen.getByLabelText(/^Step 1 of /).getAttribute('aria-label') ?? '';
  return Number(/of (\d+)/.exec(label)?.[1]);
}

describe('setup with and without an AI', () => {
  afterEach(() => {
    cleanup();
    clearSharedAccounts();
  });

  it('keeps the same step count whether or not an AI is connected', () => {
    setSharedAccounts({ claude: [{ connected: false }], codex: [{ connected: false }] });
    render(
      <MemoryRouter>
        <WelcomeRoute />
      </MemoryRouter>,
    );
    const without = steps();
    cleanup();
    setSharedAccounts({ claude: [{ connected: true }] });
    render(
      <MemoryRouter>
        <WelcomeRoute />
      </MemoryRouter>,
    );
    expect(steps()).toBe(without);
  });
});
