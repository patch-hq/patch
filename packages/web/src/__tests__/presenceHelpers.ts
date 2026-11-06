// Test helpers for the per-host presence store.
//
// Credentials are per host per backend (spec/10 § Surface in Settings), so a
// test that wants "Claude is connected" has to say WHICH host — there is no
// account-wide slot to set. These wrap the `host.account` report the host
// really sends.

import {
  CLAUDE_BACKEND_ID,
  type ClaudeMemoryEntry,
  type HostAccountEvent,
  type HostAccountSummary,
  type HostInfoEvent,
} from '@patch/wire';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';

/** Report one host's Claude credential, exactly as `host.account` does. */
export function reportAccount(
  hostId: string,
  connected: boolean,
  accountEmail: string | null = null,
  usage?: HostAccountEvent['usage'],
): void {
  usePresenceStore.getState().setHostAccount({
    type: 'host.account',
    hostId,
    backendId: CLAUDE_BACKEND_ID,
    connected,
    accountEmail,
    ...(usage === undefined ? {} : { usage }),
  });
}

/**
 * Report one host's Claude credential state carrying the multi-account list
 * (spec/10 § Backend credentials — multiple accounts). The top-level
 * `connected`/`accountEmail`/`usage` mirror whichever entry is
 * `activeAccountId` (or the first entry, if `activeAccountId` is omitted),
 * exactly as the real host does — so a test can assert on either the
 * legacy single-row fields or the new per-account rows off the same report.
 */
export function reportAccounts(
  hostId: string,
  accounts: HostAccountSummary[],
  activeAccountId?: string,
): void {
  const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0] ?? undefined;
  usePresenceStore.getState().setHostAccount({
    type: 'host.account',
    hostId,
    backendId: CLAUDE_BACKEND_ID,
    connected: active?.connected ?? false,
    accountEmail: active?.accountEmail ?? null,
    ...(active?.usage === undefined ? {} : { usage: active.usage }),
    accounts,
    ...(activeAccountId === undefined ? {} : { activeAccountId }),
  });
}

/**
 * Report one host's self-description (`host.host`), which is where the host's
 * last-used model comes from (spec/02 § Agent backends, spec/03 § `host.host`).
 */
export function reportHost(
  hostId: string,
  patch: Partial<Omit<HostInfoEvent, 'type' | 'hostId'>> = {},
): void {
  const {
    questionExpiry,
    questionExpirySeconds,
    hostName,
    permissionModeDefault,
    permissionOverrides,
    runsManager,
    audioRelayHost,
    ...rest
  } = patch;
  usePresenceStore.getState().setHostReport({
    type: 'host.host',
    hostId,
    hostName: hostName ?? hostId,
    platform: 'darwin',
    arch: 'arm64',
    hostVersion: '0.0.0-test',
    updateAvailable: false,
    permissionModeDefault: permissionModeDefault ?? 'bypassPermissions',
    permissionOverrides: permissionOverrides ?? 0,
    runsManager: runsManager ?? true,
    audioRelayHost: audioRelayHost ?? '127.0.0.1:3003',
    backends: [],
    components: [],
    // Anything else the test names (harnessMcpServers, kokoroVoice, backends,
    // updateAvailable, …) is reported exactly as given.
    ...rest,
    // Stated together or not at all — Settings reads the pair's absence as
    // "this host predates the setting" and offers no control for it.
    ...(questionExpiry === undefined || questionExpirySeconds === undefined
      ? {}
      : { questionExpiry, questionExpirySeconds }),
  });
}

/** Report one host's Claude Code settings + memory snapshot (`claude_settings.list`). */
export function reportClaudeSettings(
  hostId: string,
  memories: ClaudeMemoryEntry[] = [],
  settingsJson = '',
): void {
  usePresenceStore.getState().setClaudeSettings(hostId, settingsJson, memories);
}

/** Report one host's folder registry (`folders.list` / `folders.updated`). */
export function reportFolders(hostId: string, roots: string[], recent: string[] = []): void {
  usePresenceStore.getState().setHostFolders(hostId, roots, recent);
}

/** Back to "no host has reported anything" — the pre-greeting state. */
export function clearHosts(): void {
  usePresenceStore.setState({ hosts: {}, hostOnline: false });
}

/**
 * Report a credential validation failure from the host, exactly as
 * `host.account` does with `credentialError` set. One-shot: the server
 * does not cache it, so a surface that connects after the fact never sees it.
 */
export function reportCredentialError(
  hostId: string,
  credentialError: NonNullable<HostAccountEvent['credentialError']>,
  /** The accounts that are still in the store (unchanged after a rejection). */
  accounts: HostAccountSummary[] = [],
  activeAccountId?: string,
): void {
  const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0] ?? undefined;
  usePresenceStore.getState().setHostAccount({
    type: 'host.account',
    hostId,
    backendId: CLAUDE_BACKEND_ID,
    connected: active?.connected ?? false,
    accountEmail: active?.accountEmail ?? null,
    ...(accounts.length > 0 ? { accounts } : {}),
    ...(activeAccountId === undefined ? {} : { activeAccountId }),
    credentialError,
  });
}

/** Seed the server's shared provider accounts, as the settings state delivers them. */
export function setSharedAccounts(accounts: {
  claude?: { connected: boolean }[];
  codex?: { connected: boolean; kind?: 'chatgpt' | 'apiKey' }[];
}): void {
  usePreferencesStore.setState({
    shared: {
      version: 1,
      secrets: {
        claude: (accounts.claude ?? []).map((a, i) => ({
          id: `c${i}`,
          label: `Claude ${i}`,
          ...a,
        })),
        codex: (accounts.codex ?? []).map((a, i) => ({
          id: `o${i}`,
          label: `OpenAI ${i}`,
          kind: 'chatgpt' as const,
          ...a,
        })),
        providerKeys: [],
      },
    } as never,
  });
}

export function clearSharedAccounts(): void {
  usePreferencesStore.setState({ shared: null });
}
