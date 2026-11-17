// This phone's own level in the synced `deviceNotifications` map decides its
// local master switch: Off drops the push token, anything else registers it.
// Runs on every settings change, so a level set from another device lands here.

import { useSettingsStore } from '../stores/settingsStore';
import { useUiStore } from '../stores/uiStore';
import { notificationsOff } from './notificationsMaster';
import { setNotificationsOff } from './push';

let unsubscribe: (() => void) | null = null;
let applying = false;

export function startNotificationLevelSync(): void {
  if (unsubscribe) return;
  unsubscribe = useSettingsStore.subscribe((state) => {
    const data = state.data;
    const own = data?.devices.find((d) => d.isCurrent);
    if (!data || !own || applying) return;
    const wantOff = data.preferences.deviceNotifications[own.surfaceId] === 'off';
    if (wantOff === notificationsOff()) return;
    applying = true;
    setNotificationsOff(wantOff)
      .catch((e: Error) => useUiStore.getState().pushError(`notifications: ${e.message}`))
      .finally(() => {
        applying = false;
      });
  });
}

export function stopNotificationLevelSync(): void {
  unsubscribe?.();
  unsubscribe = null;
}
