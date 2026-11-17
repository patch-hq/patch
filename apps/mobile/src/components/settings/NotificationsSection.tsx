// Settings → Notifications: this device's master switch. Per device and
// remembered; the in-app bell keeps collecting either way.

import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Linking } from 'react-native';
import * as Notifications from 'expo-notifications';
import { SettingsSection } from '../SettingsSection';
import { SettingsPage } from './SettingsPage';
import { NoticeRow } from './HostSwitcher';
import { Row, SettingsButton, ToggleRow } from './ui';
import { notificationsOff } from '../../lib/notificationsMaster';
import { setNotificationsOff } from '../../lib/push';
import { useUiStore } from '../../stores/uiStore';

export function NotificationsPage(): React.ReactElement {
  const pushError = useUiStore((s) => s.pushError);
  const [off, setOff] = useState<boolean>(notificationsOff());
  const [busy, setBusy] = useState(false);
  const [granted, setGranted] = useState<boolean | null>(null);

  const readPermission = useCallback(() => {
    Notifications.getPermissionsAsync().then(
      (p) => setGranted(p.granted),
      (e: Error) => pushError(`notification permission: ${e.message}`),
    );
  }, [pushError]);

  useEffect(() => {
    readPermission();
    // Coming back from system settings re-reads it.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') readPermission();
    });
    return () => sub.remove();
  }, [readPermission]);

  async function change(nextOff: boolean): Promise<void> {
    setBusy(true);
    try {
      await setNotificationsOff(nextOff);
      setOff(nextOff);
    } catch (e) {
      setOff(notificationsOff());
      pushError(`notifications: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      readPermission();
    }
  }

  return (
    <SettingsPage title="Notifications" testID="settings-page-notifications">
      <SettingsSection testID="settings-notifications">
        <ToggleRow
          label="Notifications"
          subtitle={off ? 'Off on this device. The bell in the app still collects them.' : 'On'}
          testID="notifications-master"
          value={!off}
          disabled={busy}
          onChange={(on) => void change(!on)}
        />
        {granted === false && !off ? (
          <Row
            title="Blocked in system settings"
            subtitle="Android is not letting Patch show notifications."
            right={
              <SettingsButton
                label="Open settings"
                variant="quiet"
                testID="notifications-open-settings"
                onPress={() => void Linking.openSettings()}
              />
            }
          />
        ) : null}
        {granted === false && off ? <NoticeRow text="Also blocked in system settings." /> : null}
      </SettingsSection>
    </SettingsPage>
  );
}
