// macOS only asks for notification permission when an app first posts one, and
// Patch posts nothing until something happens, so a new install is never asked
// and later alerts are silently dropped. Post one welcome notification on the
// first launch so macOS shows its own permission prompt; remembered in a marker
// file in userData so it happens once per device.

import { existsSync, writeFileSync } from 'node:fs';

export interface NotificationPromptOptions {
  platform: NodeJS.Platform;
  /** Marker file; its existence means macOS has already been asked. */
  file: string;
  /** Posts the native notification. */
  show: () => void;
}

/** Returns true when the notification was posted. */
export function askNotificationPermissionOnce(opts: NotificationPromptOptions): boolean {
  if (opts.platform !== 'darwin' || existsSync(opts.file)) return false;
  opts.show();
  writeFileSync(opts.file, JSON.stringify({ askedAt: new Date().toISOString() }));
  return true;
}
