// An ACP agent's own sign-in, run on this host (spec/10 § Signing in → an ACP
// agent; decision 25).
//
// An agent lists its sign-in methods at `initialize` (`authMethods`). The ones
// that log in rather than take a key are run here with ACP's `authenticate`:
// the agent does the sign-in itself and keeps the login in its own files on
// this host. Nothing of it reaches the server or another host.
//
// ACP has no message for "open this address": an agent says what the person
// must do in its own output (Gemini CLI writes "Otherwise navigate to: <url>"
// to stderr). That output is read for the hand-off: the address to open, a
// code to enter there, and whether the provider redirects back to a loopback
// address on this host. A browser on another device cannot reach that address,
// so the surface offers to paste the address the browser ended on and the host
// replays it here (`replay`). The replay only ever goes to the loopback address
// the agent itself announced.

import { mkdirSync } from 'node:fs';
import type { AuthMethod, InitializeResponse } from '@agentclientprotocol/sdk';
import type { AcpAgentConfig, AcpLoginStatus } from '@patch/wire';
import { AcpClosedError, AcpConnection, AcpRpcError } from './acpConnection.js';
import { AcpChildProcess } from './acpProcess.js';

export interface LoginMethod {
  id: string;
  name: string;
  description?: string;
}

/**
 * Does this method log in, rather than take a key or a configuration? A
 * terminal method needs an interactive terminal, which no surface has (ACP
 * forbids passing it to `authenticate`); a method the agent marks as taking an
 * API key or a gateway, or that names a key or Vertex AI, is not a login.
 */
export function isLoginMethod(m: AuthMethod): boolean {
  const raw = m as AuthMethod & { type?: string; _meta?: Record<string, unknown> | null };
  if (raw.type !== undefined && raw.type !== 'agent') return false;
  const meta = raw._meta ?? {};
  if ('api-key' in meta || 'gateway' in meta) return false;
  return !/api[ _-]?key|vertex|gateway/i.test(`${m.id} ${m.name}`);
}

export function loginMethodsOf(init: InitializeResponse | undefined): LoginMethod[] {
  return (init?.authMethods ?? []).filter(isLoginMethod).map((m) => ({
    id: m.id,
    name: m.name,
    ...(m.description ? { description: m.description } : {}),
  }));
}

export interface LoginHandoff {
  /** The address the person opens. */
  url?: string;
  /** A code they enter there. */
  userCode?: string;
  /** The loopback address on this host the provider redirects back to. */
  loopback?: { origin: string; path: string };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function loopbackOf(raw: string | null): LoginHandoff['loopback'] {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.has(u.hostname) || u.port === '')
      return undefined;
    return { origin: `${u.protocol}//${u.host}`, path: u.pathname };
  } catch {
    return undefined;
  }
}

/** What an agent's output says the person must do to sign in, as far as it says. */
export function readLoginHandoff(text: string): LoginHandoff {
  const out: LoginHandoff = {};
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    const candidate = match[0].replace(/[.,;]+$/, '');
    let u: URL;
    try {
      u = new URL(candidate);
    } catch {
      continue;
    }
    // A loopback address is where the provider comes back to, not where the person goes.
    if (LOOPBACK_HOSTS.has(u.hostname)) continue;
    out.url = candidate;
    const back = loopbackOf(u.searchParams.get('redirect_uri'));
    if (back) out.loopback = back;
    break;
  }
  const code =
    /\b(?:user code|code)\b[^A-Z0-9\n]{0,12}([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+|[A-Z0-9]{8,})\b/.exec(
      text,
    );
  if (code) out.userCode = code[1]!;
  return out;
}

export interface LoginUpdate {
  status: AcpLoginStatus;
  url?: string;
  userCode?: string;
  loopback?: boolean;
  message?: string;
}

export interface AcpLoginOptions {
  agent: AcpAgentConfig;
  command: string;
  methodId: string;
  env: Record<string, string | undefined>;
  cwd: string;
  initializeParams: Record<string, unknown>;
  onUpdate: (u: LoginUpdate) => void;
  /** How long the person has to finish. */
  timeoutMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

const LOGIN_TIMEOUT_MS = 15 * 60_000;

/** One sign-in on this host: an agent process asked to `authenticate`, until it answers. */
export class AcpLogin {
  private readonly proc: AcpChildProcess;
  private readonly conn: AcpConnection;
  private output = '';
  private handoff: LoginHandoff = {};
  private finished = false;
  private cancelled = false;
  private timer: NodeJS.Timeout | undefined;
  /** Settles when the sign-in is over, whichever way. */
  readonly done: Promise<AcpLoginStatus>;

  constructor(private readonly o: AcpLoginOptions) {
    mkdirSync(o.cwd, { recursive: true, mode: 0o700 });
    this.proc = new AcpChildProcess({
      command: o.command,
      args: o.agent.args,
      cwd: o.cwd,
      env: o.env,
    });
    this.conn = new AcpConnection((line) => this.proc.write(line), {
      onNotification: () => undefined,
      onRequest: async (method) => {
        throw new AcpRpcError(method, -32601, `Patch does not offer ${method} to a sign-in`);
      },
    });
    this.done = this.run();
  }

  /** What the agent has said so far. */
  current(): LoginHandoff {
    return { ...this.handoff };
  }

  private async run(): Promise<AcpLoginStatus> {
    let exitReason: string | undefined;
    this.o.onUpdate({ status: 'starting' });
    this.proc.start(
      (line) => this.conn.receive(line),
      (reason) => {
        exitReason = reason;
        this.conn.close(reason);
      },
      (chunk) => this.heard(chunk),
    );
    const timeout = new Promise<never>((_, reject) => {
      this.timer = setTimeout(
        () =>
          reject(
            new Error(
              `the sign-in was not finished within ${Math.round((this.o.timeoutMs ?? LOGIN_TIMEOUT_MS) / 60_000)} minutes`,
            ),
          ),
        this.o.timeoutMs ?? LOGIN_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([this.conn.request('initialize', this.o.initializeParams), timeout]);
      await Promise.race([
        this.conn.request('authenticate', { methodId: this.o.methodId }),
        timeout,
      ]);
      return this.finish({ status: 'complete' });
    } catch (err) {
      if (this.cancelled) return this.finish({ status: 'cancelled' });
      const base =
        err instanceof AcpClosedError
          ? `${this.o.agent.label} ${exitReason ?? 'exited'} before the sign-in finished`
          : `${this.o.agent.label}: ${(err as Error).message}`;
      const tail = this.output.trim().split('\n').slice(-3).join(' ').trim();
      return this.finish({
        status: 'failed',
        message: tail && !base.includes(tail) ? `${base} (${tail.slice(-300)})` : base,
      });
    }
  }

  private heard(chunk: string): void {
    this.output = (this.output + chunk).slice(-16_384);
    const next = readLoginHandoff(this.output);
    const changed =
      next.url !== this.handoff.url ||
      next.userCode !== this.handoff.userCode ||
      next.loopback?.origin !== this.handoff.loopback?.origin;
    if (!changed || this.finished) return;
    this.handoff = next;
    this.o.onUpdate({
      status: 'waiting',
      ...(next.url !== undefined ? { url: next.url } : {}),
      ...(next.userCode !== undefined ? { userCode: next.userCode } : {}),
      ...(next.loopback ? { loopback: true } : {}),
    });
  }

  private finish(u: LoginUpdate): AcpLoginStatus {
    if (this.timer) clearTimeout(this.timer);
    this.finished = true;
    this.conn.close('sign-in finished');
    this.proc.kill();
    this.o.onUpdate(u);
    return u.status;
  }

  /**
   * Replay the address the person's browser ended on, here, where the agent's
   * loopback listener can be reached. Refused unless it is that listener.
   */
  async replay(pasted: string): Promise<void> {
    const back = this.handoff.loopback;
    if (!back) throw new Error(`${this.o.agent.label} is not waiting for a redirect on this host`);
    let u: URL;
    try {
      u = new URL(pasted.trim());
    } catch {
      throw new Error('That is not an address');
    }
    if (`${u.protocol}//${u.host}` !== back.origin || u.pathname !== back.path) {
      throw new Error(
        `That address is not the one ${this.o.agent.label} is waiting on (${back.origin}${back.path})`,
      );
    }
    const res = await (this.o.fetch ?? fetch)(u.toString(), {
      signal: AbortSignal.timeout(15_000),
      redirect: 'manual',
    });
    if (res.status >= 400) {
      throw new Error(`${this.o.agent.label} refused the sign-in (HTTP ${res.status})`);
    }
  }

  cancel(): void {
    if (this.finished) return;
    this.cancelled = true;
    this.conn.close('sign-in cancelled');
    this.proc.kill();
  }
}
