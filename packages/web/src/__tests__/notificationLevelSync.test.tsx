// The device's own switch (browser storage here; the tray in the desktop app)
// follows its synced level, and a tray flip is written back to the account.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useNotificationLevelSync } from '../lib/useNotificationLevelSync.js';
import { makeFetch, preferencesServer, resetSettingsState } from './settingsHarness.js';
import { loadShared } from './sharedHelpers.js';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => resetSettingsState());
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { patch?: unknown }).patch;
  localStorage.removeItem('patch.notifications.off');
});

describe('useNotificationLevelSync', () => {
  it('a level set from another device turns this browser off, and back on', async () => {
    vi.stubGlobal('fetch', makeFetch());
    loadShared({ settings: { deviceNotifications: { 'web-dev-1': 'off' } } });
    renderHook(() => useNotificationLevelSync(), { wrapper });
    await waitFor(() => expect(localStorage.getItem('patch.notifications.off')).toBe('1'));
    act(() => {
      usePreferencesStore.getState().apply({
        ...usePreferencesStore.getState().shared!,
        settings: { ...usePreferencesStore.getState().preferences, deviceNotifications: {} },
      } as never);
    });
    await waitFor(() => expect(localStorage.getItem('patch.notifications.off')).toBeNull());
  });

  it('a tray flip in the desktop app is written to the account as this device’s level', async () => {
    const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    let flip: ((off: boolean) => void) | undefined;
    (window as unknown as { patch: unknown }).patch = {
      notificationsOff: async () => false,
      setNotificationsOff: async () => undefined,
      onNotificationsOffChange: (cb: (off: boolean) => void) => {
        flip = cb;
        return () => undefined;
      },
    };
    loadShared({ settings: { deviceNotifications: { 'mob-7': 'urgent' } } });
    renderHook(() => useNotificationLevelSync(), { wrapper });
    await waitFor(() => expect(flip).toBeDefined());
    act(() => flip?.(true));
    await waitFor(() =>
      expect(server.writes).toContainEqual({
        deviceNotifications: { 'mob-7': 'urgent', 'web-dev-1': 'off' },
      }),
    );
  });
});
