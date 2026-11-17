// Settings → Chats → Cleanup: the cleanupPeriodDays shared setting.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatsPage } from '../routes/settings/ChatsPage.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import * as write from '../routes/settings/sharedWrite.js';

describe('Settings → Chats → Cleanup', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the period and writes only a positive whole number', () => {
    const spy = vi.spyOn(write, 'patchShared').mockResolvedValue(undefined as never);
    usePreferencesStore.setState({
      loaded: true,
      preferences: { ...usePreferencesStore.getState().preferences, cleanupPeriodDays: 30 },
    });
    render(
      <MemoryRouter>
        <ChatsPage />
      </MemoryRouter>,
    );
    const input = screen.getByTestId('cleanup-period-days') as HTMLInputElement;
    expect(input.value).toBe('30');
    for (const v of ['0', '2.5', '30']) {
      fireEvent.change(input, { target: { value: v } });
      fireEvent.blur(input);
    }
    expect(spy).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '14' } });
    fireEvent.blur(input);
    expect(spy).toHaveBeenCalledWith('cleanup period', { cleanupPeriodDays: 14 });
  });

  it('Never writes 0, disables the days box, and turning it off restores the default', () => {
    const spy = vi.spyOn(write, 'patchShared').mockResolvedValue(undefined as never);
    const setDays = (d: number): void =>
      usePreferencesStore.setState({
        loaded: true,
        preferences: { ...usePreferencesStore.getState().preferences, cleanupPeriodDays: d },
      });
    setDays(30);
    const { unmount } = render(
      <MemoryRouter>
        <ChatsPage />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('cleanup-never-toggle'));
    expect(spy).toHaveBeenCalledWith('cleanup period', { cleanupPeriodDays: 0 });
    unmount();
    setDays(0);
    render(
      <MemoryRouter>
        <ChatsPage />
      </MemoryRouter>,
    );
    expect((screen.getByTestId('cleanup-period-days') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('cleanup-never-toggle'));
    expect(spy).toHaveBeenLastCalledWith('cleanup period', { cleanupPeriodDays: 30 });
  });
});
