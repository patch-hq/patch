// Which host the per-host Settings pages are about.
//
// Most settings live on a machine, not on the account, so Usage, Agent, MCP,
// Memories, Voice and Providers each show ONE host at a time, chosen in the page
// header. The choice is shared across pages — switching to the Mac on Usage and
// then opening Agent should still be looking at the Mac.
//
// The default is `defaultHostId`, the same rule every other
// host-scoped action in the app uses; failing that, the first host by name.

import { create } from 'zustand';
import { defaultHostId, usePresenceStore, type HostPresence } from '../../stores/presenceStore.js';

interface SettingsHostState {
  selected: string | null;
  select(hostId: string | null): void;
}

export const useSettingsHostStore = create<SettingsHostState>((set) => ({
  selected: null,
  select: (hostId) => set({ selected: hostId }),
}));

/** A host's name, or its id until it has reported one — never an invented name. */
export function hostLabel(h: HostPresence): string {
  return h.host?.hostName ?? h.registeredName ?? h.hostId;
}

/** Hosts by name, id as the tiebreak so the order is stable. */
export function sortHosts(hosts: HostPresence[]): HostPresence[] {
  return [...hosts].sort(
    (a, b) => hostLabel(a).localeCompare(hostLabel(b)) || a.hostId.localeCompare(b.hostId),
  );
}

export function useSettingsHost(): {
  host: HostPresence | null;
  hostId: string | null;
  /** Hosts the switcher offers: every one that has reported. */
  options: HostPresence[];
  select(hostId: string): void;
} {
  const hosts = usePresenceStore((s) => s.hosts);
  const selected = useSettingsHostStore((s) => s.selected);
  const select = useSettingsHostStore((s) => s.select);
  const all = sortHosts(Object.values(hosts));
  const options = all.filter((h) => h.host !== null);
  const hostId =
    selected !== null && hosts[selected] !== undefined
      ? selected
      : (defaultHostId(hosts) ?? options[0]?.hostId ?? all[0]?.hostId ?? null);
  return {
    host: hostId === null ? null : (hosts[hostId] ?? null),
    hostId,
    options,
    select,
  };
}
