// The model list the account-wide model pickers (Agent → Model for new chats,
// Manager → Model) offer.
//
// The list is the same from any attached host, so it is resolved across the
// attached hosts (`catalogueHostId`) — the user never sees host routing. The
// saved value is always kept as an option, so an unrelated visit to the page
// can never unpin it.

import { useEffect } from 'react';
import { humaniseError } from '../../lib/errorCopy.js';
import { loadModels, useModelCatalog } from '../../lib/models.js';
import { anyProviderConnected, usePreferencesStore } from '../../stores/preferencesStore.js';
import { catalogueHostId, usePresenceStore } from '../../stores/presenceStore.js';

export type ModelListProblem =
  | { kind: 'no-provider' | 'no-host'; text: string }
  /** `detail` is what the host said, for a disclosure; never the sentence itself. */
  | { kind: 'error'; text: string; detail: string };

export function useModelOptions(value: string): {
  options: { id: string; label: string }[];
  /** Why the list may be incomplete, or null when it is the host's real list. */
  problem: ModelListProblem | null;
} {
  const hosts = usePresenceStore((s) => s.hosts);
  // With no AI connected there is no list to load, and the host's refusal
  // (`upstream`) is not news: the list arrives with the first sign-in.
  const noProvider = usePreferencesStore((s) => anyProviderConnected(s.shared)) === false;
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
    problem: noProvider
      ? { kind: 'no-provider', text: 'Models appear once you connect an AI.' }
      : catalogueHost === null
        ? { kind: 'no-host', text: 'The model list isn’t available yet.' }
        : catalogue.status === 'error'
          ? { kind: 'error', ...modelListFailure(catalogue.error) }
          : null,
  };
}

/** A failed load, said in words; the host's own code goes in `detail`. */
function modelListFailure(code: string | null | undefined): { text: string; detail: string } {
  const { sentence, detail } = humaniseError({ code: code ?? 'unknown error' }, 'models');
  return { text: sentence, detail };
}
