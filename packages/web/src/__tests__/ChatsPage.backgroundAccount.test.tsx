// Settings → Chats → Account for titles and status: the shared
// `backgroundAccount` (spec/10 § Choosing an account), Automatic or any Claude
// account by its label.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatsPage } from '../routes/settings/ChatsPage.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import * as write from '../routes/settings/sharedWrite.js';
import { loadShared } from './sharedHelpers.js';

describe('Settings → Chats → Account for titles and status', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('offers Automatic and every Claude account by label, and writes the choice', () => {
    const spy = vi.spyOn(write, 'patchShared').mockResolvedValue(true);
    loadShared({
      settings: { backgroundAccount: 'auto' },
      secrets: {
        claude: [
          { id: 'a1', label: 'Personal', connected: true },
          { id: 'a2', label: 'Max', connected: true },
          {
            id: 'b1',
            label: 'Work Bedrock',
            connected: true,
            auto: false,
            bedrock: {
              hostId: 'd1',
              awsProfile: 'work-bedrock',
              awsRegion: 'eu-west-2',
              regionPrefix: 'auto',
              monthlyCapUsd: 100,
              spentUsd: 0,
              spentMonth: '2026-11',
            },
          },
        ],
      },
    });
    render(
      <MemoryRouter>
        <ChatsPage />
      </MemoryRouter>,
    );
    const select = screen.getByTestId('background-account-select') as HTMLSelectElement;
    expect(screen.getByTestId('background-account')).toHaveTextContent(
      'Account for titles and status',
    );
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['auto', 'Automatic'],
      ['a1', 'Personal'],
      ['a2', 'Max'],
      ['b1', 'Work Bedrock'],
    ]);
    expect(select.value).toBe('auto');
    fireEvent.change(select, { target: { value: 'b1' } });
    expect(spy).toHaveBeenCalledWith('account for titles and status', { backgroundAccount: 'b1' });
  });

  it('shows the account the setting names', () => {
    loadShared({
      settings: { backgroundAccount: 'a2' },
      secrets: {
        claude: [
          { id: 'a1', label: 'Personal', connected: true },
          { id: 'a2', label: 'Max', connected: true },
        ],
      },
    });
    expect(usePreferencesStore.getState().preferences.backgroundAccount).toBe('a2');
    render(
      <MemoryRouter>
        <ChatsPage />
      </MemoryRouter>,
    );
    expect((screen.getByTestId('background-account-select') as HTMLSelectElement).value).toBe('a2');
  });
});
