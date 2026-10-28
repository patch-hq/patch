import { z } from 'zod';
import { hostSecrets, tokenExpiry, refreshOpenAI, refreshClaude } from './provider-refresh.js';
// Shared settings (spec/01 § Settings).
//
// The server is the source of truth for every setting that is not tied to one
// machine — backend accounts, provider keys, agent behaviour, voice — and every host runs from the copy in the
// last `settings.snapshot` it was sent. A host never changes a shared setting
// itself: a change starts here, is committed here, and is then pushed.
//
// Four files under the data dir:
//   settings.json        the settings (the account preferences file this grew
//                        out of, so an old one reads as a partial settings)
//   settings-state.json  the version, and which hosts have been imported
//   secrets.json         credentials and provider keys, AES-256-GCM
//   secrets.key          that key: made on first start, nothing to configure
//
// The key lives beside what it locks, so it keeps a copy of secrets.json on its
// own (a backup, a pasted file) unreadable without asking anyone to set it up.
//
// NO FALLBACK, and no refusing to start either: secrets.json that cannot be
// read (its key gone or wrong) is a PROBLEM the server states in Settings. Until
// it is resolved nothing is sent to any host — a snapshot is a whole statement
// of the accounts, so one sent without them would sign every host out — and no
// secret can be written over the file that still holds them.

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import {
  DEFAULT_SHARED_SETTINGS,
  EMPTY_SHARED_SECRETS,
  PROVIDER_KEY_MIN_LENGTH,
  SharedSecrets,
  SharedSettings,
  SharedSettingsPatch,
  type AccountStrategy,
  type ClaudeCredential,
  HARNESS_PERMISSION_MODES,
  type HostSettingsState,
  type ProviderKeyId,
  type SettingsAdoptKind,
  type SettingsAdoptResponseEvent,
  type SettingsChangedEvent,
  type SettingsImport,
  type SharedClaudeAccount,
  type SharedCodexAccount,
  type SharedSecretsSummary,
  type WireEvent,
  accountsKeyForBackend,
  type ProviderBackendId,
} from '@patch/wire';
import { generateWebBotAuthKey, parseWebBotAuthKey } from '@patch/wire/web-bot-auth';
import { validateClaudeOAuthToken, type ClaudeTokenValidation } from '@patch/auth';

/** Settings keys a host held before they were shared — taken from the FIRST host imported. */
const HOST_HELD_KEYS = [
  'voiceConfig',
  'kokoroVoice',
  'permissionModeDefault',
  'chatNameInterval',
  'titleGenerationEnabled',
  'statusGenerationEnabled',
  'autoResumeRateLimit',
  'questionExpiry',
  'questionExpirySeconds',
  'questionExpiredPrompt',
  'harnessSystemPrompt',
  'harnessToolsPrompt',
  'harnessSkills',
  'harnessMemoryEnabled',
] as const satisfies readonly (keyof SharedSettings)[];

/** A refusal a REST caller should see verbatim, with its HTTP status. */
export class SettingsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type BackendId = ProviderBackendId;

/** Server-at-rest format. The identity key is intentionally not in the wire SharedSecrets schema. */
const StoredSecrets = SharedSecrets.extend({
  webBotAuthKey: z.string().min(1).optional(),
}).strict();
type StoredSecrets = z.infer<typeof StoredSecrets>;

function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

function decrypt(key: Buffer, stored: string, path: string): string {
  const parsed = JSON.parse(stored) as { v?: number; iv?: string; tag?: string; data?: string };
  if (parsed.v !== 1 || !parsed.iv || !parsed.tag || !parsed.data) {
    throw new Error(`${path} is not a patch secrets file`);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(`${path} does not decrypt with this server's secrets.key`);
  }
}

function writeAtomic(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, text, mode !== undefined ? { encoding: 'utf8', mode } : 'utf8');
  renameSync(tmp, path);
}

export interface ValidateOpenAIKey {
  (key: string): Promise<{ ok: true } | { ok: false; message: string }>;
}

const validateOpenAIKeyDefault: ValidateOpenAIKey = async (key) => {
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok
      ? { ok: true }
      : { ok: false, message: `OpenAI refused the key (HTTP ${res.status})` };
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach OpenAI to check the key: ${(err as Error).message}`,
    };
  }
};

export interface SharedSettingsOptions {
  dataDir: string;
  /** Send one frame to one host. */
  sendToHost: (hostId: string, event: WireEvent) => void;
  /** Hosts that are connected right now. */
  onlineHostIds: () => string[];
  /** Tell every surface. */
  broadcast: (event: SettingsChangedEvent) => void;
  /** A host's name, for labels made unique on import. */
  hostName?: (hostId: string) => string | undefined;
  validateClaude?: (token: string) => Promise<ClaudeTokenValidation>;
  validateOpenAIKey?: ValidateOpenAIKey;
  adoptTimeoutMs?: number;
  refreshOpenAI?: typeof refreshOpenAI;
  refreshClaude?: typeof refreshClaude;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

interface PendingAdopt {
  hostId: string;
  kind: SettingsAdoptKind;
  resolve: (event: SettingsAdoptResponseEvent) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SharedSettingsService {
  private settings: SharedSettings;
  private secrets: StoredSecrets = structuredClone(EMPTY_SHARED_SECRETS);
  private version = 0;
  private importedHosts = new Set<string>();
  private readonly applied = new Map<string, { version?: number; error?: string }>();
  private readonly pending = new Map<string, PendingAdopt>();
  /** Hosts whose import is in flight, so a reconnect burst asks once. */
  private readonly importing = new Set<string>();
  private readonly settingsPath: string;
  private readonly statePath: string;
  private readonly secretsPath: string;
  private readonly keyPath: string;
  private key: Buffer | undefined;
  /** Why the stored secrets cannot be used, when they cannot (see header). */
  private problem: string | undefined;

  constructor(private readonly opts: SharedSettingsOptions) {
    this.settingsPath = join(opts.dataDir, 'settings.json');
    this.statePath = join(opts.dataDir, 'settings-state.json');
    this.secretsPath = join(opts.dataDir, 'secrets.json');
    this.keyPath = join(opts.dataDir, 'secrets.key');
    this.settings = this.loadSettings();
    if (existsSync(this.statePath)) {
      const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as {
        version?: number;
        importedHosts?: string[];
      };
      this.version = state.version ?? 0;
      this.importedHosts = new Set(state.importedHosts ?? []);
    }
    this.loadSecrets();
    this.provisionWebBotIdentity();
  }

  private provisionWebBotIdentity(): void {
    if (this.problem !== undefined) return;
    let changed = false;
    if (!this.secrets.webBotAuthKey) {
      this.secrets.webBotAuthKey = generateWebBotAuthKey();
      changed = true;
      this.opts.logger?.info('shared settings: created this deployment’s Web Bot Auth identity');
    }
    const key = parseWebBotAuthKey(this.secrets.webBotAuthKey);
    if (this.settings.agentIdentity.name === 'Patch') {
      this.settings.agentIdentity.name = `Patch agent ${key.keyId.slice(0, 8)}`;
      changed = true;
    }
    const oldDescription =
      'A personal AI agent that browses the web only when its user asks it to.';
    if (this.settings.agentIdentity.description === oldDescription) {
      this.settings.agentIdentity.description = DEFAULT_SHARED_SETTINGS.agentIdentity.description;
      changed = true;
    }
    if (changed) {
      this.version += 1;
      this.persist({ secrets: true });
    }
  }

  webBotAuthKey(): string {
    this.requireSecrets();
    const value = this.secrets.webBotAuthKey;
    if (!value)
      throw new SettingsError(503, 'identity_unavailable', 'Web Bot Auth identity is unavailable');
    parseWebBotAuthKey(value);
    return value;
  }

  /**
   * Read the key and the secrets it locks, making a key if this server has
   * never held any secrets. Anything wrong becomes `problem`, never a crash.
   */
  private loadSecrets(): void {
    const hasSecrets = existsSync(this.secretsPath);
    const fix = `Put back the secrets.key that goes with it, or delete ${this.secretsPath} and add the accounts and keys again.`;
    if (!existsSync(this.keyPath)) {
      if (hasSecrets) {
        this.problem = `The stored accounts and keys can't be read: ${this.keyPath} is missing. ${fix}`;
      } else {
        mkdirSync(dirname(this.keyPath), { recursive: true });
        // `wx`: two servers starting on one data dir cannot each write a key.
        try {
          writeFileSync(this.keyPath, randomBytes(32).toString('base64'), {
            mode: 0o600,
            flag: 'wx',
          });
          this.opts.logger?.info(
            { path: this.keyPath },
            'shared settings: made this server’s secrets key',
          );
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
    }
    if (this.problem === undefined) {
      const key = Buffer.from(readFileSync(this.keyPath, 'utf8').trim(), 'base64');
      if (key.length !== 32) {
        this.problem = `The stored accounts and keys can't be read: ${this.keyPath} is not a key. ${fix}`;
      } else {
        this.key = key;
      }
    }
    if (this.key && hasSecrets) {
      try {
        this.secrets = StoredSecrets.parse(
          JSON.parse(decrypt(this.key, readFileSync(this.secretsPath, 'utf8'), this.secretsPath)),
        );
      } catch (err) {
        this.problem = `The stored accounts and keys can't be read: ${(err as Error).message}. ${fix}`;
      }
    }
    if (this.problem) {
      this.opts.logger?.error(
        { problem: this.problem },
        'shared settings: secrets unreadable — nothing is sent to hosts',
      );
    }
  }

  /** Whether settings reach hosts at all: not while the secrets are unreadable. */
  get syncing(): boolean {
    return this.problem === undefined;
  }

  /** Refuse a change to the secrets while they cannot be read or written. */
  private requireSecrets(): void {
    if (this.problem !== undefined)
      throw new SettingsError(503, 'secrets_unreadable', this.problem);
  }

  private loadSettings(): SharedSettings {
    if (!existsSync(this.settingsPath)) return structuredClone(DEFAULT_SHARED_SETTINGS);
    // A file written before a setting existed lacks that key; it gains the
    // default rather than failing the whole read. A key that is present but
    // wrong is a corrupt file, and that stops the server.
    const raw = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Record<string, unknown>;
    // `claudeSettings` was a shared setting once; settings.json is now each
    // host's own file (spec/02 § Claude Code settings), so the retired key is
    // dropped on read and gone from the file at the next write.
    delete raw['claudeSettings'];
    // The Manager redesign (spec/06 § The sweep) retired the stall threshold
    // and changed what the sweep prompt must return. A file that still has the
    // threshold predates it: the sweep goes back to off (its new default) and
    // the old prompt, whose nudge/wake/flag replies the sweep no longer
    // accepts, gives way to the default.
    if ('stalledThresholdMinutes' in raw) {
      delete raw['stalledThresholdMinutes'];
      delete raw['sweepPrompt'];
      raw['sweepEnabled'] = false;
    }
    const parsed = SharedSettings.partial().strict().safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${this.settingsPath} is not valid settings: ${parsed.error.message}`);
    }
    return { ...structuredClone(DEFAULT_SHARED_SETTINGS), ...parsed.data };
  }

  private persist(opts: { secrets: boolean }): void {
    writeAtomic(this.settingsPath, JSON.stringify(this.settings, null, 2));
    writeAtomic(
      this.statePath,
      JSON.stringify({ version: this.version, importedHosts: [...this.importedHosts] }, null, 2),
    );
    if (opts.secrets) {
      if (this.problem !== undefined || !this.key) {
        throw new SettingsError(503, 'secrets_unreadable', this.problem ?? 'No secrets key');
      }
      writeAtomic(this.secretsPath, encrypt(this.key, JSON.stringify(this.secrets)), 0o600);
    }
  }

  // ---- reads ----

  current(): SharedSettings {
    return structuredClone(this.settings);
  }

  currentVersion(): number {
    return this.version;
  }

  secretsSummary(): SharedSecretsSummary {
    return {
      claude: this.secrets.claude.map((a) => ({
        id: a.id,
        label: a.label,
        connected: a.credential !== null,
        ...(a.credential?.email ? { email: a.credential.email } : {}),
        ...(a.credential?.organizationId ? { organizationId: a.credential.organizationId } : {}),
      })),
      codex: this.secrets.codex.map((a) => ({
        id: a.id,
        label: a.label,
        kind: a.kind,
        connected: a.authJson !== null,
        ...(a.email ? { email: a.email } : {}),
      })),
      providerKeys: (['gemini', 'openai', 'groq'] as const).map((id) => {
        const value = this.secrets.providerKeys[id];
        return value ? { id, set: true, last4: value.slice(-4) } : { id, set: false };
      }),
    };
  }

  hostStates(): HostSettingsState[] {
    return [...this.applied.entries()].map(([hostId, s]) => ({
      hostId,
      ...(s.version !== undefined ? { appliedVersion: s.version } : {}),
      ...(s.error ? { error: s.error } : {}),
    }));
  }

  changedEvent(): SettingsChangedEvent {
    return {
      type: 'settings.changed',
      version: this.version,
      settings: this.current(),
      secrets: this.secretsSummary(),
      hosts: this.hostStates(),
      ...((this.problem ?? [...this.renewalErrors.values()].join('; '))
        ? { problem: this.problem ?? [...this.renewalErrors.values()].join('; ') }
        : {}),
    };
  }

  /** Every Claude account id, for checking a spawn's preferred account. */
  accountIds(backendId: BackendId): string[] {
    return this.list(backendId).map((a) => a.id);
  }

  // ---- commit + push ----

  private commit(opts: { secrets: boolean }): void {
    this.version += 1;
    this.persist(opts);
    this.pushAll();
  }

  private renewal: Promise<void> | undefined;
  private renewalTimer: ReturnType<typeof setInterval> | undefined;
  private readonly renewalErrors = new Map<string, string>();

  startCredentialRefresh(): void {
    void this.refreshCredentials();
    this.renewalTimer = setInterval(() => void this.refreshCredentials(), 60_000);
    this.renewalTimer.unref();
  }
  close(): void {
    if (this.renewalTimer) clearInterval(this.renewalTimer);
  }

  refreshCredentials(): Promise<void> {
    if (this.renewal) return this.renewal;
    this.renewal = this.renewCredentials().finally(() => {
      this.renewal = undefined;
    });
    return this.renewal;
  }
  private async renewCredentials(): Promise<void> {
    if (!this.syncing) return;
    for (const account of [...this.secrets.claude, ...this.secrets.codex]) {
      try {
        if ('credential' in account) {
          const before = account.credential;
          if (!before?.refreshToken || !before.expiresAt || before.expiresAt > Date.now() + 300_000)
            continue;
          const next = await (this.opts.refreshClaude ?? refreshClaude)(before.refreshToken);
          if (account.credential !== before || !this.secrets.claude.includes(account)) continue;
          account.credential = { ...before, ...next };
        } else {
          const before = account.authJson;
          if (account.kind !== 'chatgpt' || !before) continue;
          const auth = JSON.parse(before);
          const expiry = tokenExpiry(auth.tokens?.access_token ?? '');
          if (!expiry || expiry > Date.now() + 300_000) continue;
          const next = await (this.opts.refreshOpenAI ?? refreshOpenAI)(before);
          if (account.authJson !== before || !this.secrets.codex.includes(account)) continue;
          account.authJson = next;
        }
        this.renewalErrors.delete(account.id);
        this.commit({ secrets: true });
      } catch (error) {
        this.renewalErrors.set(account.id, `${account.label}: ${(error as Error).message}`);
        this.opts.logger?.warn({ accountId: account.id }, 'Provider sign-in renewal failed');
        this.opts.broadcast(this.changedEvent());
      }
    }
  }

  private snapshotFor(hostId: string): WireEvent {
    const { webBotAuthKey: _serverOnlyIdentity, ...sharedSecrets } = this.secrets;
    return {
      type: 'settings.snapshot',
      hostId,
      version: this.version,
      settings: this.current(),
      secrets: hostSecrets(sharedSecrets),
    };
  }

  private pushAll(): void {
    if (this.syncing) {
      for (const hostId of this.opts.onlineHostIds()) {
        // A host still being imported gets the snapshot when its import lands:
        // sending one first would overwrite the very accounts it is about to send.
        if (!this.importedHosts.has(hostId)) continue;
        this.opts.sendToHost(hostId, this.snapshotFor(hostId));
      }
    }
    this.opts.broadcast(this.changedEvent());
  }

  /**
   * A host connected. Import what it held before settings were shared, once;
   * then send it the snapshot.
   */
  hostOnline(hostId: string): void {
    if (!this.syncing) return;
    if (this.importedHosts.has(hostId)) {
      this.opts.sendToHost(hostId, this.snapshotFor(hostId));
      return;
    }
    if (this.importing.has(hostId)) return;
    this.importing.add(hostId);
    void this.adopt(hostId, 'import')
      .then((result) => {
        if (result.kind !== 'import') throw new Error(`import answered with ${result.kind}`);
        this.mergeImport(hostId, result.import);
      })
      .catch((err: Error) => {
        // Not marked imported, so the next connect asks again rather than the
        // host being overwritten with a snapshot that never saw its accounts.
        this.opts.logger?.error(
          { hostId, err: err.message },
          'shared settings: import from host failed — it keeps its own settings until one succeeds',
        );
        this.applied.set(hostId, { error: `import failed: ${err.message}` });
        this.opts.broadcast(this.changedEvent());
      })
      .finally(() => this.importing.delete(hostId));
  }

  hostOffline(hostId: string): void {
    for (const [requestId, p] of this.pending) {
      if (p.hostId !== hostId) continue;
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      p.reject(new Error(`${hostId} went offline`));
    }
  }

  /** Fold one host's pre-sharing settings and secrets in (spec/01 § Settings). */
  mergeImport(hostId: string, imported: SettingsImport): void {
    this.requireSecrets();
    const host = this.opts.hostName?.(hostId) ?? hostId;
    const first = this.importedHosts.size === 0;
    if (first) {
      const patch: Record<string, unknown> = {};
      for (const key of HOST_HELD_KEYS) {
        const value = imported.settings[key];
        if (value !== undefined) patch[key] = value;
      }
      this.settings = {
        ...this.settings,
        ...(SharedSettingsPatch.parse(patch) as SharedSettingsPatch),
      };
    }
    const added: string[] = [];
    const skipped: string[] = [];
    for (const account of imported.secrets.claude) {
      if (!account.credential) continue;
      const clash = this.secrets.claude.find(
        (a) =>
          a.credential &&
          (a.credential.accessToken === account.credential!.accessToken ||
            (account.credential!.organizationId !== undefined &&
              a.credential.organizationId === account.credential!.organizationId)),
      );
      if (clash) {
        skipped.push(`${account.label} (same Claude account as ${clash.label})`);
        continue;
      }
      this.secrets.claude.push(this.uniqueClaude(account, host));
      added.push(`Claude ${account.label}`);
    }
    for (const account of imported.secrets.codex) {
      if (!account.authJson) continue;
      const clash = this.secrets.codex.find(
        (a) => account.identity !== undefined && a.identity === account.identity,
      );
      if (clash) {
        skipped.push(`${account.label} (same OpenAI login as ${clash.label})`);
        continue;
      }
      const idTaken = this.secrets.codex.some((a) => a.id === account.id);
      this.secrets.codex.push({ ...account, ...(idTaken ? { id: randomUUID() } : {}) });
      added.push(`OpenAI ${account.label}`);
    }
    for (const id of ['gemini', 'openai', 'groq'] as const) {
      const value = imported.secrets.providerKeys[id];
      if (value && !this.secrets.providerKeys[id]) {
        this.secrets.providerKeys[id] = value;
        added.push(`${id} key`);
      }
    }
    this.importedHosts.add(hostId);
    this.opts.logger?.info(
      { hostId, host, first, added, skipped },
      'shared settings: imported a host',
    );
    this.commit({ secrets: true });
  }

  private uniqueClaude(account: SharedClaudeAccount, host: string): SharedClaudeAccount {
    const idTaken = this.secrets.claude.some((a) => a.id === account.id);
    const labelTaken = this.secrets.claude.some((a) => a.label === account.label);
    return {
      ...account,
      ...(idTaken ? { id: randomUUID() } : {}),
      ...(labelTaken ? { label: `${account.label} (${host})` } : {}),
    };
  }

  // ---- host frames ----

  handleHostEvent(event: WireEvent): void {
    switch (event.type) {
      case 'settings.applied':
        this.applied.set(event.hostId, {
          version: event.version,
          ...(event.error ? { error: event.error } : {}),
        });
        if (event.error) {
          this.opts.logger?.warn(
            { hostId: event.hostId, version: event.version, err: event.error },
            'shared settings: a host could not apply the snapshot',
          );
        }
        this.opts.broadcast(this.changedEvent());
        return;
      case 'settings.adopt.response': {
        const p = this.pending.get(event.requestId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(event.requestId);
        p.resolve(event);
        return;
      }
      case 'settings.secret_update':
        this.secretUpdate(event.hostId, event.update);
        return;
      case 'settings.account_signed_in':
        this.addCodexAccount(
          event.account,
          `signed in on ${this.opts.hostName?.(event.hostId) ?? event.hostId}`,
        );
        return;
      default:
        return;
    }
  }

  private secretUpdate(
    hostId: string,
    update: Extract<WireEvent, { type: 'settings.secret_update' }>['update'],
  ): void {
    this.opts.logger?.warn(
      { hostId, accountId: update.accountId },
      'Host credential update ignored: provider refresh is owned by the server',
    );
  }

  /** Ask a host to send a value up (spec/01 § Settings). */
  async adopt(
    hostId: string,
    kind: SettingsAdoptKind,
    id?: string,
  ): Promise<NonNullable<SettingsAdoptResponseEvent['result']>> {
    if (!this.opts.onlineHostIds().includes(hostId)) {
      throw new SettingsError(
        409,
        'host_offline',
        `${this.opts.hostName?.(hostId) ?? hostId} is offline`,
      );
    }
    const requestId = randomUUID();
    const response = await new Promise<SettingsAdoptResponseEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new SettingsError(
            504,
            'daemon_timeout',
            `${this.opts.hostName?.(hostId) ?? hostId} did not answer`,
          ),
        );
      }, this.opts.adoptTimeoutMs ?? 20_000);
      this.pending.set(requestId, { hostId, kind, resolve, reject, timer });
      this.opts.sendToHost(hostId, {
        type: 'settings.adopt.request',
        requestId,
        hostId,
        kind,
        ...(id !== undefined ? { id } : {}),
      });
    });
    if (!response.ok || !response.result) {
      throw new SettingsError(
        409,
        'nothing_to_adopt',
        response.error ?? `${kind}: the host sent nothing`,
      );
    }
    return response.result;
  }

  /** Adopt a value from a host and store it as the shared one. */
  async adoptInto(
    hostId: string,
    kind: Exclude<SettingsAdoptKind, 'import' | 'codex-signin'>,
    id?: string,
  ): Promise<void> {
    const result = await this.adopt(hostId, kind, id);
    switch (result.kind) {
      case 'claude-login':
        await this.addClaudeCredential(result.account.credential!, result.account.label);
        return;
      case 'codex-login':
      case 'codex-signin':
        this.addCodexAccount(result.account, 'adopted');
        return;
      case 'provider-key':
        this.setProviderKey(result.id, result.value);
        return;
      default:
        throw new Error(`unexpected adopt result ${(result as { kind: string }).kind}`);
    }
  }

  // ---- surface writes ----

  /** Takes the patch's input shape: it is parsed here, which fills in a field's default. */
  update(patch: z.input<typeof SharedSettingsPatch>): SharedSettings {
    const parsed = SharedSettingsPatch.safeParse(patch);
    if (!parsed.success) throw new SettingsError(400, 'invalid_input', parsed.error.message);
    for (const [id, mode] of Object.entries(parsed.data.providerPermissionDefaults ?? {})) {
      const modes = (HARNESS_PERMISSION_MODES as Record<string, readonly string[]>)[id];
      if (!modes) throw new SettingsError(400, 'invalid_input', `unknown provider: ${id}`);
      if (!modes.includes(mode)) {
        throw new SettingsError(400, 'invalid_input', `${id} cannot run permission mode ${mode}`);
      }
    }
    this.settings = { ...this.settings, ...parsed.data };
    this.commit({ secrets: false });
    return this.current();
  }

  setStrategy(backendId: BackendId, strategy: AccountStrategy): void {
    const key = accountsKeyForBackend(backendId);
    this.update({ accountStrategy: { ...this.settings.accountStrategy, [key]: strategy } });
  }

  private async validatedClaude(token: string): Promise<{ organizationId?: string }> {
    const result = await (this.opts.validateClaude ?? validateClaudeOAuthToken)(token);
    if (result.kind === 'rejected')
      throw new SettingsError(400, 'credential_rejected', result.message);
    if (result.kind === 'unreachable')
      throw new SettingsError(502, 'credential_unreachable', result.message);
    return result.organizationId ? { organizationId: result.organizationId } : {};
  }

  private claudeClash(
    organizationId: string | undefined,
    exceptId?: string,
  ): SharedClaudeAccount | undefined {
    if (organizationId === undefined) return undefined;
    return this.secrets.claude.find(
      (a) => a.id !== exceptId && a.credential?.organizationId === organizationId,
    );
  }

  /** Add a Claude account from a pasted token (spec/10 § Backend credentials). */
  async addClaude(token: string, label?: string): Promise<SharedClaudeAccount> {
    return this.addClaudeCredential({ accessToken: token.trim() }, label);
  }

  private async addClaudeCredential(
    credential: ClaudeCredential,
    label?: string,
  ): Promise<SharedClaudeAccount> {
    this.requireSecrets();
    const { organizationId } = await this.validatedClaude(credential.accessToken);
    const clash = this.claudeClash(organizationId);
    if (clash) {
      throw new SettingsError(
        409,
        'duplicate_account',
        `This token is the same Claude account as ${clash.label}`,
      );
    }
    const account: SharedClaudeAccount = {
      id: randomUUID(),
      label: label?.trim() || credential.email || `Claude ${this.secrets.claude.length + 1}`,
      credential: { ...credential, ...(organizationId ? { organizationId } : {}) },
    };
    this.secrets.claude.push(account);
    this.commit({ secrets: true });
    return account;
  }

  async connectClaude(accountId: string, token: string): Promise<void> {
    this.requireSecrets();
    const account = this.secrets.claude.find((a) => a.id === accountId);
    if (!account)
      throw new SettingsError(404, 'account_not_found', `No Claude account ${accountId}`);
    const { organizationId } = await this.validatedClaude(token.trim());
    const clash = this.claudeClash(organizationId, accountId);
    if (clash) {
      throw new SettingsError(
        409,
        'duplicate_account',
        `This token is the same Claude account as ${clash.label}`,
      );
    }
    account.credential = {
      accessToken: token.trim(),
      ...(organizationId ? { organizationId } : {}),
    };
    this.commit({ secrets: true });
  }

  /** Add a Codex account with an OpenAI API key. */
  async addCodexApiKey(key: string, label?: string): Promise<SharedCodexAccount> {
    this.requireSecrets();
    const trimmed = key.trim();
    const check = await (this.opts.validateOpenAIKey ?? validateOpenAIKeyDefault)(trimmed);
    if (!check.ok) throw new SettingsError(400, 'credential_rejected', check.message);
    return this.addCodexAccount(
      {
        id: randomUUID(),
        label: label?.trim() || 'OpenAI API (paid)',
        kind: 'apiKey',
        authJson: JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: trimmed }),
      },
      'API key',
    );
  }

  private addCodexAccount(account: SharedCodexAccount, how: string): SharedCodexAccount {
    this.requireSecrets();
    const clash = this.secrets.codex.find(
      (a) => account.identity !== undefined && a.identity === account.identity,
    );
    if (clash) {
      Object.assign(clash, account, { id: clash.id, label: clash.label });
      this.renewalErrors.delete(clash.id);
      this.commit({ secrets: true });
      return clash;
    }
    const stored = this.secrets.codex.some((a) => a.id === account.id)
      ? { ...account, id: randomUUID() }
      : account;
    this.secrets.codex.push(stored);
    this.opts.logger?.info({ accountId: stored.id, how }, 'shared settings: Codex account added');
    this.commit({ secrets: true });
    return stored;
  }

  private list(backendId: BackendId): (SharedClaudeAccount | SharedCodexAccount)[] {
    return this.secrets[accountsKeyForBackend(backendId)];
  }

  private find(backendId: BackendId, accountId: string): SharedClaudeAccount | SharedCodexAccount {
    const account = this.list(backendId).find((a) => a.id === accountId);
    if (!account)
      throw new SettingsError(404, 'account_not_found', `No ${backendId} account ${accountId}`);
    return account;
  }

  disconnect(backendId: BackendId, accountId: string): void {
    this.requireSecrets();
    const account = this.find(backendId, accountId);
    if ('credential' in account) account.credential = null;
    else account.authJson = null;
    this.commit({ secrets: true });
  }

  relabel(backendId: BackendId, accountId: string, label: string): void {
    this.requireSecrets();
    if (!label.trim()) throw new SettingsError(400, 'invalid_input', 'A label cannot be empty');
    this.find(backendId, accountId).label = label.trim();
    this.commit({ secrets: true });
  }

  remove(backendId: BackendId, accountId: string): void {
    this.requireSecrets();
    this.find(backendId, accountId);
    const key = accountsKeyForBackend(backendId);
    this.secrets[key] = this.secrets[key].filter((a) => a.id !== accountId) as never;
    this.commit({ secrets: true });
  }

  /** The order IS the priority; it must name each account exactly once. */
  order(backendId: BackendId, accountIds: string[]): void {
    this.requireSecrets();
    const held = this.list(backendId).map((a) => a.id);
    const unknown = accountIds.filter((id) => !held.includes(id));
    const missing = held.filter((id) => !accountIds.includes(id));
    if (unknown.length || missing.length || new Set(accountIds).size !== accountIds.length) {
      throw new SettingsError(
        400,
        'invalid_order',
        `The order must name each account exactly once (holds: ${held.join(', ') || 'none'})`,
      );
    }
    const key = accountsKeyForBackend(backendId);
    const held$ = this.secrets[key] as { id: string }[];
    this.secrets[key] = accountIds.map((id) => held$.find((a) => a.id === id)!) as never;
    this.commit({ secrets: true });
  }

  setProviderKey(id: ProviderKeyId, value: string): void {
    this.requireSecrets();
    const trimmed = value.trim();
    if (trimmed.length < PROVIDER_KEY_MIN_LENGTH || /\s/.test(trimmed)) {
      throw new SettingsError(
        400,
        'invalid_value',
        `A key must be at least ${PROVIDER_KEY_MIN_LENGTH} characters with no whitespace`,
      );
    }
    this.secrets.providerKeys[id] = trimmed;
    this.commit({ secrets: true });
  }

  revokeProviderKey(id: ProviderKeyId): void {
    this.requireSecrets();
    if (!this.secrets.providerKeys[id]) {
      throw new SettingsError(404, 'not_set', `No ${id} key is set from Settings`);
    }
    delete this.secrets.providerKeys[id];
    this.commit({ secrets: true });
  }
}
