// The ACP agents this host can run (spec/02 § Provider adapters).
//
// Which agents exist is configuration (`@patch/wire`'s `BUILTIN_ACP_AGENTS`
// plus the shared `acpAgents` setting). This module answers the host-side
// questions about them: is the command on this host, what environment does
// it run with (its credential is its first ACP account's key, which the server
// holds and sends with every settings snapshot, else a shared provider key,
// else the agent's own sign-in on this host), and — by
// asking the agent itself over ACP — what it can do, which models it offers
// and whether it is signed in.
//
// An agent whose command is not on this host is simply not offered here; one
// that is installed but refuses to start a session says why, against that
// agent, in the model picker and in Settings → Hosts. No fallback: a probe
// that fails is reported, never replaced by a guessed model list.

import { accessSync, constants, mkdirSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  acpModelId,
  providerDescriptor,
  resolveAcpAgents,
  type AcpAgentConfig,
  type AccountState,
  type HostBackend,
  type ProviderCapabilities,
  type ProviderKeyId,
} from '@patch/wire';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  InitializeResponse,
  NewSessionResponse,
  SessionConfigOption,
} from '@agentclientprotocol/sdk';
import { AcpClosedError, AcpConnection, AcpRpcError, ACP_AUTH_REQUIRED } from './acpConnection.js';
import { AcpChildProcess } from './acpProcess.js';
import { AcpLogin, loginMethodsOf, type LoginMethod, type LoginUpdate } from './acpLogin.js';

export const ACP_BACKEND_ID = providerDescriptor('acp').backendId;

/** What one agent said about itself at `initialize` and `session/new`. */
export interface AcpProbe {
  /** `ready` and the account states ACP can tell apart (spec/10 § Account states). */
  state: AccountState;
  version?: string;
  capabilities: AcpAgentCapabilities;
  models: Array<{ id: string; label: string }>;
  /** The agent's own sign-in methods that log in rather than take a key (`acpLogin.ts`). */
  loginMethods?: LoginMethod[];
  at: number;
}

/** What an agent advertises over ACP that Patch's features follow. */
export interface AcpAgentCapabilities {
  /** `session/load`: the agent can reopen a saved session, replaying it. */
  loadSession: boolean;
  /** `session/resume`: the agent can reopen a saved session without replaying it. */
  resumeSession: boolean;
  /** The agent accepts image content in a prompt. */
  image: boolean;
}

const NO_CAPABILITIES: AcpAgentCapabilities = {
  loadSession: false,
  resumeSession: false,
  image: false,
};

export function agentCapabilities(init: InitializeResponse | undefined): AcpAgentCapabilities {
  const caps = init?.agentCapabilities;
  return {
    loadSession: caps?.loadSession === true,
    resumeSession: caps?.sessionCapabilities?.resume != null,
    image: caps?.promptCapabilities?.image === true,
  };
}

/** The provider capabilities an agent declares (spec/02 § Provider adapters). */
export function declaredCapabilities(caps: AcpAgentCapabilities): ProviderCapabilities {
  return {
    resume: caps.loadSession || caps.resumeSession,
    // ACP has no message edit, rewind, branch, native-tool switch or steer.
    editAtMessage: false,
    rewind: false,
    branchAtTurn: false,
    disableNativeTools: false,
    // `session/cancel` is part of every ACP agent.
    interrupt: true,
    steer: false,
  };
}

/**
 * The models a `session/new` (or load/resume) response offers. ACP carries
 * them either as a `model` config option or, from agents that predate config
 * options (Gemini CLI), as the unstable `models` field.
 */
export function sessionModels(
  agent: AcpAgentConfig,
  session: (NewSessionResponse & { models?: unknown }) | undefined,
): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  const option = (session?.configOptions ?? []).find(
    (o): o is SessionConfigOption & { type: 'select' } =>
      o.category === 'model' && o.type === 'select',
  );
  if (option) {
    for (const entry of option.options as unknown[]) {
      // A select's options are either flat or grouped.
      const group = entry as { options?: unknown[] };
      for (const o of (Array.isArray(group.options) ? group.options : [entry]) as Array<{
        value?: unknown;
        name?: unknown;
      }>) {
        if (typeof o.value === 'string' && o.value)
          out.push({ id: o.value, label: typeof o.name === 'string' && o.name ? o.name : o.value });
      }
    }
  } else {
    const models = session?.models as
      | { availableModels?: Array<{ modelId?: unknown; name?: unknown }> }
      | undefined;
    for (const m of models?.availableModels ?? []) {
      if (typeof m.modelId === 'string' && m.modelId)
        out.push({
          id: m.modelId,
          label: typeof m.name === 'string' && m.name ? m.name : m.modelId,
        });
    }
  }
  // An agent that names no models runs its own default.
  if (out.length === 0) out.push({ id: 'default', label: 'default' });
  return out.map((m) => ({
    id: acpModelId(agent.id, m.id),
    label: `${agent.label} · ${m.label}`,
  }));
}

/** Is this error the agent saying it needs a sign-in or a key? */
export function isAuthError(err: unknown): boolean {
  if (err instanceof AcpRpcError && err.code === ACP_AUTH_REQUIRED) {
    // -32000 is ACP's `auth_required`, but agents also use it as a generic
    // server error; only an auth-shaped message counts.
    return /auth|sign.?in|log.?in|api key|credential|unauthori[sz]ed|not configured/i.test(
      err.message,
    );
  }
  return err instanceof Error && /auth(entication)? required|api key is missing/i.test(err.message);
}

/** Find an executable on PATH, or check an absolute one. */
export function resolveCommand(command: string, pathEnv: string): string | undefined {
  const runnable = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isAbsolute(command)) return runnable(command) ? command : undefined;
  if (command.includes('/')) return undefined;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, command);
    if (runnable(p)) return p;
  }
  return undefined;
}

export interface AcpRegistryOptions {
  /** A shared provider key's value, read at the moment it is used. */
  providerKey(id: ProviderKeyId): string | undefined;
  /**
   * The API key of one of the agent's ACP accounts, as the server last sent
   * them: `accountId`'s, or with none named the account a turn would run on now.
   */
  accountKey?(agentId: string, accountId?: string): string | undefined;
  /** The environment agents are started with. */
  baseEnv(): Record<string, string | undefined>;
  /** Where probes run; nothing of the user's is ever opened by one. */
  scratchDir: string;
  /** Patch's own version, for `clientInfo`. */
  clientVersion: string;
  /** Something about an agent changed that Settings → Hosts shows. */
  onChange?(): void;
  probeTimeoutMs?: number;
  now?(): number;
}

const PROBE_FRESH_MS = 10 * 60_000;
const FAILED_PROBE_FRESH_MS = 60_000;

export class AcpRegistry {
  private configured: AcpAgentConfig[] | undefined;
  private readonly probes = new Map<string, { key: string; probe: AcpProbe }>();
  private readonly inFlight = new Map<string, { key: string; run: Promise<AcpProbe> }>();

  constructor(private readonly o: AcpRegistryOptions) {}

  /** Apply the shared `acpAgents` setting. */
  setConfigured(list: AcpAgentConfig[] | undefined): void {
    const before = JSON.stringify(this.configured ?? null);
    this.configured = list;
    if (JSON.stringify(list ?? null) !== before) this.o.onChange?.();
  }

  agents(): AcpAgentConfig[] {
    return resolveAcpAgents(this.configured);
  }

  agent(id: string): AcpAgentConfig | undefined {
    return this.agents().find((a) => a.id === id);
  }

  /** The agent's executable on this host, or undefined when it is not installed. */
  command(agent: AcpAgentConfig): string | undefined {
    return resolveCommand(agent.command, this.o.baseEnv()['PATH'] ?? '');
  }

  /** The agents installed on this host. */
  installed(): AcpAgentConfig[] {
    return this.agents().filter((a) => this.command(a) !== undefined);
  }

  /**
   * The environment the agent runs with: the host's, plus its keys. The
   * account's key (the turn's own account, else the one a turn would run on)
   * wins over a provider key mapped to the same variable.
   */
  env(agent: AcpAgentConfig, accountId?: string): Record<string, string | undefined> {
    const env = { ...this.o.baseEnv() };
    for (const [name, key] of Object.entries(agent.keys ?? {})) {
      const value = this.o.providerKey(key);
      if (value !== undefined) env[name] = value;
    }
    const account =
      agent.apiKeyEnv !== undefined ? this.o.accountKey?.(agent.id, accountId) : undefined;
    if (account !== undefined) env[agent.apiKeyEnv!] = account;
    return env;
  }

  /** Changes whenever what a probe would see changes: the entry or its keys. */
  private probeKey(agent: AcpAgentConfig): string {
    const keys = Object.values(agent.keys ?? {}).map((k) => this.o.providerKey(k) ?? '');
    keys.push(this.o.accountKey?.(agent.id) ?? '');
    return createHash('sha256')
      .update(JSON.stringify([agent, keys, this.command(agent) ?? null]))
      .digest('hex');
  }

  /** The latest probe of the agent, if one has run. */
  lastProbe(agentId: string): AcpProbe | undefined {
    return this.probes.get(agentId)?.probe;
  }

  /** What the agent can do, as far as the host has asked it. */
  capabilities(agentId: string): AcpAgentCapabilities {
    return this.lastProbe(agentId)?.capabilities ?? NO_CAPABILITIES;
  }

  /** The agent's state as of a probe or the last turn on it. */
  accountState(agentId: string): AccountState | undefined {
    return this.lastProbe(agentId)?.state;
  }

  /**
   * What a turn learned about the agent's account: a sign-in it was refused,
   * or a session it was given. Updates what Settings shows without a probe.
   */
  noteTurn(agentId: string, update: Partial<Omit<AcpProbe, 'at'>>): void {
    const agent = this.agent(agentId);
    if (!agent) return;
    const prev = this.probes.get(agentId)?.probe;
    const next: AcpProbe = {
      state: update.state ?? prev?.state ?? { state: 'ready' },
      capabilities: update.capabilities ?? prev?.capabilities ?? NO_CAPABILITIES,
      models: update.models ?? prev?.models ?? [],
      ...((update.version ?? prev?.version) !== undefined
        ? { version: (update.version ?? prev?.version)! }
        : {}),
      ...((update.loginMethods ?? prev?.loginMethods) !== undefined
        ? { loginMethods: (update.loginMethods ?? prev?.loginMethods)! }
        : {}),
      at: this.now(),
    };
    const changed = JSON.stringify(prev?.state) !== JSON.stringify(next.state);
    this.probes.set(agentId, { key: this.probeKey(agent), probe: next });
    if (changed) this.o.onChange?.();
  }

  /** Ask the agent what it is, reusing a fresh enough answer. */
  probe(agent: AcpAgentConfig, force = false): Promise<AcpProbe> {
    const key = this.probeKey(agent);
    const cached = this.probes.get(agent.id);
    if (!force && cached && cached.key === key) {
      const fresh = cached.probe.state.state === 'ready' ? PROBE_FRESH_MS : FAILED_PROBE_FRESH_MS;
      // A turn's note of a ready agent carries no model list: that one is asked.
      const complete = cached.probe.state.state !== 'ready' || cached.probe.models.length > 0;
      if (this.now() - cached.probe.at < fresh && complete) return Promise.resolve(cached.probe);
    }
    const running = this.inFlight.get(agent.id);
    if (running && running.key === key) return running.run;
    const run = this.runProbe(agent).then(
      (probe) => {
        const prev = this.probes.get(agent.id)?.probe;
        this.probes.set(agent.id, { key, probe });
        if (this.inFlight.get(agent.id)?.run === run) this.inFlight.delete(agent.id);
        if (JSON.stringify(prev?.state) !== JSON.stringify(probe.state) || !prev)
          this.o.onChange?.();
        return probe;
      },
      (err: unknown) => {
        if (this.inFlight.get(agent.id)?.run === run) this.inFlight.delete(agent.id);
        throw err;
      },
    );
    this.inFlight.set(agent.id, { key, run });
    return run;
  }

  /**
   * Every installed agent's models, and a reason against each agent that
   * offered none (not signed in, would not start).
   */
  async models(): Promise<{
    models: Array<{ id: string; label: string }>;
    errors: Array<{ agent: AcpAgentConfig; message: string }>;
  }> {
    const agents = this.installed();
    const results = await Promise.allSettled(agents.map((a) => this.probe(a)));
    const models: Array<{ id: string; label: string }> = [];
    const errors: Array<{ agent: AcpAgentConfig; message: string }> = [];
    results.forEach((r, i) => {
      const agent = agents[i]!;
      if (r.status === 'rejected') {
        errors.push({ agent, message: `${agent.label}: ${(r.reason as Error).message}` });
        return;
      }
      if (r.value.state.state === 'ready' || r.value.state.state === 'near_limit')
        models.push(...r.value.models);
      else errors.push({ agent, message: `${agent.label}: ${describeProbeState(r.value.state)}` });
    });
    return { models, errors };
  }

  /** Settings → Hosts' row for each installed agent. */
  backendEntries(): HostBackend[] {
    return this.installed().map((agent) => {
      const probe = this.lastProbe(agent.id);
      const state = probe?.state;
      return {
        id: `acp:${agent.id}`,
        label: agent.label,
        version: probe?.version ?? null,
        state:
          state === undefined ||
          state.state === 'ready' ||
          state.state === 'near_limit' ||
          state.state === 'limited'
            ? 'present'
            : state.state === 'signed_out'
              ? 'logged-out'
              : 'failed',
        ...(state && (state.state === 'broken' || state.state === 'out')
          ? { error: state.message }
          : {}),
        ...(probe?.loginMethods?.length ? { loginMethods: probe.loginMethods } : {}),
      };
    });
  }

  /** The sign-in methods the agent offered at its last probe; asks it when none is fresh. */
  async loginMethods(agent: AcpAgentConfig): Promise<LoginMethod[]> {
    return (await this.probe(agent)).loginMethods ?? [];
  }

  /**
   * Run one of the agent's own sign-in methods on this host. The login is the
   * agent's, kept in its own files here. Its environment carries no account key,
   * so the agent signs in with the method asked for rather than a key it was given.
   */
  login(agent: AcpAgentConfig, methodId: string, onUpdate: (u: LoginUpdate) => void): AcpLogin {
    const command = this.command(agent);
    if (!command) throw new Error(`${agent.command} is not installed on this host`);
    const env = this.env(agent);
    if (agent.apiKeyEnv !== undefined) delete env[agent.apiKeyEnv];
    for (const name of Object.keys(agent.keys ?? {})) delete env[name];
    const run = new AcpLogin({
      agent,
      command,
      methodId,
      env,
      cwd: this.o.scratchDir,
      initializeParams: initializeParams(this.o.clientVersion),
      onUpdate,
    });
    // Signed in or not, what the agent says about itself has changed.
    void run.done.then(() => this.probe(agent, true).catch(() => undefined));
    return run;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private async runProbe(agent: AcpAgentConfig): Promise<AcpProbe> {
    const command = this.command(agent);
    if (!command) throw new Error(`${agent.command} is not installed on this host`);
    mkdirSync(this.o.scratchDir, { recursive: true, mode: 0o700 });
    const proc = new AcpChildProcess({
      command,
      args: agent.args,
      cwd: this.o.scratchDir,
      env: this.env(agent),
    });
    const conn = new AcpConnection((line) => proc.write(line), {
      onNotification: () => undefined,
      onRequest: async (method) => {
        throw new AcpRpcError(method, -32601, `Patch does not offer ${method} to a probe`);
      },
    });
    let exitReason: string | undefined;
    proc.start(
      (line) => conn.receive(line),
      (reason) => {
        exitReason = reason;
        conn.close(reason);
      },
    );
    const timeoutMs = this.o.probeTimeoutMs ?? 60_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`did not answer within ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs,
      );
    });
    try {
      let init: InitializeResponse;
      try {
        init = await Promise.race([
          conn.request<InitializeResponse>('initialize', initializeParams(this.o.clientVersion)),
          timeout,
        ]);
      } catch (err) {
        throw new Error(probeFailure(err, exitReason, proc.stderrTail()));
      }
      const capabilities = agentCapabilities(init);
      const version = init.agentInfo?.version || undefined;
      const loginMethods = loginMethodsOf(init);
      const logins = loginMethods.length > 0 ? { loginMethods } : {};
      try {
        const session = await Promise.race([
          conn.request<NewSessionResponse>('session/new', {
            cwd: this.o.scratchDir,
            mcpServers: [],
          }),
          timeout,
        ]);
        return {
          state: { state: 'ready' },
          capabilities,
          models: sessionModels(agent, session),
          ...(version ? { version } : {}),
          ...logins,
          at: this.now(),
        };
      } catch (err) {
        if (isAuthError(err))
          return {
            state: { state: 'signed_out' },
            capabilities,
            models: [],
            ...(version ? { version } : {}),
            ...logins,
            at: this.now(),
          };
        return {
          state: { state: 'broken', message: probeFailure(err, exitReason, proc.stderrTail()) },
          capabilities,
          models: [],
          ...(version ? { version } : {}),
          ...logins,
          at: this.now(),
        };
      }
    } finally {
      clearTimeout(timer);
      conn.close('probe finished');
      proc.kill();
    }
  }
}

export function initializeParams(clientVersion: string): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    // Patch runs the agent on the host itself: the agent reads, writes and runs
    // commands with its own tools, and Patch offers none of the client-side ones.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'patch', title: 'Patch', version: clientVersion },
  };
}

function probeFailure(err: unknown, exitReason: string | undefined, stderr: string): string {
  const base =
    err instanceof AcpClosedError
      ? `the agent ${exitReason ?? 'exited'} before answering`
      : (err as Error).message;
  const tail = stderr.split('\n').slice(-3).join(' ').trim();
  return tail ? `${base} (${tail.slice(-300)})` : base;
}

export function describeProbeState(state: AccountState): string {
  switch (state.state) {
    case 'signed_out':
      return 'not signed in. Add an API key for it under Settings → AI accounts, or sign in to it on this host from there.';
    case 'broken':
    case 'out':
      return state.message;
    case 'limited':
      return 'limited for now.';
    default:
      return 'ready.';
  }
}
