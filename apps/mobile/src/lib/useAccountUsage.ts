// The connected subscription accounts with the freshest 5-hour and weekly
// usage reading across hosts (spec/15 § Composer → Account menu). The same
// freshest-reading rule as Settings → Usage. Mounted only while the account
// menu is open, so merely having a composer never asks a host for usage.

import React from 'react';
import { PROVIDERS, rateLimitWindowState, type RateLimitWindow } from '@patch/wire';
import { getWs } from '../api/ws';
import { usePresenceStore } from '../stores/presenceStore';
import { useUiStore } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';

type Usage = { session?: RateLimitWindow; week?: RateLimitWindow; at?: number } | undefined;

export interface AccountUsageRow {
  /** The shared account's id — what `preferredAccountId` carries. */
  id: string;
  label: string;
  /** The backend ("claude", "codex") the account belongs to. */
  backendId: string;
  usage: Usage;
}

export function useAccountUsage(): AccountUsageRow[] {
  const secrets = useSettingsStore((s) => s.data?.shared?.secrets);
  const hosts = usePresenceStore((s) => s.hosts);
  const asked = React.useRef(new Set<string>());
  const rows: AccountUsageRow[] = [];
  for (const { backendId, accountsKey } of PROVIDERS) {
    const accounts = secrets ? secrets[accountsKey] : [];
    for (const a of accounts) {
      if (!a.connected || ('kind' in a && a.kind === 'apiKey')) continue;
      let usage: Usage;
      let readAt = -1;
      for (const h of Object.values(hosts)) {
        const u = h.accounts[backendId]?.accounts?.find((x) => x.id === a.id)?.usage;
        if (u && (u.at ?? 0) > readAt) {
          usage = u;
          readAt = u.at ?? 0;
        }
      }
      rows.push({ id: a.id, label: a.label, backendId, usage });
    }
  }
  // An account no host has a reading for yet makes every online host read its
  // backend now, once per (host, backend), rather than waiting for the poll.
  const unread = rows.filter((r) => r.usage === undefined).map((r) => r.backendId);
  const wanted = [...new Set(unread)].flatMap((backendId) =>
    Object.values(hosts)
      .filter((h) => h.online)
      .map((h) => ({ hostId: h.hostId, backendId })),
  );
  const wantedKey = wanted.map((w) => `${w.hostId}/${w.backendId}`).join(',');
  React.useEffect(() => {
    for (const w of wanted) {
      const key = `${w.hostId}/${w.backendId}`;
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      try {
        getWs().send({
          type: 'host.backend_usage_refresh',
          hostId: w.hostId,
          backendId: w.backendId,
        });
      } catch (e) {
        useUiStore.getState().pushError(`usage refresh failed: ${(e as Error).message}`);
      }
    }
  }, [wantedKey]);
  return rows;
}

/** `5h 79% · wk 40%` — a window with no figure reads `–`, never a guess. */
export function usageSummary(usage: Usage): string {
  if (usage === undefined) return 'usage not read yet';
  const part = (scope: 'session' | 'week', name: string): string => {
    const win = usage[scope];
    if (win === undefined || win.utilization === undefined) return `${name} –`;
    const pct = Math.round(win.utilization * 100);
    return `${name} ${pct}%${rateLimitWindowState(scope, win) === 'blocked' ? ' blocked' : ''}`;
  };
  return `${part('session', '5h')} · ${part('week', 'wk')}`;
}
