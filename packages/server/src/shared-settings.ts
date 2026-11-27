import { z } from 'zod';
import { hostSecrets, tokenExpiry, refreshOpenAI, refreshClaude } from './provider-refresh.js';
// Shared settings (spec/01 § Settings).
//
// The server is the source of truth for every setting that is not tied to one
// host — backend accounts, provider keys, agent behaviour, voice — and every host runs from the copy in the
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
  MIGRATED_LOCAL_ENDPOINT_ID,
  PROVIDER_KEYS,
  type ProviderKeyCheck,
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
  type AccountState,
  type WireEvent,
  accountsKeyForBackend,
  isAnthropicApiKey,
  type ProviderBackendId,
  limitBehaviourFromAutoResume,
  managerWakeFromSweep,
  sweepFieldsForManagerWake,
  DEFAULT_SWEEP_PROMPT,
  ownSettingsGroups,
  invalidOwnSettingValue,
  resolveAcpAgents,
  type AcpAgentConfig,
  type SharedAcpAccount,
  type AwsProfileInfo,
  type BedrockRegionPrefix,
  type ClaudeBedrock,
  type PatchAwsProfileCheckResponseEvent,
  BACKGROUND_ACCOUNT_AUTO,
  bedrockAtCap,
  bedrockCapResetsAt,
  bedrockMonth,
  BEDROCK_SPEND_IDS_KEPT,
} from '@patch/wire';
import { generateWebBotAuthKey, parseWebBotAuthKey } from '@patch/wire/web-bot-auth';
import { AccountStateTracker } from './account-states.js';
import { checkProviderKey, type FetchLike } from './provider-key-check.js';
import { validateClaudeOAuthToken, type ClaudeTokenValidation } from '@patch/auth';

/** Settings keys a host held before they were shared — taken from the FIRST host imported. */
const HOST_HELD_KEYS = [
  'kokoroVoice',
  'ttsBackend',
  'elevenLabsVoice',
  'elevenLabsModel',
  'permissionModeDefault',
  'chatNameInterval',
  'titleGenerationEnabled',
  'statusGenerationEnabled',
  'autoResumeRateLimit',
  'limitBehaviour',
  'questionExpiry',
  'questionExpirySeconds',
  'questionExpiredPrompt',
  'harnessSystemPrompt',
  'harnessToolsPrompt',
  'harnessSkills',
  'harnessMemoryEnabled',
] as const satisfies readonly (keyof SharedSettings)[];

/**
 * Keep the retired `autoResumeRateLimit` in step with `limitBehaviour`
 * (spec/10 § When an account hits a limit). A write of the new setting sets the
 * old one for hosts and surfaces that still read it; a write of ONLY the old
 * one, from a client older than the new setting, is read as the behaviour it
 * meant. A write naming both is taken at `limitBehaviour`'s word.
 */
export function limitBehaviourInStep<T extends Partial<SharedSettings>>(patch: T): T {
  if (patch.limitBehaviour !== undefined) {
    return { ...patch, autoResumeRateLimit: patch.limitBehaviour !== 'switch_provider' };
  }
  if (patch.autoResumeRateLimit !== undefined) {
    return { ...patch, limitBehaviour: limitBehaviourFromAutoResume(patch.autoResumeRateLimit) };
  }
  return patch;
}

/**
 * `managerWake` and the retired sweep pair kept in step (spec/06 § Finished
 * chats): a write of either side gains the other, so an older host or
 * surface still reads and writes what it knows.
 */
export function managerWakeInStep<T extends Partial<SharedSettings>>(
  patch: T,
  current: Pick<
    SharedSettings,
    'managerWake' | 'managerWakeIntervalMinutes' | 'sweepEnabled' | 'sweepIntervalMinutes'
  >,
): T {
  if (patch.managerWake !== undefined || patch.managerWakeIntervalMinutes !== undefined) {
    return {
      ...patch,
      ...sweepFieldsForManagerWake(
        patch.managerWake ?? current.managerWake,
        patch.managerWakeIntervalMinutes ?? current.managerWakeIntervalMinutes,
      ),
    };
  }
  if (patch.sweepEnabled !== undefined || patch.sweepIntervalMinutes !== undefined) {
    return {
      ...patch,
      ...managerWakeFromSweep(
        patch.sweepEnabled ?? current.sweepEnabled,
        patch.sweepIntervalMinutes ?? current.sweepIntervalMinutes,
      ),
    };
  }
  return patch;
}

/** `''` (the default folder) or an absolute path, POSIX or Windows. */
function isManagerFolder(folder: string): boolean {
  return folder === '' || /^(\/|[A-Za-z]:[\\/])/.test(folder);
}

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
  /** The HTTP client the provider-key checks use (tests inject one). */
  keyCheckFetch?: FetchLike;
  adoptTimeoutMs?: number;
  refreshOpenAI?: typeof refreshOpenAI;
  refreshClaude?: typeof refreshClaude;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** The clock account states are derived against (tests). */
  now?: () => number;
  /** How long a host has to answer an AWS profile check (tests shorten it). */
  profileCheckTimeoutMs?: number;
}

/** A new Claude on Amazon Bedrock account, as Settings sends it (spec/10 § Signing in). */
export interface BedrockAccountInput {
  label: string;
  hostId: string;
  awsProfile: string;
  awsRegion: string;
  regionPrefix: BedrockRegionPrefix;
  monthlyCapUsd: number;
  auto?: boolean | undefined;
}

/** A change to a Claude account's row: `auto` on any, the rest on a Bedrock account only. */
export interface ClaudeAccountEdit {
  auto?: boolean | undefined;
  hostId?: string | undefined;
  awsProfile?: string | undefined;
  awsRegion?: string | undefined;
  regionPrefix?: BedrockRegionPrefix | undefined;
  monthlyCapUsd?: number | undefined;
}

/** How a Bedrock account a host reports signed out reads (spec/10 § Settings). */
export const AWS_SIGNED_OUT_MESSAGE = 'AWS sign-in expired';

interface PendingAdopt {
  hostId: string;
  kind: SettingsAdoptKind;
  resolve: (event: SettingsAdoptResponseEvent) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How often saved provider keys are checked again. */
const KEY_RECHECK_MS = 60 * 60_000;

/** A Bedrock account as surfaces see it: the applied spend ids are for its host only. */
function withoutSpendIds({ spendIds: _forHost, ...bedrock }: ClaudeBedrock): ClaudeBedrock {
  return bedrock;
}

export class SharedSettingsService {
  private settings: SharedSettings;
  private secrets: StoredSecrets = structuredClone(EMPTY_SHARED_SECRETS);
  private version = 0;
  private importedHosts = new Set<string>();
  /** Hosts whose provider keys (settings and environment) are in the account's store. */
  private keysImportedHosts = new Set<string>();
  private readonly applied = new Map<string, { version?: number; error?: string }>();
  private readonly pending = new Map<string, PendingAdopt>();
  /** Hosts whose import is in flight, so a reconnect burst asks once. */
  private readonly importing = new Set<string>();
  private readonly settingsPath: string;
  private readonly statePath: string;
  private readonly secretsPath: string;
  private readonly keyPath: string;
  private key: Buffer | undefined;
  /** The one state per account (spec/10 § Account states). */
  private readonly accountStates: AccountStateTracker;
  /** States as last sent, to tell surfaces only when one changed. */
  private sentStates = new Map<string, string>();
  /** Why the stored secrets cannot be used, when they cannot (see header). */
  private problem: string | undefined;
  /**
   * Each host's AWS profiles from its latest `host.host`; a host is here only
   * when it reported them, which is what says it runs Bedrock accounts.
   */
  private readonly awsProfiles = new Map<string, AwsProfileInfo[]>();
  /**
   * Hosts that run Bedrock accounts: added when a host reports `awsProfiles`,
   * removed only when it reports `host.host` without them. Persisted, so the
   * first snapshot after a restart, which may go out before the host's
   * `host.host`, still carries the host's own Bedrock accounts.
   */
  private bedrockHosts = new Set<string>();
  /**
   * Bedrock accounts whose host last said their profile is not signed in. In
   * memory: the host restates it on connect and every check after.
   */
  private readonly bedrockSignedOut = new Set<string>();
  private readonly profileChecks = new Map<
    string,
    {
      hostId: string;
      resolve: (e: PatchAwsProfileCheckResponseEvent) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

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
        keysImportedHosts?: string[];
        bedrockHosts?: string[];
      };
      this.version = state.version ?? 0;
      this.bedrockHosts = new Set(state.bedrockHosts ?? []);
      this.importedHosts = new Set(state.importedHosts ?? []);
      this.keysImportedHosts = new Set(state.keysImportedHosts ?? []);
    }
    this.accountStates = new AccountStateTracker({
      path: join(opts.dataDir, 'account-states.json'),
      logger: opts.logger,
      ...(opts.now ? { now: opts.now } : {}),
      onChange: () => this.accountStatesChanged(),
    });
    this.loadSecrets();
    this.provisionWebBotIdentity();
    this.sentStates = this.stateKeys();
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
    // An earlier Manager redesign retired the stall threshold
    // and changed what the sweep prompt must return. A file that still has the
    // threshold predates it: the sweep goes back to off (its new default) and
    // the old prompt, whose nudge/wake/flag replies the sweep no longer
    // accepts, gives way to the default.
    if ('stalledThresholdMinutes' in raw) {
      delete raw['stalledThresholdMinutes'];
      delete raw['sweepPrompt'];
      raw['sweepEnabled'] = false;
    }
    // Local models were one OpenAI-compatible URL run on Patch's own agent
    // loop. They are now model endpoints run through Codex (spec/02 § Provider
    // adapters): the URL becomes the endpoint retired chats are offered to
    // continue on, and the old key is gone from the file at the next write.
    if ('localModelBaseUrl' in raw) {
      const url = raw['localModelBaseUrl'];
      delete raw['localModelBaseUrl'];
      if (typeof url === 'string' && url !== '' && raw['modelEndpoints'] === undefined) {
        raw['modelEndpoints'] = [
          { id: MIGRATED_LOCAL_ENDPOINT_ID, label: 'Local model', api: 'openai', baseUrl: url },
        ];
      }
    }
    // Finished chats replaced the sweep (spec/06 § Finished chats). A file
    // from before it gains the `managerWake` its sweep switch and interval
    // meant, and a customised standing-instructions prompt becomes the
    // Manager prompt so nothing written is lost.
    if (!('managerWake' in raw) && typeof raw['sweepEnabled'] === 'boolean') {
      Object.assign(
        raw,
        managerWakeFromSweep(
          raw['sweepEnabled'],
          typeof raw['sweepIntervalMinutes'] === 'number' ? raw['sweepIntervalMinutes'] : 30,
        ),
      );
    }
    if (
      !('managerPrompt' in raw) &&
      typeof raw['sweepPrompt'] === 'string' &&
      raw['sweepPrompt'].trim() !== '' &&
      raw['sweepPrompt'] !== DEFAULT_SWEEP_PROMPT
    ) {
      raw['managerPrompt'] = raw['sweepPrompt'];
    }
    const parsed = SharedSettings.partial().strict().safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${this.settingsPath} is not valid settings: ${parsed.error.message}`);
    }
    // A file from before `limitBehaviour` gains the behaviour its
    // `autoResumeRateLimit` meant, so nobody's limits behave differently on
    // upgrade (spec/10 § When an account hits a limit).
    return { ...structuredClone(DEFAULT_SHARED_SETTINGS), ...limitBehaviourInStep(parsed.data) };
  }

  private persist(opts: { secrets: boolean }): void {
    writeAtomic(this.settingsPath, JSON.stringify(this.settings, null, 2));
    writeAtomic(
      this.statePath,
      JSON.stringify(
        {
          version: this.version,
          importedHosts: [...this.importedHosts],
          keysImportedHosts: [...this.keysImportedHosts],
          bedrockHosts: [...this.bedrockHosts],
        },
        null,
        2,
      ),
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
        // A Bedrock account holds no credential; it is connected while its profile is signed in.
        connected: a.bedrock ? !this.bedrockSignedOut.has(a.id) : a.credential !== null,
        ...(a.credential?.email ? { email: a.credential.email } : {}),
        ...(a.credential && isAnthropicApiKey(a.credential.accessToken)
          ? { kind: 'apiKey' as const }
          : {}),
        ...(a.credential?.organizationId ? { organizationId: a.credential.organizationId } : {}),
        state: this.stateOf(a),
        ...(a.auto !== undefined ? { auto: a.auto } : {}),
        ...(a.bedrock ? { bedrock: withoutSpendIds(a.bedrock) } : {}),
      })),
      codex: this.secrets.codex.map((a) => ({
        id: a.id,
        label: a.label,
        kind: a.kind,
        connected: a.authJson !== null,
        ...(a.email ? { email: a.email } : {}),
        state: this.stateOf(a),
      })),
      providerKeys: PROVIDER_KEYS.map(({ id }) => {
        const value = this.secrets.providerKeys[id];
        if (!value) return { id, set: false };
        const check = this.keyChecks.get(id);
        return { id, set: true, last4: value.slice(-4), ...(check ? { check } : {}) };
      }),
      ...(this.secrets.acp
        ? {
            acp: this.secrets.acp.map((a) => ({
              id: a.id,
              agentId: a.agentId,
              label: a.label,
              ...(a.apiKey.length >= PROVIDER_KEY_MIN_LENGTH ? { last4: a.apiKey.slice(-4) } : {}),
              state: this.acpStateOf(a),
            })),
          }
        : {}),
      ...(this.secrets.endpointKeys
        ? {
            endpointKeys: Object.entries(this.secrets.endpointKeys).map(([id, value]) => ({
              id,
              ...(value.length >= PROVIDER_KEY_MIN_LENGTH ? { last4: value.slice(-4) } : {}),
            })),
          }
        : {}),
    };
  }

  private problemText(): string {
    if (this.problem !== undefined) return this.problem;
    return [...this.renewalErrors]
      .map(([id, message]) => {
        const label = [...this.secrets.claude, ...this.secrets.codex].find(
          (a) => a.id === id,
        )?.label;
        return `${label ?? id}: ${message}`;
      })
      .join('; ');
  }

  private stateOf(a: SharedClaudeAccount | SharedCodexAccount): AccountState {
    if ('bedrock' in a && a.bedrock) return this.bedrockStateOf(a.id, a.bedrock);
    const hasCredential = 'credential' in a ? a.credential !== null : a.authJson !== null;
    const apiKey =
      'credential' in a
        ? a.credential !== null && isAnthropicApiKey(a.credential.accessToken)
        : a.kind === 'apiKey';
    const renewalError = this.renewalErrors.get(a.id);
    return this.accountStates.stateFor(a.id, {
      hasCredential,
      renewalError,
      apiKey,
    });
  }

  /**
   * A Bedrock account's state (spec/10 § Spending caps): signed out when its
   * host says the profile is, limited until the first of next month (UTC) once
   * the month's spend reaches the cap, otherwise what its host reported.
   */
  private bedrockStateOf(id: string, bedrock: ClaudeBedrock): AccountState {
    const reported = this.accountStates.stateFor(id, {
      hasCredential: !this.bedrockSignedOut.has(id),
      // Like an API key it has no subscription windows: no reading is about it.
      apiKey: true,
    });
    if (reported.state === 'signed_out' || reported.state === 'out') return reported;
    const now = (this.opts.now ?? Date.now)();
    if (bedrockAtCap(bedrock, now)) return { state: 'limited', until: bedrockCapResetsAt(now) };
    return reported;
  }

  /**
   * An ACP account's state, from what its agent said on each host (decision
   * 24): a refused key or missing sign-in is signed out, a limit is limited.
   * ACP carries no usage windows; the host reports a turn the agent completed
   * on the account as a reading taken then, which is what shows credit again
   * after a limit that stated no reset.
   */
  private acpStateOf(a: SharedAcpAccount): AccountState {
    return this.accountStates.stateFor(a.id, { hasCredential: true });
  }

  private stateKeys(): Map<string, string> {
    const out = new Map<string, string>();
    for (const a of [...this.secrets.claude, ...this.secrets.codex]) {
      out.set(a.id, JSON.stringify(this.stateOf(a)));
    }
    for (const a of this.secrets.acp ?? []) out.set(a.id, JSON.stringify(this.acpStateOf(a)));
    return out;
  }

  /** The state of one account, or undefined for an id the server does not hold. */
  accountState(accountId: string): AccountState | undefined {
    const account = [...this.secrets.claude, ...this.secrets.codex].find((a) => a.id === accountId);
    if (account) return this.stateOf(account);
    const acp = (this.secrets.acp ?? []).find((a) => a.id === accountId);
    if (acp) return this.acpStateOf(acp);
    // An ACP agent's own sign-in on one host: the server holds no credential
    // for it, and its state is what that host reported (decision 24).
    if (accountId.startsWith('acp-login:')) {
      return this.accountStates.stateFor(accountId, { hasCredential: true });
    }
    return undefined;
  }

  private readonly accountStateListeners = new Set<() => void>();

  /** Hear when a fact behind any account's state moved, so what rests on it is worked out again. */
  onAccountStates(listener: () => void): () => void {
    this.accountStateListeners.add(listener);
    return () => this.accountStateListeners.delete(listener);
  }

  /** A fact behind an account's state moved: tell surfaces if a state actually changed. */
  private accountStatesChanged(): void {
    const next = this.stateKeys();
    const same =
      next.size === this.sentStates.size &&
      [...next].every(([id, state]) => this.sentStates.get(id) === state);
    this.sentStates = next;
    if (!same) this.opts.broadcast(this.changedEvent());
    for (const listener of this.accountStateListeners) {
      try {
        listener();
      } catch (err) {
        this.opts.logger?.error({ err }, 'shared settings: an account state listener threw');
      }
    }
  }

  hostStates(): HostSettingsState[] {
    return [...this.applied.entries()].map(([hostId, s]) => ({
      hostId,
      ...(s.version !== undefined ? { appliedVersion: s.version } : {}),
      ...(s.error ? { error: s.error } : {}),
    }));
  }

  changedEvent(): SettingsChangedEvent {
    this.sentStates = this.stateKeys();
    return {
      type: 'settings.changed',
      version: this.version,
      settings: this.current(),
      secrets: this.secretsSummary(),
      hosts: this.hostStates(),
      ...(this.problemText() ? { problem: this.problemText() } : {}),
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

  /** Latest live check of each saved key, in memory: rerun at start and hourly. */
  private readonly keyChecks = new Map<ProviderKeyId, ProviderKeyCheck>();
  private keyCheckTimer: ReturnType<typeof setInterval> | undefined;

  startCredentialRefresh(): void {
    void this.refreshCredentials();
    this.renewalTimer = setInterval(() => {
      void this.refreshCredentials();
      // A stated reset passing changes an account's state with no new fact.
      this.accountStatesChanged();
    }, 60_000);
    this.renewalTimer.unref();
    void this.recheckProviderKeys();
    this.keyCheckTimer = setInterval(() => void this.recheckProviderKeys(), KEY_RECHECK_MS);
    this.keyCheckTimer.unref();
  }
  close(): void {
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    if (this.keyCheckTimer) clearInterval(this.keyCheckTimer);
  }

  /**
   * Ask the provider whether the saved `id` key works and what it can power,
   * keep the answer and tell every surface. Returns null when no key is saved.
   * An unreachable provider says nothing about the key, so it never replaces a
   * previous verdict on it; the first check of a key records it either way.
   */
  async checkProviderKey(id: ProviderKeyId): Promise<ProviderKeyCheck | null> {
    const value = this.secrets.providerKeys[id];
    if (!value) return null;
    const check = await checkProviderKey(id, value, this.opts.keyCheckFetch);
    // Replaced or revoked while the request was out: the answer is for a key that is gone.
    if (this.secrets.providerKeys[id] !== value) return null;
    const before = this.keyChecks.get(id);
    if (check.status === 'unreachable' && before && before.status !== 'unreachable') {
      this.opts.logger?.warn({ id }, 'Provider key check could not reach the provider');
      return before;
    }
    this.keyChecks.set(id, check);
    if (before?.status !== check.status || before?.message !== check.message) {
      if (check.status === 'rejected' || check.status === 'limited') {
        this.opts.logger?.warn({ id, status: check.status }, 'Provider key check failed');
      }
    }
    this.opts.broadcast(this.changedEvent());
    return check;
  }

  /** Recheck every saved key, so a revoked or expired one is flagged. */
  async recheckProviderKeys(): Promise<void> {
    for (const { id } of PROVIDER_KEYS) await this.checkProviderKey(id);
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
        this.renewalErrors.set(account.id, (error as Error).message);
        this.opts.logger?.warn({ accountId: account.id }, 'Provider sign-in renewal failed');
        this.sentStates = this.stateKeys();
        this.opts.broadcast(this.changedEvent());
      }
    }
  }

  private snapshotFor(hostId: string): WireEvent {
    const { webBotAuthKey: _serverOnlyIdentity, ...sharedSecrets } = this.secrets;
    // A Bedrock account runs on its own host only, and only on a host that
    // says it can run one; no other host ever sees it (spec/10 § Backend credentials).
    const capable = this.bedrockHosts.has(hostId);
    const forHost = {
      ...sharedSecrets,
      claude: sharedSecrets.claude.filter(
        (a) => !a.bedrock || (capable && a.bedrock.hostId === hostId),
      ),
    };
    const elsewhere = sharedSecrets.claude.filter((a) => !forHost.claude.includes(a));
    return {
      type: 'settings.snapshot',
      hostId,
      version: this.version,
      settings: this.current(),
      secrets: hostSecrets(forHost),
      ...(elsewhere.length > 0
        ? { claudeHeldElsewhere: elsewhere.map((a) => ({ id: a.id, label: a.label })) }
        : {}),
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
    if (this.importedHosts.has(hostId) && this.keysImportedHosts.has(hostId)) {
      this.opts.sendToHost(hostId, this.snapshotFor(hostId));
      return;
    }
    if (this.importing.has(hostId)) return;
    this.importing.add(hostId);
    // A host imported before environment keys counted comes back once for them.
    const keysOnly = this.importedHosts.has(hostId);
    void this.adopt(hostId, 'import')
      .then((result) => {
        if (result.kind !== 'import') throw new Error(`import answered with ${result.kind}`);
        if (keysOnly) this.mergeKeysOnly(hostId, result.import);
        else this.mergeImport(hostId, result.import);
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
    for (const [requestId, p] of this.profileChecks) {
      if (p.hostId !== hostId) continue;
      clearTimeout(p.timer);
      this.profileChecks.delete(requestId);
      p.reject(new SettingsError(409, 'host_offline', `${this.hostLabel(hostId)} went offline`));
    }
  }

  private hostLabel(hostId: string): string {
    return this.opts.hostName?.(hostId) ?? hostId;
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
        ...limitBehaviourInStep(SharedSettingsPatch.parse(patch) as SharedSettingsPatch),
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
    added.push(...this.takeProviderKeys(imported));
    this.importedHosts.add(hostId);
    this.keysImportedHosts.add(hostId);
    this.opts.logger?.info(
      { hostId, host, first, added, skipped },
      'shared settings: imported a host',
    );
    this.commit({ secrets: true });
  }

  /** Provider keys the account does not have yet; one it already has is kept. */
  private takeProviderKeys(imported: SettingsImport): string[] {
    const added: string[] = [];
    for (const { id } of PROVIDER_KEYS) {
      const value = imported.secrets.providerKeys[id];
      if (value && !this.secrets.providerKeys[id]) {
        this.secrets.providerKeys[id] = value;
        added.push(`${id} key`);
      }
    }
    return added;
  }

  /** A host already imported brings only its provider keys, so its accounts and settings are not re-merged. */
  private mergeKeysOnly(hostId: string, imported: SettingsImport): void {
    this.requireSecrets();
    const added = this.takeProviderKeys(imported);
    this.keysImportedHosts.add(hostId);
    this.opts.logger?.info({ hostId, added }, 'shared settings: imported a host’s provider keys');
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
      case 'host.account':
        this.observeBedrockSignIn(event);
        this.accountStates.observe(event);
        return;
      case 'host.host':
        this.observeAwsProfiles(event.hostId, event.awsProfiles);
        return;
      case 'patch.aws_profile_check.response': {
        const p = this.profileChecks.get(event.requestId);
        if (!p || p.hostId !== event.hostId) return;
        clearTimeout(p.timer);
        this.profileChecks.delete(event.requestId);
        p.resolve(event);
        return;
      }
      case 'host.account_spend':
        this.addBedrockSpend(event);
        return;
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

  /**
   * A host's AWS profiles. Whether it reports them at all is whether it can
   * run a Bedrock account, so a host that gains or loses that is sent a fresh
   * snapshot with or without its Bedrock accounts.
   */
  private observeAwsProfiles(hostId: string, profiles: AwsProfileInfo[] | undefined): void {
    const before = this.bedrockHosts.has(hostId);
    if (profiles) {
      this.awsProfiles.set(hostId, profiles);
      this.bedrockHosts.add(hostId);
    } else {
      this.awsProfiles.delete(hostId);
      this.bedrockHosts.delete(hostId);
    }
    if (before === (profiles !== undefined)) return;
    this.persist({ secrets: false });
    if (!this.secrets.claude.some((a) => a.bedrock?.hostId === hostId)) return;
    if (
      this.syncing &&
      this.importedHosts.has(hostId) &&
      this.opts.onlineHostIds().includes(hostId)
    ) {
      this.opts.sendToHost(hostId, this.snapshotFor(hostId));
    }
  }

  /** A Bedrock account's host says whether its profile is signed in (`connected`). Only its own host is heard. */
  private observeBedrockSignIn(event: Extract<WireEvent, { type: 'host.account' }>): void {
    for (const summary of event.accounts ?? []) {
      const account = this.secrets.claude.find((a) => a.id === summary.id);
      if (!account?.bedrock || account.bedrock.hostId !== event.hostId) continue;
      if (summary.connected) this.bedrockSignedOut.delete(account.id);
      else this.bedrockSignedOut.add(account.id);
    }
  }

  /**
   * What a turn or one-shot call on a Bedrock account cost (spec/10 § Spending
   * caps): added to the month it ran in, a new month starting from nothing.
   * Persisted and pushed, so a restart never forgets it and the host sees the cap.
   */
  private addBedrockSpend(event: Extract<WireEvent, { type: 'host.account_spend' }>): void {
    const account = this.secrets.claude.find((a) => a.id === event.accountId);
    if (!account?.bedrock) {
      this.opts.logger?.warn(
        { hostId: event.hostId, accountId: event.accountId },
        'shared settings: spend reported for an account that is not a Bedrock account — ignored',
      );
      return;
    }
    if (account.bedrock.hostId !== event.hostId) {
      this.opts.logger?.warn(
        { hostId: event.hostId, accountId: event.accountId, owner: account.bedrock.hostId },
        'shared settings: spend reported by a host the Bedrock account is not on — ignored',
      );
      return;
    }
    if (this.problem !== undefined) {
      this.opts.logger?.error(
        { accountId: event.accountId, costUsd: event.costUsd },
        'shared settings: Bedrock spend not recorded — the secrets cannot be written',
      );
      return;
    }
    const month = bedrockMonth(event.at);
    const b = account.bedrock;
    if (month < b.spentMonth) {
      this.opts.logger?.warn(
        { accountId: event.accountId, month, current: b.spentMonth, costUsd: event.costUsd },
        'shared settings: Bedrock spend for a month already closed — not counted',
      );
      return;
    }
    if (event.costUsd === 0 && month === b.spentMonth) return;
    // A spend comes through the host's outbox, which resends whatever was not
    // acknowledged: one already added (its acknowledgement lost with the link,
    // or the server restarted) is not added twice. Ids are kept with the
    // spend, so this holds across a restart; a host from before `spendId` is
    // told apart by when and what it spent.
    const spendId = event.spendId ?? `legacy:${event.at}:${event.costUsd}`;
    const sameMonth = month === b.spentMonth;
    const applied = sameMonth ? (b.spendIds ?? []) : [];
    if (applied.includes(spendId)) return;
    account.bedrock = {
      ...b,
      spentUsd: (sameMonth ? b.spentUsd : 0) + event.costUsd,
      spentMonth: month,
      spendIds: [...applied, spendId].slice(-BEDROCK_SPEND_IDS_KEPT),
    };
    this.commit({ secrets: true });
  }

  /**
   * Ask a host whether an AWS profile exists there and is signed in. Nothing
   * can be checked on a host that is offline or cannot run Bedrock accounts.
   */
  private async checkAwsProfile(
    hostId: string,
    awsProfile: string,
  ): Promise<PatchAwsProfileCheckResponseEvent> {
    const name = this.hostLabel(hostId);
    if (!this.opts.onlineHostIds().includes(hostId)) {
      throw new SettingsError(409, 'host_offline', `${name} is offline`);
    }
    if (!this.awsProfiles.has(hostId)) {
      throw new SettingsError(
        409,
        'bedrock_unsupported',
        `${name} cannot run Amazon Bedrock accounts; update Patch on it first`,
      );
    }
    const requestId = randomUUID();
    const answer = await new Promise<PatchAwsProfileCheckResponseEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.profileChecks.delete(requestId);
        reject(new SettingsError(504, 'daemon_timeout', `${name} did not answer`));
      }, this.opts.profileCheckTimeoutMs ?? 20_000);
      this.profileChecks.set(requestId, { hostId, resolve, reject, timer });
      this.opts.sendToHost(hostId, {
        type: 'patch.aws_profile_check.request',
        requestId,
        hostId,
        awsProfile,
      });
    });
    if (!answer.exists) {
      throw new SettingsError(
        400,
        'profile_not_found',
        `${name} has no AWS profile ${awsProfile}${answer.error ? `: ${answer.error}` : ''}`,
      );
    }
    return answer;
  }

  /** The row already using this host's profile, other than `exceptId`. */
  private bedrockClash(hostId: string, awsProfile: string, exceptId?: string) {
    return this.secrets.claude.find(
      (a) =>
        a.id !== exceptId && a.bedrock?.hostId === hostId && a.bedrock.awsProfile === awsProfile,
    );
  }

  private refuseBedrockClash(hostId: string, awsProfile: string, exceptId?: string): void {
    const clash = this.bedrockClash(hostId, awsProfile, exceptId);
    if (clash) {
      throw new SettingsError(
        409,
        'duplicate_account',
        `${this.hostLabel(hostId)}'s AWS profile ${awsProfile} is already ${clash.label}`,
      );
    }
  }

  /** Signed in, signed out, or not known (no AWS CLI on the host): only `false` marks it. */
  private recordProfileCheck(accountId: string, answer: PatchAwsProfileCheckResponseEvent): void {
    if (answer.signedIn === false) this.bedrockSignedOut.add(accountId);
    else this.bedrockSignedOut.delete(accountId);
  }

  /**
   * Add a Claude on Amazon Bedrock account (spec/10 § Signing in): its host
   * checks the profile first. Missing → refused; signed out → stored signed
   * out; host offline → nothing stored. Off the order unless sent `auto`.
   */
  async addBedrock(input: BedrockAccountInput): Promise<SharedClaudeAccount> {
    this.requireSecrets();
    const label = input.label.trim();
    if (!label) throw new SettingsError(400, 'invalid_input', 'A name cannot be empty');
    this.refuseBedrockClash(input.hostId, input.awsProfile);
    const answer = await this.checkAwsProfile(input.hostId, input.awsProfile);
    // Checked again: the same profile may have been added while the host answered.
    this.refuseBedrockClash(input.hostId, input.awsProfile);
    const now = (this.opts.now ?? Date.now)();
    const account: SharedClaudeAccount = {
      id: randomUUID(),
      label,
      credential: null,
      auto: input.auto ?? false,
      bedrock: {
        hostId: input.hostId,
        awsProfile: input.awsProfile,
        awsRegion: input.awsRegion,
        regionPrefix: input.regionPrefix,
        monthlyCapUsd: input.monthlyCapUsd,
        spentUsd: 0,
        spentMonth: bedrockMonth(now),
      },
    };
    this.recordProfileCheck(account.id, answer);
    this.secrets.claude.push(account);
    this.placeByAuto(account);
    this.opts.logger?.info(
      { accountId: account.id, hostId: input.hostId, signedIn: answer.signedIn },
      'shared settings: Bedrock account added',
    );
    this.commit({ secrets: true });
    return account;
  }

  /**
   * Change a Claude account's row: `auto` on any; host, profile, region,
   * where requests run and the cap on a Bedrock account. A new host or
   * profile is checked first, as an add is.
   */
  async editClaude(accountId: string, edit: ClaudeAccountEdit): Promise<void> {
    this.requireSecrets();
    const found = this.secrets.claude.find((a) => a.id === accountId);
    if (!found) throw new SettingsError(404, 'account_not_found', `No Claude account ${accountId}`);
    const { auto, ...bedrockEdit } = edit;
    const touchesBedrock = Object.values(bedrockEdit).some((v) => v !== undefined);
    if (touchesBedrock && !found.bedrock) {
      throw new SettingsError(
        400,
        'invalid_input',
        `${found.label} is not an Amazon Bedrock account`,
      );
    }
    let answer: PatchAwsProfileCheckResponseEvent | undefined;
    if (found.bedrock) {
      const hostId = edit.hostId ?? found.bedrock.hostId;
      const awsProfile = edit.awsProfile ?? found.bedrock.awsProfile;
      if (hostId !== found.bedrock.hostId || awsProfile !== found.bedrock.awsProfile) {
        this.refuseBedrockClash(hostId, awsProfile, accountId);
        answer = await this.checkAwsProfile(hostId, awsProfile);
        this.refuseBedrockClash(hostId, awsProfile, accountId);
      }
    }
    // Looked up again: the account may have gone while the host answered.
    const account = this.secrets.claude.find((a) => a.id === accountId);
    if (!account)
      throw new SettingsError(404, 'account_not_found', `No Claude account ${accountId}`);
    if (account.bedrock) {
      account.bedrock = {
        ...account.bedrock,
        ...(edit.hostId !== undefined ? { hostId: edit.hostId } : {}),
        ...(edit.awsProfile !== undefined ? { awsProfile: edit.awsProfile } : {}),
        ...(edit.awsRegion !== undefined ? { awsRegion: edit.awsRegion } : {}),
        ...(edit.regionPrefix !== undefined ? { regionPrefix: edit.regionPrefix } : {}),
        ...(edit.monthlyCapUsd !== undefined ? { monthlyCapUsd: edit.monthlyCapUsd } : {}),
      };
      if (answer) {
        // A new profile: what was said about the old one no longer holds.
        this.recordProfileCheck(account.id, answer);
        this.accountStates.credentialReplaced(account.id);
      }
    }
    if (auto !== undefined && auto !== (account.auto ?? true)) {
      account.auto = auto;
      this.placeByAuto(account);
    }
    this.commit({ secrets: true });
  }

  /**
   * Keep accounts in the order first and those out of it after (spec/10 §
   * Choosing an account): one ticked goes last in the order, one unticked
   * goes after every account in it.
   */
  private placeByAuto(account: SharedClaudeAccount): void {
    const rest = this.secrets.claude.filter((a) => a !== account);
    const inOrder = rest.filter((a) => a.auto !== false);
    const outOfOrder = rest.filter((a) => a.auto === false);
    this.secrets.claude =
      account.auto === false
        ? [...inOrder, ...outOfOrder, account]
        : [...inOrder, account, ...outOfOrder];
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
    kind: Exclude<SettingsAdoptKind, 'import' | 'codex-signin' | 'provider-key'>,
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
    // spec/10 § Provider settings: only a setting a provider (or ACP agent)
    // declares, and only a value it takes.
    const groups = ownSettingsGroups(parsed.data.acpAgents ?? this.settings.acpAgents);
    for (const [id, chosen] of Object.entries(parsed.data.providerSettings ?? {})) {
      const declared = groups.find((g) => g.id === id);
      if (!declared) throw new SettingsError(400, 'invalid_input', `unknown provider: ${id}`);
      for (const [key, value] of Object.entries(chosen)) {
        const setting = declared.settings.find((d) => d.key === key);
        if (!setting) {
          throw new SettingsError(400, 'invalid_input', `${declared.label} has no setting ${key}`);
        }
        const problem = invalidOwnSettingValue(setting, value);
        if (problem !== null) throw new SettingsError(400, 'invalid_input', problem);
      }
    }
    const background = parsed.data.backgroundAccount;
    if (
      background !== undefined &&
      background !== BACKGROUND_ACCOUNT_AUTO &&
      !this.secrets.claude.some((a) => a.id === background)
    ) {
      throw new SettingsError(400, 'invalid_input', `No Claude account ${background}`);
    }
    if (parsed.data.managerFolder !== undefined && !isManagerFolder(parsed.data.managerFolder)) {
      throw new SettingsError(
        400,
        'invalid_input',
        `The Manager folder must be an absolute path: ${parsed.data.managerFolder}`,
      );
    }
    // An endpoint taken out takes its key with it.
    const keptKeys = parsed.data.modelEndpoints
      ? this.endpointKeysFor(parsed.data.modelEndpoints.map((e) => e.id))
      : undefined;
    if (keptKeys !== undefined) this.requireSecrets();
    this.settings = {
      ...this.settings,
      ...managerWakeInStep(limitBehaviourInStep(parsed.data), this.settings),
    };
    if (keptKeys !== undefined) this.replaceEndpointKeys(keptKeys);
    this.commit({ secrets: keptKeys !== undefined });
    return this.current();
  }

  /** The saved endpoint keys for these endpoint ids, or undefined when nothing would be dropped. */
  private endpointKeysFor(ids: string[]): Record<string, string> | undefined {
    const held = this.secrets.endpointKeys ?? {};
    const kept = Object.fromEntries(Object.entries(held).filter(([id]) => ids.includes(id)));
    return Object.keys(kept).length === Object.keys(held).length ? undefined : kept;
  }

  /** Absent rather than empty, so a snapshot with no endpoint keys is unchanged for older hosts. */
  private replaceEndpointKeys(keys: Record<string, string>): void {
    if (Object.keys(keys).length === 0) delete this.secrets.endpointKeys;
    else this.secrets.endpointKeys = keys;
  }

  /** Save the key a model endpoint is called with (spec/02 § Provider adapters). */
  setEndpointKey(endpointId: string, value: string): void {
    this.requireSecrets();
    if (!(this.settings.modelEndpoints ?? []).some((e) => e.id === endpointId)) {
      throw new SettingsError(404, 'unknown_endpoint', `No model endpoint ${endpointId}`);
    }
    const trimmed = value.trim();
    if (trimmed === '' || /\s/.test(trimmed)) {
      throw new SettingsError(400, 'invalid_value', 'A key has no whitespace');
    }
    this.replaceEndpointKeys({ ...this.secrets.endpointKeys, [endpointId]: trimmed });
    this.commit({ secrets: true });
  }

  revokeEndpointKey(endpointId: string): void {
    this.requireSecrets();
    if (!this.secrets.endpointKeys?.[endpointId]) {
      throw new SettingsError(404, 'not_set', `No key is saved for ${endpointId}`);
    }
    const { [endpointId]: _gone, ...rest } = this.secrets.endpointKeys;
    void _gone;
    this.replaceEndpointKeys(rest);
    this.commit({ secrets: true });
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
      label:
        label?.trim() ||
        credential.email ||
        (isAnthropicApiKey(credential.accessToken)
          ? 'Claude API (paid)'
          : // No email is available from a sign-in, so the first account is just
            // "Claude"; a number appears only once a second one needs telling apart.
            this.secrets.claude.length === 0
            ? 'Claude'
            : `Claude ${this.secrets.claude.length + 1}`),
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
    if (account.bedrock) {
      throw new SettingsError(
        400,
        'invalid_input',
        `${account.label} is an Amazon Bedrock account; it takes no token`,
      );
    }
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
    this.renewalErrors.delete(accountId);
    this.accountStates.credentialReplaced(accountId);
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

  /**
   * Store a ChatGPT login the server obtained itself (spec/10 § Signing in). A new
   * sign-in is a new account and cannot repeat one already connected; Sign in
   * again on a row replaces its credential and keeps its id, label and place.
   */
  signInChatGPT(
    login: { authJson: string; identity: string; email?: string },
    target: { accountId?: string; label?: string } = {},
  ): SharedCodexAccount {
    this.requireSecrets();
    const clash = this.secrets.codex.find(
      (a) => a.identity === login.identity && a.id !== target.accountId,
    );
    if (clash && clash.authJson !== null) {
      throw new SettingsError(
        409,
        'duplicate_account',
        `This login is the same ChatGPT account as ${clash.label}`,
      );
    }
    const row = target.accountId
      ? this.secrets.codex.find((a) => a.id === target.accountId)
      : clash;
    if (target.accountId && !row) {
      throw new SettingsError(404, 'account_not_found', `No codex account ${target.accountId}`);
    }
    if (row) {
      // A disconnected row for the same login is signed in again, not duplicated.
      row.kind = 'chatgpt';
      row.authJson = login.authJson;
      row.identity = login.identity;
      if (login.email) row.email = login.email;
      this.renewalErrors.delete(row.id);
      this.commit({ secrets: true });
      return row;
    }
    return this.addCodexAccount(
      {
        id: randomUUID(),
        label: target.label?.trim() || login.email || `ChatGPT ${this.secrets.codex.length + 1}`,
        kind: 'chatgpt',
        ...(login.email ? { email: login.email } : {}),
        identity: login.identity,
        authJson: login.authJson,
      },
      'device sign-in',
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
      this.accountStates.credentialReplaced(clash.id);
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
    if ('bedrock' in account && account.bedrock) {
      throw new SettingsError(
        400,
        'invalid_input',
        `${account.label} signs in with AWS on its host; Patch holds no sign-in to forget`,
      );
    }
    if ('credential' in account) account.credential = null;
    else account.authJson = null;
    this.accountStates.credentialReplaced(accountId);
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
    this.renewalErrors.delete(accountId);
    this.bedrockSignedOut.delete(accountId);
    this.accountStates.forget(accountId);
    // Titles and status named this account: they choose for themselves again.
    if (this.settings.backgroundAccount === accountId) {
      this.settings = { ...this.settings, backgroundAccount: BACKGROUND_ACCOUNT_AUTO };
    }
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

  // ---- ACP accounts (spec/10 § Backend credentials, § Signing in) ----

  /** The agent an account can be added for: known, and taking an API key. */
  private acpAgentFor(agentId: string): AcpAgentConfig & { apiKeyEnv: string } {
    const agent = resolveAcpAgents(this.settings.acpAgents).find((a) => a.id === agentId);
    if (!agent) throw new SettingsError(404, 'unknown_agent', `No ACP agent ${agentId}`);
    if (agent.apiKeyEnv === undefined) {
      throw new SettingsError(
        400,
        'no_api_key',
        `${agent.label} takes no API key; it runs on its own sign-in on each host`,
      );
    }
    return agent as AcpAgentConfig & { apiKeyEnv: string };
  }

  /**
   * A key fit to store for `agent`: well formed, not already connected, and
   * accepted by the provider where the agent names a check. A refusal stores
   * nothing; so does a check that could not reach the provider, since neither
   * says the key works.
   */
  private async validAcpKey(
    agent: AcpAgentConfig,
    value: string,
    replacing?: string,
  ): Promise<string> {
    const key = value.trim();
    if (key.length < PROVIDER_KEY_MIN_LENGTH || /\s/.test(key)) {
      throw new SettingsError(
        400,
        'invalid_value',
        `A key must be at least ${PROVIDER_KEY_MIN_LENGTH} characters with no whitespace`,
      );
    }
    const clash = (this.secrets.acp ?? []).find(
      (a) => a.agentId === agent.id && a.apiKey === key && a.id !== replacing,
    );
    if (clash) {
      throw new SettingsError(
        409,
        'account_exists',
        `That key is already connected as ${clash.label}`,
      );
    }
    if (agent.apiKeyCheck !== undefined) {
      const check = await checkProviderKey(agent.apiKeyCheck, key, this.opts.keyCheckFetch);
      if (check.status === 'rejected') {
        throw new SettingsError(400, 'credential_rejected', check.message ?? 'The key was refused');
      }
      if (check.status === 'unreachable') {
        throw new SettingsError(
          502,
          'credential_unreachable',
          check.message ?? 'Could not reach the provider to check the key',
        );
      }
    }
    return key;
  }

  /** Sign an ACP agent in with an API key: a new account, last in its order. */
  async addAcpAccount(agentId: string, apiKey: string, label?: string): Promise<SharedAcpAccount> {
    this.requireSecrets();
    const agent = this.acpAgentFor(agentId);
    const key = await this.validAcpKey(agent, apiKey);
    const held = (this.secrets.acp ?? []).filter((a) => a.agentId === agentId);
    const account: SharedAcpAccount = {
      id: randomUUID(),
      agentId,
      label:
        label?.trim() || (held.length === 0 ? agent.label : `${agent.label} ${held.length + 1}`),
      apiKey: key,
    };
    this.secrets.acp = [...(this.secrets.acp ?? []), account];
    this.opts.logger?.info(
      { accountId: account.id, agentId },
      'shared settings: ACP account added',
    );
    this.commit({ secrets: true });
    return account;
  }

  private findAcp(agentId: string, accountId: string): SharedAcpAccount {
    const account = (this.secrets.acp ?? []).find(
      (a) => a.id === accountId && a.agentId === agentId,
    );
    if (!account) {
      throw new SettingsError(404, 'account_not_found', `No ${agentId} account ${accountId}`);
    }
    return account;
  }

  /** Sign in again: a new key on the same account, keeping its id, label and position. */
  async replaceAcpKey(agentId: string, accountId: string, apiKey: string): Promise<void> {
    this.requireSecrets();
    this.findAcp(agentId, accountId);
    const key = await this.validAcpKey(this.acpAgentFor(agentId), apiKey, accountId);
    // Looked up again: the account may have gone while the check was out.
    this.findAcp(agentId, accountId).apiKey = key;
    this.accountStates.credentialReplaced(accountId);
    this.commit({ secrets: true });
  }

  /** One agent's accounts in a new order: every account, each once. The order is the priority. */
  orderAcp(agentId: string, accountIds: string[]): void {
    this.requireSecrets();
    const all = this.secrets.acp ?? [];
    const held = all.filter((a) => a.agentId === agentId).map((a) => a.id);
    const unknown = accountIds.filter((id) => !held.includes(id));
    const missing = held.filter((id) => !accountIds.includes(id));
    if (unknown.length || missing.length || new Set(accountIds).size !== accountIds.length) {
      throw new SettingsError(
        400,
        'invalid_order',
        `The order must name each ${agentId} account exactly once (holds: ${held.join(', ') || 'none'})`,
      );
    }
    const ordered = accountIds.map((id) => all.find((a) => a.id === id)!);
    // The agent's accounts take the places its accounts held; other agents' stay put.
    let next = 0;
    this.secrets.acp = all.map((a) => (a.agentId === agentId ? ordered[next++]! : a));
    this.commit({ secrets: true });
  }

  /** How a turn picks among each ACP agent's accounts (spec/10 § Choosing an account). */
  setAcpStrategy(strategy: AccountStrategy): void {
    this.update({ accountStrategy: { ...this.settings.accountStrategy, acp: strategy } });
  }

  removeAcpAccount(agentId: string, accountId: string): void {
    this.requireSecrets();
    this.findAcp(agentId, accountId);
    const rest = (this.secrets.acp ?? []).filter((a) => a.id !== accountId);
    // Absent rather than empty, so a snapshot with none is unchanged for older hosts.
    if (rest.length === 0) delete this.secrets.acp;
    else this.secrets.acp = rest;
    this.accountStates.forget(accountId);
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
    this.keyChecks.delete(id);
    this.commit({ secrets: true });
  }

  revokeProviderKey(id: ProviderKeyId): void {
    this.requireSecrets();
    if (!this.secrets.providerKeys[id]) {
      throw new SettingsError(404, 'not_set', `No ${id} key is set from Settings`);
    }
    delete this.secrets.providerKeys[id];
    this.keyChecks.delete(id);
    this.commit({ secrets: true });
  }
}
