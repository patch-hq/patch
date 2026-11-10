// The model list the account-wide model pickers (Agent → Model for new chats,
// Manager → Model) offer.
//
// The list is the same from any attached host, so it is resolved across the
// attached hosts (`catalogueHostId`) — the user never sees host routing. The
// saved value is always kept as an option, so an unrelated visit to the page
// can never unpin it.

import { useEffect } from 'react';
import { loadModels, useModelCatalog } from '../../lib/models.js';
import { catalogueHostId, usePresenceStore } from '../../stores/presenceStore.js';

export function useModelOptions(value: string): {
  options: { id: string; label: string }[];
  /** Why the list may be incomplete, or null when it is the host's real list. */
  problem: { kind: 'no-host' | 'error'; text: string } | null;
} {
  const hosts = usePresenceStore((s) => s.hosts);
  const catalogueHost = catalogueHostId(hosts);
  const catalogue = useModelCatalog();

  useEffect(() => {
    if (catalogueHost === null) return;
    void loadModels(catalogueHost);
  }, [catalogueHost]);

  const ids = catalogue.models.map((m) => m.id);
  const extra = value && !ids.includes(value) ? [{ id: value, label: value }] : [];
  return {
    options: [...extra, ...catalogue.models],
    problem:
      catalogueHost === null
        ? { kind: 'no-host', text: 'The model list isn’t available yet.' }
        : catalogue.status === 'error'
          ? {
              kind: 'error',
              text: `Couldn’t load the model list: ${catalogue.error ?? 'unknown error'}`,
            }
          : null,
  };
}
