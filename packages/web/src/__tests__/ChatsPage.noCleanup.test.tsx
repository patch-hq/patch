// Session retention is each provider's own setting, shown once under
// Settings → Providers (spec/10 § Provider settings). Settings → Chats no
// longer carries a second, older cleanup setting beside it.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatsPage } from '../routes/settings/ChatsPage.js';
import { ProviderOwnSettings } from '../routes/settings/ProvidersPage.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';

describe('session retention lives in one place', () => {
  afterEach(() => cleanup());

  it('Settings → Chats has no cleanup group', () => {
    usePreferencesStore.setState({ loaded: true });
    render(
      <MemoryRouter>
        <ChatsPage />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('settings-cleanup')).toBeNull();
    expect(screen.queryByTestId('cleanup-period-days')).toBeNull();
  });

  it('Settings → Providers says Codex has no session-retention setting', () => {
    usePreferencesStore.setState({ loaded: true });
    render(
      <MemoryRouter>
        <ProviderOwnSettings />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('provider-settings-codex')).toBeTruthy();
    expect(screen.getByTestId('provider-settings-note-codex').textContent).toMatch(
      /no setting to delete old sessions/,
    );
    // Claude Code's own retention is still the one editable row.
    expect(screen.getByTestId('provider-settings-claude')).toBeTruthy();
  });
});
