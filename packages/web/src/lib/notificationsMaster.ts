// The master "Notifications" switch for this device (Settings → Notifications).
// Per device and remembered. In the desktop app main owns it (the tray menu
// flips it too) and raises no toast while it is off; in a plain browser it is
// this browser's localStorage and gates the web Notification. Either way the
// in-app bell keeps collecting.

import { getDesktopBridge } from './desktopBridge.js';

const KEY = 'patch.notifications.off';

/** Browser-side state; the desktop app's lives in its main process. */
export function browserNotificationsOff(): boolean {
  return localStorage.getItem(KEY) === '1';
}

export function setBrowserNotificationsOff(off: boolean): void {
  if (off) localStorage.setItem(KEY, '1');
  else localStorage.removeItem(KEY);
}

export async function readNotificationsOff(): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (bridge?.notificationsOff) return await bridge.notificationsOff();
  return browserNotificationsOff();
}

export async function writeNotificationsOff(off: boolean): Promise<void> {
  const bridge = getDesktopBridge();
  if (bridge?.setNotificationsOff) {
    await bridge.setNotificationsOff(off);
    return;
  }
  setBrowserNotificationsOff(off);
}

import type { NotificationLevel } from '@patch/wire';

/** The surface kinds that can be notified; a terminal or voice device cannot. */
export const NOTIFIABLE_KINDS: ReadonlySet<string> = new Set(['web', 'desktop', 'mobile']);

/** A device with no entry is on `all`. */
export function levelOf(
  levels: Readonly<Record<string, NotificationLevel>>,
  surfaceId: string,
): NotificationLevel {
  return levels[surfaceId] ?? 'all';
}
