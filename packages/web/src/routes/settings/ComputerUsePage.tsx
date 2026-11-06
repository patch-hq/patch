// Settings → Computer use: whether an agent is driving a host's browser
// right now, and a Stop button that closes its windows and cancels the action.

import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ComputerUseHost } from '../../api/rest.js';
import { useUiStore } from '../../stores/uiStore.js';
import { failed } from '../../lib/errorCopy.js';
import { Group, Note, OnlineDot, Row, SettingsPage } from './ui.js';

/** Fast while something is moving, so the banner and Stop are never stale. */
const POLL_MS = 2_000;

function windows(n: number): string {
  return n === 1 ? '1 browser window' : `${n} browser windows`;
}

function HostCard({
  host,
  stopping,
  onStop,
}: {
  host: ComputerUseHost;
  stopping: boolean;
  onStop: () => void;
}): JSX.Element {
  const name = host.name ?? host.hostId;
  const tabs = host.tabs ?? 0;
  if (host.error !== undefined) {
    return (
      <Row
        testid={`computer-use-${host.hostId}`}
        title={name}
        sub={`Couldn’t check: ${host.error}`}
      />
    );
  }
  if (host.active) {
    return (
      <div className="set-computer-live" role="status" data-testid={`computer-use-${host.hostId}`}>
        <div className="set-computer-live-title" data-testid="computer-use-active">
          Patch is using {host.name ? `${name}` : 'this computer'} right now
        </div>
        <p className="set-computer-live-copy">
          Hands off for a moment. {host.actionLabel ?? 'Working'} — moving the mouse or typing while
          it works can knock it off course. It usually takes a few seconds.
        </p>
        <button
          type="button"
          className="set-btn primary"
          data-testid="computer-use-stop"
          disabled={stopping}
          onClick={onStop}
        >
          {stopping ? 'Stopping…' : 'Stop now'}
        </button>
      </div>
    );
  }
  return (
    <Row
      testid={`computer-use-${host.hostId}`}
      title={
        <>
          <OnlineDot online /> {name}
        </>
      }
      sub={
        tabs > 0
          ? `Not moving anything right now. ${windows(tabs)} left open.`
          : 'Patch isn’t using this computer.'
      }
    >
      {tabs > 0 ? (
        <button
          type="button"
          className="set-btn danger"
          data-testid="computer-use-stop"
          disabled={stopping}
          onClick={onStop}
        >
          {stopping ? 'Closing…' : 'Close windows'}
        </button>
      ) : null}
    </Row>
  );
}

export function ComputerUsePage(): JSX.Element {
  const qc = useQueryClient();
  const pushError = useUiStore((s) => s.pushError);
  const pushNotice = useUiStore((s) => s.pushNotice);
  const { data, error } = useQuery({
    queryKey: ['computer-use'],
    queryFn: () => api.computerUse(),
    refetchInterval: POLL_MS,
  });
  const stop = useMutation({
    mutationFn: (hostId: string) => api.stopComputerUse(hostId),
    onSuccess: (r) => {
      pushNotice(
        r.closed
          ? `Stopped. Patch closed ${windows(r.closed)}.`
          : 'Stopped. Nothing was left open.',
      );
      qc.invalidateQueries({ queryKey: ['computer-use'] });
    },
    onError: (e) => pushError(failed('stop'), undefined, (e as Error).message),
  });

  return (
    <SettingsPage title="Computer use" testid="settings-computer-use">
      {error ? (
        <Note testid="computer-use-error">Couldn’t check: {(error as Error).message}</Note>
      ) : data === undefined ? (
        <Note>Checking…</Note>
      ) : data.hosts.length === 0 ? (
        <Note>No hosts are online.</Note>
      ) : (
        <Group label="Hosts">
          {data.hosts.map((h) => (
            <HostCard
              key={h.hostId}
              host={h}
              stopping={stop.isPending && stop.variables === h.hostId}
              onStop={() => stop.mutate(h.hostId)}
            />
          ))}
        </Group>
      )}
    </SettingsPage>
  );
}
