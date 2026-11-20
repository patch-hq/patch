// Settings → Manager → Voice tools: which tools the Manager's voice has on a call.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MANAGER_VOICE_TOOL_IDS } from '@patch/wire';
import { ManagerPage } from '../routes/settings/ManagerPage.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import * as write from '../routes/settings/sharedWrite.js';

describe('Settings → Manager → Voice tools', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows every tool and writes the list without the one switched off', () => {
    const spy = vi.spyOn(write, 'patchShared').mockResolvedValue(undefined as never);
    usePreferencesStore.setState({
      loaded: true,
      preferences: {
        ...usePreferencesStore.getState().preferences,
        managerVoiceTools: [...MANAGER_VOICE_TOOL_IDS],
      },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ManagerPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    for (const id of MANAGER_VOICE_TOOL_IDS) {
      expect((screen.getByTestId(`manager-tool-${id}-toggle`) as HTMLInputElement).checked).toBe(
        true,
      );
    }
    fireEvent.click(screen.getByTestId('manager-tool-add_event-toggle'));
    expect(spy).toHaveBeenCalledWith('Manager voice tools', {
      managerVoiceTools: MANAGER_VOICE_TOOL_IDS.filter((id) => id !== 'add_event'),
    });
  });

  it('switching a tool back on restores it in catalogue order', () => {
    const spy = vi.spyOn(write, 'patchShared').mockResolvedValue(undefined as never);
    usePreferencesStore.setState({
      loaded: true,
      preferences: {
        ...usePreferencesStore.getState().preferences,
        managerVoiceTools: ['find_chats', 'ask_agent'],
      },
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ManagerPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('manager-tool-add_task-toggle'));
    expect(spy).toHaveBeenCalledWith('Manager voice tools', {
      managerVoiceTools: ['find_chats', 'add_task', 'ask_agent'],
    });
  });
});
