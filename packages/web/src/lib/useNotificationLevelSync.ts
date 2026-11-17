// Keeps this device's own master switch (desktop main / browser storage — what
// the tray menu and local toasts obey) in step with its synced level in
// `deviceNotifications`, both ways: a level set from another device lands here,
// and a tray flip is written back so every device sees it.

import { useEffect } from 'react';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/rest.js';
import { patchShared } from '../routes/settings/sharedWrite.js';
import { getDesktopBridge } from './desktopBridge.js';
import { levelOf, writeNotificationsOff } from './notificationsMaster.js';

export function useNotificationLevelSync(): void {
  // Same query (and cache entry) the Devices page reads.
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings(),
    refetchInterval: 15_000,
  });
  const levels = usePreferencesStore((s) => s.preferences.deviceNotifications);
  const loaded = usePreferencesStore((s) => s.loaded);
  const pushError = useUiStore((s) => s.pushError);
  const ownId = settings?.devices?.find((d) => d.isCurrent)?.surfaceId ?? null;
  const level = ownId === null ? null : levelOf(levels, ownId);

  useEffect(() => {
    if (!loaded || level === null) return;
    writeNotificationsOff(level === 'off').catch((err: unknown) =>
      pushError(`notifications: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, [loaded, level, pushError]);

  useEffect(() => {
    if (ownId === null || level === null) return;
    return getDesktopBridge()?.onNotificationsOffChange?.((off) => {
      if (off && level !== 'off') {
        void patchShared('notifications', { deviceNotifications: { ...levels, [ownId]: 'off' } });
      } else if (!off && level === 'off') {
        void patchShared('notifications', { deviceNotifications: { ...levels, [ownId]: 'all' } });
      }
    });
  }, [ownId, level, levels]);
}
