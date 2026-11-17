// The device's master notifications switch (Settings → Notifications). Per
// device, remembered on the device, never account-wide. While it is off this
// phone gets no push (its token is dropped from the server) and shows no
// notification it somehow still receives; the in-app bell is unaffected.

import { store } from './credential';

const KEY = 'patch.notifications.off';

export function notificationsOff(): boolean {
  return store().getBoolean(KEY) === true;
}

export function persistNotificationsOff(off: boolean): void {
  store().set(KEY, off);
}
