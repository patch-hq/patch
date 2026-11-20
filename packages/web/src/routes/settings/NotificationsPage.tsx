// Settings → Notifications: when notifications leave the computer for the phone
// (spec/09 § Presence heuristic). `Send to my phone after` is account-wide
// (spec/01 § Settings); the browser's idle-detection grant is this browser's own.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { NotificationLevel, SendToPhoneAfter } from '@patch/wire';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import {
  idleDetectionState,
  requestIdleDetection,
  type IdleDetectionState,
} from '../../lib/inputPresence.js';
import {
  browserNotificationState,
  requestBrowserNotifications,
  type BrowserNotificationState,
} from '../../lib/browserNotifications.js';
import { Toggle } from '../../components/Toggle.js';
import { levelOf, NOTIFIABLE_KINDS } from '../../lib/notificationsMaster.js';
import { useDevices } from './DevicesPage.js';
import { getDesktopBridge } from '../../lib/desktopBridge.js';
import { patchShared } from './sharedWrite.js';
import { Group, Note, Pills, Row, SettingsPage } from './ui.js';

const OPTIONS = ['1m', '5m', 'lock'] as const satisfies readonly SendToPhoneAfter[];
const LEVELS = ['all', 'urgent', 'off'] as const satisfies readonly NotificationLevel[];
const LEVEL_LABELS: Record<NotificationLevel, string> = {
  all: 'All',
  urgent: 'Only urgent',
  off: 'Off',
};
const LEVEL_TITLES: Record<NotificationLevel, string> = {
  all: 'Everything',
  urgent: 'Only what needs you: permission prompts, questions, failures, calls',
  off: 'Nothing on this device; the bell still collects it',
};
const KIND_LABELS: Record<string, string> = { web: 'Web', desktop: 'Desktop', mobile: 'Android' };
const LABELS: Record<SendToPhoneAfter, string> = {
  '1m': '1 minute',
  '5m': '5 minutes',
  lock: 'Only when I lock',
};

export function NotificationsPage(): JSX.Element {
  const value = usePreferencesStore((s) => s.preferences.sendToPhoneAfter);
  const loaded = usePreferencesStore((s) => s.loaded);
  const pushError = useUiStore((s) => s.pushError);
  const [idle, setIdle] = useState<IdleDetectionState | null>(null);
  const [browserNotify, setBrowserNotify] = useState<BrowserNotificationState>(
    browserNotificationState(),
  );
  // The desktop app raises its own native toasts; this grant is a browser's.
  const inDesktopApp = getDesktopBridge() !== undefined;

  const { devices } = useDevices();
  const levels = usePreferencesStore((s) => s.preferences.deviceNotifications);
  const notifiable = (devices ?? []).filter((d) => NOTIFIABLE_KINDS.has(d.surfaceKind));
  // The delay is about the phone, so it is only offered once one is paired.
  const hasPhone = notifiable.some((d) => d.surfaceKind === 'mobile');
  const anyOn = notifiable.some((d) => levelOf(levels, d.surfaceId) !== 'off');

  /** Write the whole map; this device's own switch follows it (useNotificationLevelSync). */
  async function setLevels(next: Record<string, NotificationLevel>): Promise<void> {
    await patchShared('notifications', { deviceNotifications: next });
  }

  function setDevice(surfaceId: string, level: NotificationLevel): void {
    void setLevels({ ...levels, [surfaceId]: level });
  }

  function setAll(on: boolean): void {
    void setLevels(
      Object.fromEntries(notifiable.map((d) => [d.surfaceId, on ? 'all' : 'off'] as const)),
    );
  }

  useEffect(() => {
    idleDetectionState().then(setIdle, (err: unknown) =>
      pushError(`idle detection: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, [pushError]);

  async function grant(): Promise<void> {
    try {
      setIdle(await requestIdleDetection());
    } catch (err) {
      pushError(`idle detection: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function allowBrowserNotifications(): Promise<void> {
    try {
      setBrowserNotify(await requestBrowserNotifications());
    } catch (err) {
      pushError(`browser notifications: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <SettingsPage title="Notifications" testid="settings-notifications">
      <Group testid="notifications-master-group">
        <Row
          title="Notifications"
          sub={
            anyOn || devices === null
              ? 'Every device below. Off here turns them all off.'
              : 'Off on every device. The bell in the app still collects them.'
          }
          testid="notifications-master"
        >
          <Toggle
            checked={anyOn}
            disabled={!loaded || devices === null}
            onChange={setAll}
            testid="notifications-master-toggle"
          />
        </Row>
        {!inDesktopApp && browserNotify === 'denied' ? (
          <Note testid="notifications-os-blocked">
            Blocked in this browser. Allow notifications for this site in the browser's site
            settings (the icon left of the address bar), then reload.
          </Note>
        ) : null}
      </Group>
      <Group testid="notifications-devices">
        {notifiable.map((d) => (
          <Row
            key={d.surfaceId}
            title={d.label}
            sub={d.isCurrent ? 'This device' : (KIND_LABELS[d.surfaceKind] ?? d.surfaceKind)}
            testid={`notifications-device-${d.surfaceId}`}
          >
            <Pills
              label={`${d.label} notifications`}
              options={LEVELS}
              labels={LEVEL_LABELS}
              titles={LEVEL_TITLES}
              value={levelOf(levels, d.surfaceId)}
              disabled={!loaded}
              testid={`notifications-level-${d.surfaceId}`}
              onChange={(next) => setDevice(d.surfaceId, next)}
            />
          </Row>
        ))}
      </Group>
      <Group>
        {inDesktopApp || browserNotify === 'unsupported' ? null : (
          <Row title="Browser notifications" testid="browser-notifications">
            {browserNotify === 'granted' ? (
              <span className="set-sub" data-testid="browser-notifications-granted">
                Allowed
              </span>
            ) : (
              <button
                type="button"
                className="set-btn"
                data-testid="browser-notifications-grant"
                disabled={browserNotify === 'denied'}
                onClick={() => void allowBrowserNotifications()}
              >
                {browserNotify === 'denied' ? 'Blocked in browser' : 'Allow'}
              </button>
            )}
          </Row>
        )}
        {hasPhone ? (
          <Row title="Send to my phone after" testid="send-to-phone-after">
            <Pills
              label="Send to my phone after"
              options={OPTIONS}
              labels={LABELS}
              value={value}
              disabled={!loaded}
              testid="send-to-phone-after-pills"
              onChange={(next) => void patchShared('send to phone', { sendToPhoneAfter: next })}
            />
          </Row>
        ) : null}
        {idle === null || idle === 'unsupported' ? null : (
          <Row title="Idle detection" testid="idle-detection">
            {idle === 'granted' ? (
              <span className="set-sub" data-testid="idle-detection-granted">
                Granted
              </span>
            ) : (
              <button
                type="button"
                className="set-btn"
                data-testid="idle-detection-grant"
                disabled={idle === 'denied'}
                onClick={() => void grant()}
              >
                {idle === 'denied' ? 'Blocked in browser' : 'Allow'}
              </button>
            )}
          </Row>
        )}
      </Group>
    </SettingsPage>
  );
}
