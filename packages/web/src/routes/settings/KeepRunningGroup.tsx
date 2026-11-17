// Settings → Hosts → Keep running (spec/05 § Keep running): the same two
// choices as the welcome step and the tray menu, on a desktop app that runs
// Patch on this computer itself. Absent anywhere else.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Toggle } from '../../components/Toggle.js';
import { getDesktopBridge, type KeepRunningState } from '../../lib/desktopBridge.js';
import { Group, Row } from './ui.js';

export function KeepRunningGroup(): JSX.Element | null {
  const bridge = getDesktopBridge()?.keepRunning;
  const [state, setState] = useState<KeepRunningState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void bridge
      ?.get()
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, [bridge]);
  if (!bridge) return null;
  const set = (patch: Partial<Pick<KeepRunningState, 'openAtLogin' | 'keepAwake'>>): void => {
    setError(null);
    void bridge
      .set(patch)
      .then(setState)
      .catch((e: Error) => setError(e.message));
  };
  return (
    <Group label="Keep running" testid="keep-running">
      {state?.canOpenAtLogin === false ? null : (
        <Row title="Open at login">
          <Toggle
            testid="keep-running-login"
            label="Open at login"
            checked={state?.openAtLogin ?? false}
            disabled={state === null}
            onChange={(v) => set({ openAtLogin: v })}
          />
        </Row>
      )}
      <Row
        title="Keep this computer awake while plugged in"
        sub="So your phone can reach it. The display still sleeps."
      >
        <Toggle
          testid="keep-running-awake"
          label="Keep this computer awake while plugged in"
          checked={state?.keepAwake ?? false}
          disabled={state === null}
          onChange={(v) => set({ keepAwake: v })}
        />
      </Row>
      {error ? (
        <p className="set-error" role="alert">
          {error}
        </p>
      ) : null}
    </Group>
  );
}
