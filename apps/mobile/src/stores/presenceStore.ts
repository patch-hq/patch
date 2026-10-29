// Presence + connection state. Two INDEPENDENT things are tracked and must
// never collapse into one indicator (spec/12 § Surface connection state model):
//   - the WS link to the server (`connection`)
//   - the host presence (`daemon`)
// The server can be reachable while the host is down.

import { create } from 'zustand';
import type {
  AuthOkHost,
  ClaudeMemoryEntry,
  HostAccountEvent,
  HostConditionEvent,
  HostInfoEvent,
} from '@patch/wire';

// WS link states. On first launch we are `connecting` — a neutral, quiet
// state that must NEVER render an offline/reconnecting treatment before a
// connection has ever been established (spec/12 § No offline flash on load).
/**
 * `unauthenticated` is TERMINAL and is not a connection problem: the server
 * refused this surface's credential (hub close 4401 / `auth.revoked`). The
 * others describe a link that could still come back on its own; this one
 * cannot, and no amount of retrying changes it — the user has to link the
 * device again (spec/10 § Surface).
 */
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'unauthenticated';

// Host presence. `unknown` until the first daemon.online / daemon.offline
// greeting arrives on connect — distinct from a known `offline`.
export type DaemonPresence = 'unknown' | 'online' | 'offline';

// One host's report about the shared accounts for a backend (`host.account`,
// spec/10 § Surface in Settings). The accounts are server-owned and available
// to every host; this stores only that host's latest validation and usage
// readings. Absent (no entry) means that host has not reported yet.
//
// `seq` counts the reports seen for this (host, backend) pair. Settings'
// connect/disconnect resolve on a FRESH report, and a report can legitimately
// repeat the value it just had (a disconnect the host failed to apply reports
// `connected: true` again), so the value alone cannot distinguish "answered"
// from "never answered".
export type HostAccount = Omit<HostAccountEvent, 'type'> & { seq: number };

/** Why the last WebSocket closed — a diagnostics input (spec/12 § Connection diagnostics screen). */
export interface WsCloseInfo {
  code: number;
  reason: string;
  at: number;
}

/** What the surface knows about one registered host (spec/03 § `auth.ok`). */
export interface HostPresence {
  hostId: string;
  online: boolean;
  lastSeenAt: number | null;
  host: Omit<HostInfoEvent, 'type'> | null;
  accounts: Record<string, HostAccount>;
  /**
   * That host's Claude Code settings.json + memory entries
   * (`claude_settings.list` / `.updated`, spec/02 § Claude Code settings).
   * Absent/null until the host has reported it — Settings then draws no editor
   * rather than an empty one that would read as "this machine has none".
   */
  claudeSettings?: { settingsJson: string; memories: ClaudeMemoryEntry[] } | null;
  /**
   * Why this online host is struggling (`host.condition`); null or absent while
   * it is coping. Dropped when the host goes offline.
   */
  condition?: HostConditionEvent | null;
}

/**
 * One backend's credential state on one host, or `null` when that host has not
 * reported it yet. The ONLY way to ask "is Claude connected?" — the question is
 * meaningless without naming a machine, so the answer always takes one.
 */
export function hostAccount(
  hosts: Record<string, HostPresence>,
  hostId: string | null,
  backendId: string,
): HostAccount | null {
  if (hostId === null || hostId === '') return null;
  return hosts[hostId]?.accounts[backendId] ?? null;
}

/**
 * The model a spawn on `hostId` that names none will run on — that host's
 * last-used model (spec/04 § Spawn), as it reports it. `null` until the host
 * has reported one, in which case the surface has nothing to preselect and a
 * model-less spawn there is an error the host raises, never a guess made here.
 */
export function hostDefaultModel(
  hosts: Record<string, HostPresence>,
  hostId: string | null,
): string | null {
  if (hostId === null || hostId === '') return null;
  return hosts[hostId]?.host?.defaultModel ?? null;
}

interface PresenceState {
  connection: ConnectionState;
  /**
   * Whether the WS outage is worth telling the user about: the app has been in
   * the FOREGROUND with the link down for longer than the disconnect grace
   * (`DISCONNECT_GRACE_MS` in api/ws.ts). Drives the amber banner only —
   * `connection` stays the true link state for diagnostics and controls. A
   * socket Android dropped while the app sat in the background, and the
   * reconnect that follows opening it again, never set this
   * (spec/12 § Surface connection state model).
   */
  outageVisible: boolean;
  setOutageVisible(v: boolean): void;
  /**
   * The link has stayed down past `SERVER_LOST_MS` (api/ws.ts) with the app in
   * the foreground: the server is lost, not a blip. Escalates the banner's wording.
   */
  serverLost: boolean;
  setServerLost(v: boolean): void;
  /**
   * Every registered host, keyed by hostId, seeded from the `auth.ok`
   * greeting so the list is complete even for machines that are asleep.
   */
  hosts: Record<string, HostPresence>;
  /**
   * Aggregate over `hosts`: `online` while ANY host is up, matching
   * `/api/daemon/healthz` without a hostId (spec/01 § Endpoints). `unknown`
   * until the greeting lands, so the first paint is neutral rather than a
   * false "offline" flash.
   */
  daemon: DaemonPresence;
  /**
   * Connection forensics for the diagnostics screen (spec/12 § Connection
   * diagnostics screen). `everConnected` is what separates "this surface has
   * never got a link up" (blocking error screen — there is no app behind it)
   * from "we were connected and dropped" (banner + navigable app), so it must
   * never be inferred from `connection` alone.
   */
  wsUrl: string | null;
  everConnected: boolean;
  failedAttempts: number;
  lastClose: WsCloseInfo | null;
  accountId: string | null;
  surfaceId: string | null;
  setConnection(s: ConnectionState): void;
  /**
   * Why the server refused this surface, or null when it hasn't. Drives the
   * "you were signed out" line on the pairing screen, so the user is told what
   * happened rather than meeting an unexplained sign-in prompt.
   */
  authRejected: string | null;
  setAuthRejected(reason: string | null): void;
  setHost(p: DaemonPresence): void;
  /** Seed the whole roster from the `auth.ok` greeting. */
  setHosts(hosts: AuthOkHost[]): void;
  /** One host's presence changed (`host.online` / `host.offline`). */
  setHostOnline(hostId: string, online: boolean): void;
  /** One host's condition (`host.condition`). */
  setHostCondition(condition: HostConditionEvent): void;
  /** One host's self-description (`host.host`). */
  setHostReport(report: HostInfoEvent): void;
  /** One backend's credential state on one host (`host.account`). */
  setHostAccount(report: HostAccountEvent): void;
  /**
   * A host was removed from the account (`host.removed`, or the answer to this
   * surface's own `DELETE /api/hosts/:hostId`): drop it and every report
   * cached for it. It cannot reconnect without being paired again.
   */
  removeHost(hostId: string): void;
  /** One host's Claude Code settings + memory snapshot (`claude_settings.*`). */
  setClaudeSettings(hostId: string, settingsJson: string, memories: ClaudeMemoryEntry[]): void;
  /** A socket reached OPEN: clears the failure counters. */
  noteWsOpen(url: string): void;
  /** A socket closed (or a connect attempt failed): records why, counts it. */
  noteWsClose(info: WsCloseInfo): void;
  setIdentity(accountId: string | null, surfaceId: string | null): void;
}

/** A host row for a hostId the store has not seen described yet. */
function blankHost(hostId: string): HostPresence {
  return { hostId, online: false, lastSeenAt: null, host: null, accounts: {} };
}

const anyOnline = (hosts: Record<string, HostPresence>): boolean =>
  Object.values(hosts).some((h) => h.online);

/**
 * The host a host-scoped action targets when the user has not picked one: the
 * only registered host, else the only online one. With several candidates there
 * is no right answer, so this returns null and the caller refuses
 * — sending a host-scoped edit to a guessed machine is precisely what
 * `hostId` exists to prevent.
 */
export function defaultHostId(hosts: Record<string, HostPresence>): string | null {
  const all = Object.values(hosts);
  if (all.length === 1) return (all[0] as HostPresence).hostId;
  // Hosts come and go: with several registered, the one live machine is the
  // unambiguous target; two live machines are a choice, not a guess.
  const online = all.filter((h) => h.online);
  return online.length === 1 ? (online[0] as HostPresence).hostId : null;
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  // NO offline flash on load: start `connecting` with `unknown` host
  // presence so the first paint shows a neutral, quiet indicator.
  connection: 'connecting',
  outageVisible: false,
  serverLost: false,
  authRejected: null,
  hosts: {},
  daemon: 'unknown',
  wsUrl: null,
  everConnected: false,
  failedAttempts: 0,
  lastClose: null,
  accountId: null,
  surfaceId: null,
  setAuthRejected(reason) {
    set({ authRejected: reason });
  },

  setConnection(s) {
    set({ connection: s });
  },
  setOutageVisible(v) {
    set({ outageVisible: v });
  },
  setServerLost(v) {
    set({ serverLost: v });
  },
  setHost(p) {
    set({ daemon: p });
  },
  setHosts(list) {
    const hosts: Record<string, HostPresence> = {};
    for (const h of list) {
      const accounts: Record<string, HostAccount> = {};
      for (const a of h.accounts) accounts[a.backendId] = { ...a, seq: 1 };
      hosts[h.hostId] = {
        hostId: h.hostId,
        online: h.online,
        lastSeenAt: h.lastSeenAt,
        host: h.host,
        accounts,
        // The greeting carries no settings snapshot; the server replays it as
        // a separate frame right after. Keep one already received.
        claudeSettings: get().hosts[h.hostId]?.claudeSettings ?? null,
      };
    }
    set({ hosts, daemon: anyOnline(hosts) ? 'online' : 'offline' });
  },
  setHostOnline(hostId, online) {
    set((s) => {
      const prev = s.hosts[hostId] ?? blankHost(hostId);
      const hosts = {
        ...s.hosts,
        [hostId]: {
          ...prev,
          online,
          ...(online ? { lastSeenAt: Date.now() } : { condition: null }),
        },
      };
      return { hosts, daemon: anyOnline(hosts) ? 'online' : 'offline' };
    });
  },
  setHostCondition(condition) {
    set((s) => {
      const prev = s.hosts[condition.hostId] ?? blankHost(condition.hostId);
      const hosts = {
        ...s.hosts,
        [condition.hostId]: { ...prev, condition: condition.state === 'online' ? null : condition },
      };
      return { hosts };
    });
  },
  setHostReport(report) {
    set((s) => {
      // Strip the wire envelope; the store holds the payload.
      const { type: _envelope, ...host } = report;
      void _envelope;
      const prev = s.hosts[report.hostId] ?? blankHost(report.hostId);
      return { hosts: { ...s.hosts, [report.hostId]: { ...prev, host } } };
    });
  },
  setHostAccount(report) {
    set((s) => {
      const { type: _envelope, ...account } = report;
      void _envelope;
      const prev = s.hosts[report.hostId] ?? blankHost(report.hostId);
      const seq = (prev.accounts[report.backendId]?.seq ?? 0) + 1;
      return {
        hosts: {
          ...s.hosts,
          [report.hostId]: {
            ...prev,
            accounts: { ...prev.accounts, [report.backendId]: { ...account, seq } },
          },
        },
      };
    });
  },
  removeHost(hostId) {
    set((s) => {
      if (!s.hosts[hostId]) return {};
      const hosts = { ...s.hosts };
      delete hosts[hostId];
      return { hosts, daemon: anyOnline(hosts) ? 'online' : 'offline' };
    });
  },
  setClaudeSettings(hostId, settingsJson, memories) {
    set((s) => {
      const prev = s.hosts[hostId] ?? blankHost(hostId);
      return {
        hosts: {
          ...s.hosts,
          [hostId]: {
            ...prev,
            claudeSettings: { settingsJson, memories },
          },
        },
      };
    });
  },
  noteWsOpen(url) {
    set({ wsUrl: url, everConnected: true, failedAttempts: 0 });
  },
  noteWsClose(info) {
    set((s) => ({ lastClose: info, failedAttempts: s.failedAttempts + 1 }));
  },
  setIdentity(accountId, surfaceId) {
    set({ accountId, surfaceId });
  },
}));
