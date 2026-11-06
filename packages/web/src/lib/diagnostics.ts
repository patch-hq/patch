// Connection diagnostics (spec/12 § Connection diagnostics screen).
//
// "Can't reach the agent" is the most common way patch looks broken, and the
// four causes are indistinguishable from a banner: the host is offline, the
// server is down, the HOST is down while the server is fine, or this
// surface's credential is being rejected. These checks separate them by
// actually probing — never by restating cached UI state.
//
// Deliberately NOT routed through `api/rest.ts`: that throws on any non-2xx, and
// the whole point here is that the STATUS is the signal (503 = host offline,
// 401 = credential rejected). We read the response instead of losing it in an
// exception.

import { loadCredential, decodeSurfaceClaims } from './credential.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { BUILD_INFO } from './buildInfo.js';
import { wireCompatStats } from '@patch/wire';

export type CheckStatus = 'pass' | 'fail';
export type CheckId = 'credential' | 'server' | 'agent' | 'websocket' | 'protocol';

export interface DiagnosticCheck {
  id: CheckId;
  label: string;
  status: CheckStatus;
  /** The real evidence — HTTP status, thrown error message, version strings. */
  detail: string;
  /** What the user can do about a failure, in one sentence; absent on a pass. */
  fix?: string;
}

export interface DiagnosticsReport {
  generatedAt: string;
  origin: string;
  wsUrl: string;
  build: string;
  checks: DiagnosticCheck[];
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checkCredential(): DiagnosticCheck {
  const claims = decodeSurfaceClaims();
  if (claims === null) {
    return {
      id: 'credential',
      label: 'Surface credential',
      status: 'fail',
      detail: 'no credential stored, so this surface is not paired',
      fix: 'Pair this device again from the sign-in screen.',
    };
  }
  return {
    id: 'credential',
    label: 'Surface credential',
    status: 'pass',
    detail: `stored · ${claims.surfaceId} (${claims.surfaceKind})`,
  };
}

async function checkServer(): Promise<DiagnosticCheck> {
  const base = { id: 'server' as const, label: 'Patch server' };
  try {
    const res = await fetch('/api/healthz');
    if (!res.ok) {
      return {
        ...base,
        status: 'fail',
        detail: `answered HTTP ${res.status}`,
        fix: 'The server is answering but unwell. Check its logs, or wait for it to recover.',
      };
    }
    const body = (await res.json()) as { version?: string; gitSha?: string };
    return {
      ...base,
      status: 'pass',
      detail: `HTTP 200 · version ${body.version ?? '?'} · sha ${body.gitSha ?? '?'}`,
    };
  } catch (err) {
    return {
      ...base,
      status: 'fail',
      detail: `unreachable: ${errText(err)}`,
      fix: 'Check this device has internet and that the server is running and its address is right.',
    };
  }
}

async function checkAgent(): Promise<DiagnosticCheck> {
  const base = { id: 'agent' as const, label: 'Agent (host) link' };
  const cred = loadCredential();
  if (cred === null) {
    // The probe is authed; without a credential it can only 401, which would
    // read as "credential rejected" and mislead. Say what's actually true.
    return {
      ...base,
      status: 'fail',
      detail: 'not checked, no surface credential to ask with',
      fix: 'Pair this device again from the sign-in screen.',
    };
  }
  try {
    const res = await fetch('/api/daemon/healthz', {
      headers: { authorization: `Bearer ${cred}` },
    });
    if (res.status === 200) {
      return { ...base, status: 'pass', detail: 'agent is connected to the server' };
    }
    if (res.status === 503) {
      return {
        ...base,
        status: 'fail',
        detail: 'server is up, but no agent (host) is connected to it',
        fix: 'Wake the host that runs the agent and make sure Patch is running there.',
      };
    }
    if (res.status === 401) {
      return {
        ...base,
        status: 'fail',
        detail: 'server rejected this surface credential (HTTP 401), re-pair this device',
        fix: 'Pair this device again from the sign-in screen.',
      };
    }
    return {
      ...base,
      status: 'fail',
      detail: `unexpected HTTP ${res.status}`,
      fix: 'The server answered oddly. Check its logs.',
    };
  } catch (err) {
    return {
      ...base,
      status: 'fail',
      detail: `could not ask the server: ${errText(err)}`,
      fix: 'Check this device has internet and that the server is running.',
    };
  }
}

function checkWebsocket(): DiagnosticCheck {
  const { connection, wsUrl, failedAttempts, lastClose, everConnected } =
    usePresenceStore.getState();
  const parts = [
    `state ${connection}`,
    `url ${wsUrl ?? '(none)'}`,
    everConnected ? 'has connected this session' : 'never connected this session',
    `failed attempts ${failedAttempts}`,
    lastClose === null
      ? 'no close recorded'
      : `last close ${lastClose.code} ${lastClose.reason === '' ? '(no reason)' : lastClose.reason} at ${new Date(lastClose.at).toISOString()}`,
  ];
  return {
    id: 'websocket',
    label: 'Live connection (WebSocket)',
    status: connection === 'connected' ? 'pass' : 'fail',
    detail: parts.join(' · '),
    ...(connection === 'connected'
      ? {}
      : {
          fix:
            'Tap Retry now. If it keeps failing while the server check passes, something between ' +
            'this device and the server (a proxy, VPN or firewall) is blocking live connections.',
        }),
  };
}

/** How long a diagnostics run waits for a dial already in flight to settle. */
export const WS_SETTLE_TIMEOUT_MS = 5_000;

/**
 * The live-connection check must describe the attempt that is happening NOW,
 * not the one that finished before the user pressed Diagnose. If a dial is in
 * flight, wait for it to connect or fail (bounded), so the report never shows
 * the previous attempt's outcome.
 */
function waitForWsToSettle(): Promise<void> {
  const inFlight = (): boolean => {
    const c = usePresenceStore.getState().connection;
    return c === 'connecting' || c === 'reconnecting';
  };
  if (!inFlight()) return Promise.resolve();
  const startAttempts = usePresenceStore.getState().failedAttempts;
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, WS_SETTLE_TIMEOUT_MS);
    const unsubscribe = usePresenceStore.subscribe((s) => {
      if (s.connection === 'connected' || s.failedAttempts > startAttempts) done();
    });
  });
}

/**
 * What forward compatibility has absorbed on this surface (spec/03 § Forward
 * compatibility). Two different facts, and only one of them is a problem:
 *
 *   - Fields we ignored: the host is newer and sent something this build has
 *     no use for. Harmless, and recorded only so drift is visible rather than
 *     silent.
 *   - Event TYPES we dropped: the host is emitting behaviour this build does
 *     not implement at all. That is a real gap, and the honest thing to tell
 *     the user is to update this surface — so it FAILS the check.
 */
function checkProtocol(): DiagnosticCheck {
  const { unknownTypes, unknownFields } = wireCompatStats();
  const types = Object.entries(unknownTypes);
  const fields = Object.entries(unknownFields);
  const render = (pairs: [string, number][]): string =>
    pairs.map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ');
  if (types.length > 0) {
    return {
      id: 'protocol',
      label: 'Wire protocol',
      status: 'fail',
      detail: `this surface is behind the agent: it dropped event types it does not know (${render(types)}) — update this surface`,
      fix: 'Update this app to the latest version.',
    };
  }
  return {
    id: 'protocol',
    label: 'Wire protocol',
    status: 'pass',
    detail:
      fields.length === 0
        ? 'no unknown events or fields seen'
        : `ignored unknown fields from a newer agent (${render(fields)}) — harmless, but this surface is behind`,
  };
}

export async function runDiagnostics(): Promise<DiagnosticsReport> {
  const credential = checkCredential();
  const [server, agent] = await Promise.all([
    checkServer(),
    checkAgent(),
    waitForWsToSettle(),
  ]).then(([a, b]) => [a, b] as const);
  const { wsUrl } = usePresenceStore.getState();
  return {
    generatedAt: new Date().toISOString(),
    origin: window.location.origin,
    wsUrl: wsUrl ?? '(none)',
    build: `${BUILD_INFO.version} · ${BUILD_INFO.gitSha} · built ${BUILD_INFO.builtAt}`,
    checks: [credential, server, agent, checkWebsocket(), checkProtocol()],
  };
}

/** Plain-text report for the clipboard — everything needed to report the fault. */
export function formatReport(r: DiagnosticsReport): string {
  const lines = [
    'patch connection diagnostics',
    `generated: ${r.generatedAt}`,
    `origin:    ${r.origin}`,
    `ws url:    ${r.wsUrl}`,
    `surface:   ${r.build}`,
    '',
    ...r.checks.flatMap((c) => [
      `[${c.status === 'pass' ? 'OK  ' : 'FAIL'}] ${c.id}: ${c.detail}`,
      ...(c.fix ? [`       fix: ${c.fix}`] : []),
    ]),
  ];
  return lines.join('\n');
}
