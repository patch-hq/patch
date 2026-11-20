// Settings → Hosts → Replace with… (spec/11 § Replacing a host).
//
// A new machine takes over every chat of this host. Choosing the new host asks
// it which of this host's folders it has; the panel lists each folder and where
// each provider keeps its session files, to carry across unchanged. Replacing
// moves every chat, hands over held messages and removes this host. A missing
// folder is named, and the user goes ahead without it only by saying so.

import type { JSX } from 'react';
import { useState } from 'react';
import { api, type ReplaceHostPlan } from '../../api/rest.js';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { failed } from '../../lib/errorCopy.js';
import { hostLabel, sortHosts } from './hostScope.js';
import { serverSays } from './ManagerHomeGroup.js';
import { Group, Row } from './ui.js';

export function ReplaceHostGroup({ host }: { host: HostPresence }): JSX.Element {
  const pushError = useUiStore((s) => s.pushError);
  const hosts = usePresenceStore((s) => s.hosts);
  const [plan, setPlan] = useState<ReplaceHostPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const others = sortHosts(Object.values(hosts)).filter((h) => h.hostId !== host.hostId);

  async function choose(withHostId: string): Promise<void> {
    if (withHostId === '') return;
    setBusy(true);
    try {
      setPlan(await api.replaceHostPlan(host.hostId, withHostId));
    } catch (e) {
      pushError(failed('checking the new host'), undefined, serverSays(e));
    } finally {
      setBusy(false);
    }
  }

  async function replace(): Promise<void> {
    if (!plan) return;
    if (plan.missing.length > 0) {
      const ok = await useUiStore.getState().confirm({
        title: `Replace without ${plan.missing.length === 1 ? 'a folder' : `${plan.missing.length} folders`}`,
        message: `${plan.to.name} does not have ${plan.missing.join(', ')}. Chats in ${plan.missing.length === 1 ? 'it' : 'them'} move but cannot run until the folder is there.`,
        confirmLabel: 'Replace',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.replaceHost(host.hostId, plan.to.hostId, plan.missing);
      usePresenceStore.getState().removeHost(host.hostId);
      setPlan(null);
    } catch (e) {
      pushError(failed('replacing the host'), undefined, serverSays(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Group testid={`host-${host.hostId}-replace-group`}>
      <Row title="Replace with">
        <select
          aria-label="Replace with"
          data-testid={`host-${host.hostId}-replace`}
          value={plan?.to.hostId ?? ''}
          disabled={busy || plan !== null || others.length === 0}
          onChange={(e) => void choose(e.target.value)}
        >
          <option value="">{others.length === 0 ? 'No other host' : 'Choose a host'}</option>
          {others.map((h) => (
            <option key={h.hostId} value={h.hostId}>
              {hostLabel(h)}
            </option>
          ))}
        </select>
      </Row>
      {plan ? (
        <div className="set-row stack" data-testid={`host-${host.hostId}-replace-plan`}>
          <div className="set-row-head">
            <div className="set-row-text">
              <span className="set-row-title">
                {plan.to.name} takes over {plan.chats} {plan.chats === 1 ? 'chat' : 'chats'}
              </span>
              <span className="set-sub">Carry each folder and session store to the same path.</span>
            </div>
          </div>
          <ul className="set-list" data-testid="replace-folders">
            {plan.folders.map((f) => (
              <li
                key={f.folder}
                data-testid={f.present ? 'replace-folder' : 'replace-folder-missing'}
              >
                <code>{f.folder}</code>{' '}
                <span className={f.present ? 'set-sub' : 'set-sub-error'}>
                  {f.present ? 'present' : 'missing'}
                </span>
              </li>
            ))}
          </ul>
          {plan.sessions.length > 0 ? (
            <ul className="set-list" data-testid="replace-sessions">
              {plan.sessions.map((s) => (
                <li key={`${s.provider}:${s.path}`}>
                  {s.provider} <code>{s.path}</code>
                </li>
              ))}
              <li className="set-sub" data-testid="replace-assumed-home">
                Assumes {plan.from.name} keeps Patch in <code>{plan.assumedHome}</code>
              </li>
            </ul>
          ) : null}
          {plan.jobs.length > 0 ? (
            <ul className="set-list" data-testid="replace-jobs">
              <li className="set-sub">Jobs that move</li>
              {plan.jobs.map((j) => (
                <li key={j.jobId}>{j.name}</li>
              ))}
            </ul>
          ) : null}
          <div className="set-actions">
            <button
              type="button"
              className="set-btn ghost"
              data-testid="replace-cancel"
              disabled={busy}
              onClick={() => setPlan(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="set-btn ghost"
              data-testid="replace-recheck"
              disabled={busy}
              onClick={() => void choose(plan.to.hostId)}
            >
              Check again
            </button>
            <button
              type="button"
              className="set-btn danger"
              data-testid="replace-confirm"
              disabled={busy}
              onClick={() => void replace()}
            >
              Replace
            </button>
          </div>
        </div>
      ) : null}
    </Group>
  );
}
