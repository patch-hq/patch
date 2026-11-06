// Settings → Computer use: whether an agent is driving a host's browser
// right now, and a Stop that closes its windows and cancels the action. Same
// REST calls as web's Computer use page.

import React from 'react';
import { Text, View } from 'react-native';
import { api, type ComputerUseHost } from '../../api/rest';
import { useUiStore } from '../../stores/uiStore';
import { space, typography, useTheme } from '../../lib/theme';
import { SettingsSection } from '../SettingsSection';
import { SettingsPage } from './SettingsPage';
import { ErrorLine, Muted, Row, SettingsButton } from './ui';

/** Fast while something is moving, so the banner and Stop are never stale. */
const POLL_MS = 2_000;

function windows(n: number): string {
  return n === 1 ? '1 browser window' : `${n} browser windows`;
}

export function ComputerUsePage(): React.ReactElement {
  return (
    <SettingsPage title="Computer use" testID="settings-page-computer">
      <ComputerUseList />
    </SettingsPage>
  );
}

function ComputerUseList(): React.ReactElement {
  const [hosts, setHosts] = React.useState<ComputerUseHost[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [stopping, setStopping] = React.useState<string | null>(null);

  const load = React.useCallback(async (): Promise<void> => {
    try {
      setHosts((await api.computerUse()).hosts);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const stop = async (hostId: string): Promise<void> => {
    setStopping(hostId);
    try {
      await api.stopComputerUse(hostId);
      await load();
    } catch (e) {
      useUiStore.getState().pushError(`Stop failed. Try again. ${(e as Error).message}`);
    } finally {
      setStopping(null);
    }
  };

  if (loadError !== null) {
    return (
      <ErrorLine
        testID="computer-use-error"
        message={`Couldn’t check: ${loadError}`}
        onRetry={() => void load()}
      />
    );
  }
  if (hosts === null) return <Muted>Checking…</Muted>;
  if (hosts.length === 0) return <Muted>No hosts are online.</Muted>;
  return (
    <SettingsSection title="Hosts">
      {hosts.map((h) => (
        <HostRow
          key={h.hostId}
          host={h}
          stopping={stopping === h.hostId}
          onStop={() => void stop(h.hostId)}
        />
      ))}
    </SettingsSection>
  );
}

function HostRow({
  host,
  stopping,
  onStop,
}: {
  host: ComputerUseHost;
  stopping: boolean;
  onStop: () => void;
}): React.ReactElement {
  const colors = useTheme();
  const name = host.name ?? host.hostId;
  const tabs = host.tabs ?? 0;
  if (host.error !== undefined) {
    return (
      <Row
        testID={`computer-use-${host.hostId}`}
        title={name}
        subtitle={`Couldn’t check: ${host.error}`}
      />
    );
  }
  if (host.active) {
    return (
      <View
        testID={`computer-use-${host.hostId}`}
        accessibilityRole="alert"
        style={{
          padding: space.md,
          gap: space.xs,
          borderLeftWidth: 4,
          borderLeftColor: colors.leaf,
        }}
      >
        <Text testID="computer-use-active" style={{ ...typography.label, color: colors.ink }}>
          Patch is using {name} right now
        </Text>
        <Muted>
          Hands off for a moment. {host.actionLabel ?? 'Working'} — moving the mouse or typing while
          it works can knock it off course. It usually takes a few seconds.
        </Muted>
        <SettingsButton
          testID="computer-use-stop"
          label={stopping ? 'Stopping…' : 'Stop now'}
          disabled={stopping}
          onPress={onStop}
        />
      </View>
    );
  }
  return (
    <Row
      testID={`computer-use-${host.hostId}`}
      title={name}
      subtitle={
        tabs > 0
          ? `Not moving anything right now. ${windows(tabs)} left open.`
          : 'Patch isn’t using this computer.'
      }
      right={
        tabs > 0 ? (
          <SettingsButton
            testID="computer-use-stop"
            variant="danger"
            label={stopping ? 'Closing…' : 'Close windows'}
            disabled={stopping}
            onPress={onStop}
          />
        ) : undefined
      }
    />
  );
}
