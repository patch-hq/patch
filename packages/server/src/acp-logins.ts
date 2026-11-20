// An ACP agent's own sign-in on one host, started from a surface (spec/10 §
// Signing in → an ACP agent; decision 25).
//
// The server does not run the sign-in and holds nothing of it: it asks the
// host (`acp.login_request`), which runs the agent's `authenticate` and keeps
// the login in the agent's own files there. What the server keeps is how each
// sign-in is going, from the host's `acp.login_update`s, so every surface (web,
// mobile, the CLI) reads one answer by polling: the address to open, a code to
// enter, and whether a pasted redirect address is wanted. The result is that
// host's alone; it reaches the account states through the host's own
// `host.account` report, like every other account fact.

import { randomUUID } from 'node:crypto';
import type { AcpLoginStatus, AcpLoginUpdateEvent, WireEvent } from '@patch/wire';
import { SettingsError } from './shared-settings.js';

export interface AcpLoginView {
  loginId: string;
  hostId: string;
  agentId: string;
  methodId: string;
  status: AcpLoginStatus;
  url?: string;
  userCode?: string;
  /** Paste the address the browser ended on: the agent waits for a redirect on the host. */
  loopback?: boolean;
  message?: string;
}

export interface AcpLoginsOptions {
  sendToHost: (hostId: string, event: WireEvent) => void;
  isOnline: (hostId: string) => boolean;
  /** The host says it can run an ACP sign-in (`host.host.acpLogin`). */
  hostCanLogin: (hostId: string) => boolean;
  hostName?: (hostId: string) => string | undefined;
  now?: () => number;
  /** How long a host has to say it started, before the sign-in is failed. */
  answerTimeoutMs?: number;
}

/** A finished sign-in is kept this long, so a surface that polls late still reads how it ended. */
const KEEP_MS = 30 * 60_000;
const ANSWER_TIMEOUT_MS = 30_000;
const TERMINAL: ReadonlySet<AcpLoginStatus> = new Set(['complete', 'failed', 'cancelled']);

export class AcpLogins {
  private readonly logins = new Map<string, AcpLoginView & { at: number }>();
  private readonly now: () => number;

  constructor(private readonly o: AcpLoginsOptions) {
    this.now = o.now ?? (() => Date.now());
  }

  private name(hostId: string): string {
    return this.o.hostName?.(hostId) ?? hostId;
  }

  /** Ask a host to run one of the agent's sign-in methods. */
  start(hostId: string, agentId: string, methodId: string): AcpLoginView {
    this.sweep();
    if (!this.o.isOnline(hostId)) {
      throw new SettingsError(409, 'host_offline', `${this.name(hostId)} is offline`);
    }
    if (!this.o.hostCanLogin(hostId)) {
      throw new SettingsError(
        409,
        'host_too_old',
        `${this.name(hostId)} cannot run an agent's sign-in until it is updated`,
      );
    }
    for (const l of this.logins.values()) {
      if (l.hostId === hostId && l.agentId === agentId && !TERMINAL.has(l.status)) {
        throw new SettingsError(
          409,
          'login_running',
          `A sign-in to ${agentId} is already running on ${this.name(hostId)}`,
        );
      }
    }
    const loginId = randomUUID();
    const login = {
      loginId,
      hostId,
      agentId,
      methodId,
      status: 'starting' as const,
      at: this.now(),
    };
    this.logins.set(loginId, login);
    this.o.sendToHost(hostId, { type: 'acp.login_request', hostId, loginId, agentId, methodId });
    const timer = setTimeout(() => {
      const l = this.logins.get(loginId);
      if (l?.status === 'starting') {
        this.set(loginId, {
          status: 'failed',
          message: `${this.name(hostId)} did not answer; it may be restarting or offline`,
        });
      }
    }, this.o.answerTimeoutMs ?? ANSWER_TIMEOUT_MS);
    timer.unref();
    return this.view(loginId);
  }

  get(loginId: string, agentId: string): AcpLoginView {
    const l = this.logins.get(loginId);
    if (!l || l.agentId !== agentId) {
      throw new SettingsError(
        410,
        'login_gone',
        'That sign-in has ended or expired. Start it again.',
      );
    }
    return this.view(loginId);
  }

  /** The address the person's browser ended on, for the host to replay where the agent listens. */
  callback(loginId: string, agentId: string, url: string): AcpLoginView {
    const l = this.get(loginId, agentId);
    if (l.status !== 'waiting' || l.loopback !== true) {
      throw new SettingsError(
        409,
        'not_waiting',
        'This sign-in is not waiting for an address from the browser',
      );
    }
    this.o.sendToHost(l.hostId, { type: 'acp.login_callback', hostId: l.hostId, loginId, url });
    return l;
  }

  cancel(loginId: string, agentId: string): AcpLoginView {
    const l = this.get(loginId, agentId);
    if (TERMINAL.has(l.status)) return l;
    this.o.sendToHost(l.hostId, { type: 'acp.login_cancel', hostId: l.hostId, loginId });
    return this.set(loginId, { status: 'cancelled' });
  }

  /** A host's word on a sign-in it runs. Another host's word on it is ignored. */
  observe(event: WireEvent): void {
    if (event.type !== 'acp.login_update') return;
    const l = this.logins.get(event.loginId);
    if (!l || l.hostId !== event.hostId || TERMINAL.has(l.status)) return;
    this.set(event.loginId, updateOf(event));
  }

  private set(loginId: string, patch: Partial<AcpLoginView>): AcpLoginView {
    const l = this.logins.get(loginId)!;
    // What the host said before stays unless it says something new.
    this.logins.set(loginId, { ...l, ...patch, at: this.now() });
    return this.view(loginId);
  }

  private view(loginId: string): AcpLoginView {
    const { at: _at, ...view } = this.logins.get(loginId)!;
    void _at;
    return view;
  }

  private sweep(): void {
    for (const [id, l] of this.logins) {
      if (TERMINAL.has(l.status) && this.now() - l.at > KEEP_MS) this.logins.delete(id);
    }
  }
}

function updateOf(e: AcpLoginUpdateEvent): Partial<AcpLoginView> {
  return {
    status: e.status,
    ...(e.url !== undefined ? { url: e.url } : {}),
    ...(e.userCode !== undefined ? { userCode: e.userCode } : {}),
    ...(e.loopback !== undefined ? { loopback: e.loopback } : {}),
    ...(e.message !== undefined ? { message: e.message } : {}),
  };
}
