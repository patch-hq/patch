// Settings → Notifications: every phone and computer signed in, each with its
// own level, plus the master switch that means "all devices". The levels are
// account settings, so from any one device you can see and change them all.
// The bell in the app keeps collecting whatever a device is set to.

import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Linking } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { NotificationLevel } from '@patch/wire';
import { SettingsSection } from '../SettingsSection';
import { SettingsPage } from './SettingsPage';
import { Chips, Row, SettingsButton, ToggleRow, WithSettings } from './ui';
import { writePreferences } from './PreferenceSections';
import { useUiStore } from '../../stores/uiStore';
import type { SettingsResponse } from '../../api/rest';

const LEVELS = ['all', 'urgent', 'off'] as const satisfies readonly NotificationLevel[];
const LEVEL_LABELS: Record<NotificationLevel, string> = {
  all: 'All',
  urgent: 'Only urgent',
  off: 'Off',
};
const LEVEL_HINTS: Record<NotificationLevel, string> = {
  all: 'Everything',
  urgent: 'Only what needs you: permission prompts, questions, failures, calls',
  off: 'Nothing on this device; the bell still collects it',
};
const KIND_LABELS: Record<string, string> = { web: 'Web', desktop: 'Desktop', mobile: 'Android' };

export function NotificationsPage(): React.ReactElement {
  const pushError = useUiStore((s) => s.pushError);
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

  return (
    <SettingsPage title="Notifications" testID="settings-page-notifications">
      <WithSettings testID="notifications">
        {(data) => <Devices data={data} granted={granted} />}
      </WithSettings>
    </SettingsPage>
  );
}

function Devices({
  data,
  granted,
}: {
  data: SettingsResponse;
  granted: boolean | null;
}): React.ReactElement {
  const devices = data.devices.filter((d) => d.surfaceKind in KIND_LABELS);
  const levels = data.preferences.deviceNotifications;
  const level = (id: string): NotificationLevel => levels[id] ?? 'all';
  const anyOn = devices.some((d) => level(d.surfaceId) !== 'off');
  const own = devices.find((d) => d.isCurrent);

  return (
    <>
      <SettingsSection testID="settings-notifications">
        <ToggleRow
          label="Notifications"
          subtitle={
            anyOn
              ? 'Every device below. Off here turns them all off.'
              : 'Off on every device. The bell in the app still collects them.'
          }
          testID="notifications-master"
          value={anyOn}
          onChange={(on) =>
            writePreferences({
              deviceNotifications: Object.fromEntries(
                devices.map((d) => [d.surfaceId, on ? 'all' : 'off'] as const),
              ),
            })
          }
        />
        {granted === false && own && level(own.surfaceId) !== 'off' ? (
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
      </SettingsSection>
      <SettingsSection title="Devices" testID="settings-notification-devices">
        {devices.map((d) => (
          <Row
            key={d.surfaceId}
            title={d.label}
            subtitle={d.isCurrent ? 'This device' : (KIND_LABELS[d.surfaceKind] ?? d.surfaceKind)}
            testID={`notifications-device-${d.surfaceId}`}
            stack
          >
            <Chips
              options={LEVELS}
              selected={level(d.surfaceId)}
              testIDPrefix={`notifications-level-${d.surfaceId}`}
              labelPrefix={`${d.label} notifications`}
              labelOf={(l) => LEVEL_LABELS[l]}
              hintOf={(l) => LEVEL_HINTS[l]}
              onSelect={(next) =>
                writePreferences({ deviceNotifications: { ...levels, [d.surfaceId]: next } })
              }
            />
          </Row>
        ))}
      </SettingsSection>
    </>
  );
}
