// The notifications permission is asked on its own step, not at launch.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WelcomeRoute } from '../routes/WelcomeRoute.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { clearSharedAccounts, setSharedAccounts } from './presenceHelpers.js';

describe('setup notifications step', () => {
  afterEach(() => {
    cleanup();
    clearSharedAccounts();
    delete (window as unknown as { patch?: unknown }).patch;
  });

  it('asks only when the person presses the button', async () => {
    const ask = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { patch: unknown }).patch = { askNotifications: ask };
    usePreferencesStore.setState({ loaded: true });
    // No AI connected: the model step is left out, so the page goes straight on.
    setSharedAccounts({ claude: [{ connected: false }], codex: [{ connected: false }] });
    render(
      <MemoryRouter>
        <WelcomeRoute />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTestId('welcome-skip')); // providers
    await waitFor(() =>
      expect((screen.getByTestId('welcome-next') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('welcome-next')); // permissions
    await screen.findByTestId('welcome-notifications');
    expect(ask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('welcome-next'));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await screen.findByTestId('welcome-phone');
  });

  it('has no such step where the shell cannot ask', () => {
    setSharedAccounts({ claude: [{ connected: true }] });
    render(
      <MemoryRouter>
        <WelcomeRoute />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText(/^Step 1 of 4$/)).toBeTruthy();
  });
});
