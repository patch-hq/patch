// Settings → Notifications: when notifications leave the computer for the phone
// (spec/09 § Presence heuristic). `Send to my phone after` is account-wide
// (spec/01 § Settings); the browser's idle-detection grant is this browser's own.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { SendToPhoneAfter } from '@patch/wire';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import {
  idleDetectionState,
  requestIdleDetection,
  type IdleDetectionState,
} from '../../lib/inputPresence.js';
import { patchShared } from './sharedWrite.js';
import { Group, Pills, Row, SettingsPage } from './ui.js';

const OPTIONS = ['1m', '5m', 'lock'] as const satisfies readonly SendToPhoneAfter[];
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

  return (
    <SettingsPage title="Notifications" testid="settings-notifications">
      <Group>
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
