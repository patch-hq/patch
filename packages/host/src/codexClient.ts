import { CodexRuntime } from './codexRuntime.js';
import { inWorkSlice } from './workSlice.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import type { DurableCodexProcess } from './codexDurable.js';

export type RpcObject = Record<string, any>;

/** Strip terminal colour and anything shaped like a JWT or API key. */
export function redactCodexLine(line: string): string {
  return line
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted-jwt]')
    .replace(/\b(sk|rt|sess)-[\w-]{10,}/g, '[redacted-key]')
    .trim();
}
export type CodexNotification = {
  method: string;
  params: RpcObject;
  id?: string | number;
  /** Set on a turn that runs under a durable runner: where this message ends in its output. */
  offset?: number;
};

/** One isolated Codex process. Never logs protocol payloads: login contains secrets. */
export class CodexClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: RpcObject) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listeners = new Set<(message: CodexNotification) => void>();
  private started: Promise<void> | undefined;
  /** Messages that arrived on a reattached turn before anyone subscribed. */
  private held: CodexNotification[] | undefined;
  private durableExited = false;
  get processId(): number | undefined {
    return this.options.durable ? this.options.durable.codexPid() : this.child?.pid;
  }
  get alive(): boolean {
    if (this.options.durable) return !this.durableExited && !this.options.durable.exited;
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }
  constructor(
    private readonly options: {
      home: string;
      executable?: string;
      credentialStore?: 'keyring' | 'ephemeral' | 'existing' | 'file';
      timeoutMs?: number;
      externalAuth?: () => { accessToken: string; chatgptAccountId: string };
      /** Added to app-server's environment: a model endpoint's key (`modelEndpoints.ts`). */
      env?: Record<string, string>;
      /** Each stderr line, ANSI-stripped and with token-shaped strings redacted. */
      onStderr?: (line: string) => void;
      /**
       * Run app-server under a detached runner so the turn outlives a host
       * restart (spec/02 § Host restarts), or reattach to one that already is.
       */
      durable?: DurableCodexProcess;
    },
  ) {}

  start(): Promise<void> {
    if (this.started) return this.started;
    const started = this.boot().catch(async (error) => {
      // A failed boot (e.g. initialize timed out) must not leave the child
      // running or the rejection cached: tear down so a later start() retries.
      if (this.started === started) this.started = undefined;
      await this.close();
      throw error;
    });
    this.started = started;
    return started;
  }
  private async boot(): Promise<void> {
    mkdirSync(this.options.home, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: this.options.home,
      // Codex is silent on stderr by default; sign-in failures must reach daemon.log.
      RUST_LOG: process.env['RUST_LOG'] ?? 'warn,codex_login=info,codex_login::auth::manager=warn',
    };
    // The selected account must never inherit another provider's billing credentials.
    for (const name of [
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'CHATGPT_ACCESS_TOKEN',
      'CODEX_API_KEY',
    ])
      delete env[name];
    Object.assign(env, this.options.env);
    const executable =
      this.options.executable ??
      process.env['PATCH_CODEX_EXECUTABLE'] ??
      (await new CodexRuntime(join(homedir(), '.patch/backends/codex')).ensure());
    const appArgs = [
      'app-server',
      '--stdio',
      ...(this.options.externalAuth
        ? ['-c', 'cli_auth_credentials_store="ephemeral"']
        : this.options.credentialStore === 'existing'
          ? []
          : ['-c', `cli_auth_credentials_store="${this.options.credentialStore ?? 'keyring'}"`]),
    ];
    const durable = this.options.durable;
    if (durable) {
      // The runner is itself started in the work slice, so app-server is not wrapped again.
      const handlers = {
        onLine: (line: string, end: number) => this.onLine(line, end),
        onExit: (reason: string) => {
          this.durableExited = true;
          this.reportDurableStderr(durable);
          this.fail(new Error(reason));
        },
      };
      if (durable.attaching) {
        // Carry on the ids the previous host used, so a replayed answer can never meet a new waiter.
        this.nextId = durable.recovered?.maxRequestId ?? 0;
        this.held = [];
        durable.attach(handlers);
        // The turn was initialised, and signed in, by the host that started it.
        return;
      }
      durable.start({ command: executable, args: appArgs, cwd: homedir(), env }, handlers);
    } else {
      const launch = inWorkSlice(executable, appArgs);
      const child = spawn(launch.command, launch.args, {
        env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      // Always drain stderr so its pipe never fills; hand lines on only redacted.
      const onStderr = this.options.onStderr;
      if (onStderr)
        createInterface({ input: child.stderr }).on('line', (line) => {
          const clean = redactCodexLine(line);
          if (clean) onStderr(clean);
        });
      else child.stderr.resume();
      child.stdin.on('error', (error) => this.fail(error));
      child.on('error', (error) => this.fail(error));
      child.on('exit', (code, signal) =>
        this.fail(new Error(`Codex process exited (${signal ?? code})`)),
      );
      createInterface({ input: child.stdout }).on('line', (line) =>
        this.onLine(line, undefined, child),
      );
    }
    await this.request('initialize', {
      clientInfo: { name: 'patch', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} });
    if (this.options.externalAuth) {
      await this.request('account/login/start', {
        type: 'chatgptAuthTokens',
        ...this.options.externalAuth(),
      });
    }
  }
  private reportDurableStderr(durable: DurableCodexProcess): void {
    const onStderr = this.options.onStderr;
    if (!onStderr) return;
    for (const line of durable.stderrTail()) {
      const clean = redactCodexLine(line);
      if (clean) onStderr(clean);
    }
  }
  private onLine(line: string, offset?: number, child?: ChildProcessWithoutNullStreams): void {
    let msg: RpcObject;
    try {
      msg = JSON.parse(line);
    } catch {
      this.fail(new Error('Codex returned invalid JSON'));
      if (child) this.signal(child, 'SIGTERM');
      else this.options.durable?.kill('SIGTERM');
      return;
    }
    if (typeof msg.method === 'string') {
      if (msg.method === 'account/chatgptAuthTokens/refresh' && this.options.externalAuth) {
        try {
          this.respond(msg.id, this.options.externalAuth());
        } catch (error) {
          this.respond(msg.id, undefined, (error as Error).message);
        }
        return;
      }
      // JSON-RPC makes `params` optional, so a notification can arrive
      // without one. CodexNotification declares it as always present and
      // every subscriber reads it straight off, so an absent `params` threw
      // out of this handler. Absent means "no parameters": `{}` is that.
      const notification = {
        ...msg,
        params: msg.params ?? {},
        ...(offset !== undefined ? { offset } : {}),
      } as CodexNotification;
      if (this.held) {
        this.held.push(notification);
        return;
      }
      for (const listener of this.listeners) listener(notification);
      if (msg.id !== undefined && this.listeners.size === 0)
        this.respond(msg.id, undefined, 'No handler for Codex request');
      return;
    }
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(`Codex RPC ${msg.error.code}: ${msg.error.message}`));
    else waiter.resolve(msg.result ?? {});
  }
  request(
    method: string,
    params: RpcObject = {},
    timeoutMs = this.options.timeoutMs ?? 20000,
  ): Promise<RpcObject> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  subscribe(listener: (message: CodexNotification) => void): () => void {
    this.listeners.add(listener);
    // A reattached turn's replay waits for its first subscriber.
    const held = this.held;
    if (held) {
      this.held = undefined;
      for (const m of held) listener(m);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }
  respond(id: string | number, result?: RpcObject, error?: string): void {
    this.write(error ? { id, error: { code: -32601, message: error } } : { id, result });
  }
  private write(message: RpcObject): void {
    if (this.options.durable) {
      if (this.durableExited) throw new Error('Codex is not running');
      this.options.durable.write(JSON.stringify(message));
      return;
    }
    if (!this.child || this.child.exitCode !== null || this.child.stdin.destroyed)
      throw new Error('Codex is not running');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  private fail(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    const failure = { method: 'patch/processFailed', params: { message: error.message } };
    // On a reattached turn nobody has subscribed yet: the failure waits behind the replay.
    if (this.held) this.held.push(failure);
    for (const listener of this.listeners) listener(failure);
  }
  private signal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  async descendants(): Promise<number[]> {
    const root = this.processId;
    if (!root || process.platform === 'win32') return [];
    const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=']);
    const rows = stdout
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number));
    const owned = new Set([root]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of rows)
        if (pid && parent && owned.has(parent) && !owned.has(pid)) {
          owned.add(pid);
          changed = true;
        }
    }
    owned.delete(root);
    return [...owned].reverse();
  }
  terminateDescendants(pids: number[]): void {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  async close(): Promise<void> {
    const durable = this.options.durable;
    if (durable) {
      // The host going down lets the turn carry on under the next one; only a
      // turn that is over, or abandoned, ends its app-server.
      if (durable.letGo) return;
      this.fail(
        new Error(
          'The ChatGPT session was closed while this turn was running, usually because the Patch host restarted',
        ),
      );
      durable.release();
      return;
    }
    this.fail(
      new Error(
        'The ChatGPT session was closed while this turn was running, usually because the Patch host restarted',
      ),
    );
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.signal(child, 'SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.signal(child, 'SIGTERM');
    });
    // The npm launcher may exit before native children acknowledge termination.
    this.signal(child, 'SIGKILL');
  }
}
