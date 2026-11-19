// Settings → Manager → Home: which host runs the Manager and Speakers threads
// (spec/06 § Where special threads run, § Changing home).
//
// The user chooses; nothing moves it by itself. Choosing another host opens
// the handover before anything changes: the server's draft of the recent
// conversation, which the user edits or clears, and only "Move" sends it.

import type { JSX } from 'react';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/rest.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { failed } from '../../lib/errorCopy.js';
import { hostLabel, sortHosts } from './hostScope.js';
import { Group, Row } from './ui.js';

export const MANAGER_HOME_QUERY = ['manager-home'] as const;

/** The server's own sentence for a refusal, else the thrown message. */
export function serverSays(e: unknown): string {
  if (e instanceof ApiError) {
    const m = (e.body as { message?: unknown } | null)?.message;
    if (typeof m === 'string' && m !== '') return m;
  }
  return (e as Error).message;
}

interface Pending {
  hostId: string;
  message: string;
}

export function ManagerHomeGroup(): JSX.Element {
  const queryClient = useQueryClient();
  const pushError = useUiStore((s) => s.pushError);
  const hosts = usePresenceStore((s) => s.hosts);
  const home = useQuery({ queryKey: MANAGER_HOME_QUERY, queryFn: () => api.managerHome() });
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const current = home.data?.hostId ?? null;
  const all = sortHosts(Object.values(hosts));
  const nameOf = (id: string): string => {
    const h = hosts[id];
    return h ? hostLabel(h) : id;
  };

  async function choose(hostId: string): Promise<void> {
    if (hostId === current) return;
    setBusy(true);
    try {
      const { message } = await api.managerHomeDraft(hostId);
      setPending({ hostId, message });
    } catch (e) {
      pushError(failed('preparing the move'), undefined, serverSays(e));
    } finally {
      setBusy(false);
    }
  }

  async function move(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    try {
      await api.setManagerHome(pending.hostId, pending.message);
      setPending(null);
      await queryClient.invalidateQueries({ queryKey: MANAGER_HOME_QUERY });
    } catch (e) {
      pushError(failed('moving the Manager'), undefined, serverSays(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Group label="Home" testid="settings-manager-home">
      <Row
        title="Home host"
        sub={
          home.isError ? (
            <span className="set-sub-error" data-testid="manager-home-error">
              {serverSays(home.error)}
            </span>
          ) : (
            'Runs the Manager and Speakers'
          )
        }
      >
        <select
          aria-label="Manager home host"
          data-testid="manager-home"
          value={pending?.hostId ?? current ?? ''}
          disabled={!home.isSuccess || busy || pending !== null || current === null}
          onChange={(e) => void choose(e.target.value)}
        >
          {current === null ? <option value="">No host</option> : null}
          {all.map((h) => (
            <option key={h.hostId} value={h.hostId}>
              {hostLabel(h)}
            </option>
          ))}
        </select>
      </Row>
      {pending && current !== null ? (
        <div className="set-row stack" data-testid="manager-home-handover">
          <div className="set-row-head">
            <div className="set-row-text">
              <span className="set-row-title">
                Move from {nameOf(current)} to {nameOf(pending.hostId)}
              </span>
              <span className="set-sub">
                A fresh session starts there. This message is sent to it first; edit or clear it.
              </span>
            </div>
          </div>
          <textarea
            aria-label="Handover message"
            data-testid="manager-home-message"
            value={pending.message}
            rows={10}
            placeholder="No message: the new session starts with no context"
            onChange={(e) => setPending({ ...pending, message: e.target.value })}
          />
          <div className="set-actions">
            <button
              type="button"
              className="set-btn ghost"
              data-testid="manager-home-cancel"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="set-btn"
              data-testid="manager-home-move"
              disabled={busy}
              onClick={() => void move()}
            >
              Move to {nameOf(pending.hostId)}
            </button>
          </div>
        </div>
      ) : null}
    </Group>
  );
}
