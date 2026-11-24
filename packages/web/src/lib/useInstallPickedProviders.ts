// A provider's CLI is installed on a host only once the user has picked that
// provider (connected an account). Claude Code is ~200 MB, Codex is a package
// install: neither goes onto a computer for a provider nobody chose.
//
// Hosts only report what they have. This asks every online host that lacks the
// CLI of a connected provider to install it, once per host and provider per
// session. A failed install is not retried on its own: it stays `failed` with
// the installer's output until the user presses Retry (`requestInstall`).

import { useEffect, useRef } from 'react';
import { ACCOUNT_PROVIDERS, backendHasConnectedAccount } from '@patch/wire';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { usePresenceStore, type HostPresence } from '../stores/presenceStore.js';
import { sendToHost } from '../routes/settings/hostWrite.js';

export function requestInstall(host: HostPresence, backendId: string, reinstall = false): boolean {
  return sendToHost(host, {
    type: 'host.backend_install',
    hostId: host.hostId,
    backendId,
    ...(reinstall ? { reinstall: true } : {}),
  });
}

export function useInstallPickedProviders(): void {
  const secrets = usePreferencesStore((s) => s.shared?.secrets);
  const hosts = usePresenceStore((s) => s.hosts);
  const asked = useRef(new Set<string>());
  // A provider is picked once any of its accounts is connected; each provider
  // with accounts is asked the same way, from the table.
  const picked: Record<string, boolean> = Object.fromEntries(
    ACCOUNT_PROVIDERS.map((p) => [p.backendId, backendHasConnectedAccount(secrets, p.backendId)]),
  );
  const key = JSON.stringify([picked, hosts]);
  useEffect(() => {
    for (const host of Object.values(hosts)) {
      if (!host.online || !host.host) continue;
      for (const { backendId } of ACCOUNT_PROVIDERS) {
        if (!picked[backendId]) continue;
        const entry = host.host.backends.find((b) => b.id === backendId);
        if (entry?.state !== 'absent') continue;
        const id = `${host.hostId}:${backendId}`;
        if (asked.current.has(id)) continue;
        asked.current.add(id);
        requestInstall(host, backendId);
      }
    }
  }, [key]);
}
