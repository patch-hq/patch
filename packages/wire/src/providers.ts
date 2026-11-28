// The provider registry (spec/02 § Agent backends).
//
// A provider is an agent harness a chat can run on. EVERYTHING a surface or the
// host needs to know about one that is a plain fact — its id, how its models
// are named, which permission modes it can run, how its native session ids
// look — lives in one entry of PROVIDERS. Adding a provider is one entry here
// plus its backend registered with the host's harness registry
// (`packages/host/src/harnesses.ts`); no other file names a provider.
//
// Model routing: a provider claims a model by `modelPrefix` (`openai/gpt-5`).
// The one provider with no prefix (`claude`) is the default for any model no
// prefix claims, so every model Anthropic releases from here on works unedited.

import {
  acpSettingsId,
  resolveAcpAgents,
  type AcpAgentConfig,
  type OwnSettingsGroup,
} from './acpAgents.js';
import type { OwnSetting } from './ownSettings.js';
import type { PermissionMode } from './events.js';

/**
 * What a provider can do natively through its official interface (spec/02
 * § Provider adapters). A feature whose capability is not declared is absent for
 * the provider's chats; nothing outside the adapters branches on a provider name.
 */
export interface ProviderCapabilities {
  /** Continue a conversation from the provider's own saved session. */
  readonly resume: boolean;
  /** Replace a user message and re-run from it (edit forks at that message). */
  readonly editAtMessage: boolean;
  /** Rewind the conversation to an earlier message in place. */
  readonly rewind: boolean;
  /** Branch a new session at a turn boundary (also what side threads use). */
  readonly branchAtTurn: boolean;
  /** Switch off the provider's native tools that Patch replaces (subagents, cron). */
  readonly disableNativeTools: boolean;
  /** Interrupt a running turn. */
  readonly interrupt: boolean;
  /** Add input to a turn that is already running. */
  readonly steer: boolean;
  /**
   * Take text appended to its system prompt: the patch-tools guidance and the
   * Manager prompt (spec/06 § Manager prompt and folder).
   */
  readonly systemPrompt: boolean;
}

export type ProviderCapability = keyof ProviderCapabilities;

/**
 * One of a provider's OWN settings (spec/10 § Provider settings): a value the
 * provider itself reads from its own configuration, such as how long it keeps
 * a session. Patch shows it and writes the user's choice through; it never
 * sets one the user has not chosen (`ownSettings.ts`).
 */
export type ProviderSettingDescriptor = OwnSetting;

/** The kinds an account can be: a subscription sign-in or a paid API key. */
export type AccountKind = 'chatgpt' | 'apiKey';

export interface ProviderDescriptor {
  /** Stable id; persisted in history logs, so never renamed. */
  readonly id: string;
  /** How the provider is named on every screen. */
  readonly label: string;
  /** Model ids starting with this belong to the provider. `null` = the default provider. */
  readonly modelPrefix: string | null;
  /** Native session ids the provider mints start with this. `null` = the default provider. */
  readonly sessionIdPrefix: string | null;
  /** Permission modes the provider can run at all; `'all'` is every PermissionMode. */
  readonly permissionModes: 'all' | readonly PermissionMode[];
  /** The backend id the provider's credentials and account reports are keyed by (`claude-code`). */
  readonly backendId: string;
  /**
   * The key of the provider's list in the shared settings (`secrets.<key>`,
   * `strategy.<key>`). `null` for a provider with no accounts to sign in to
   * (an agent that holds its own sign-in): it has no credential store, strategy or usage.
   */
  readonly accountsKey: string | null;
  /**
   * For a provider whose accounts come in kinds a model picks between (a
   * subscription and a paid API key): the kind a model runs on is that of the
   * first prefix it starts with, else `default`. `null` when its accounts have
   * no kinds.
   */
  readonly accountKinds: {
    readonly default: AccountKind;
    readonly byModelPrefix: readonly { readonly prefix: string; readonly kind: AccountKind }[];
  } | null;
  /**
   * How Settings → Hosts signs a host in to the provider: a pasted token
   * (`pasteToken`), or the provider's own account flow on the accounts page
   * (`accountFlow`). `null` for a provider with nothing to sign in to.
   */
  readonly hostSignIn: 'pasteToken' | 'accountFlow' | null;
  /** Other names the CLI accepts for it (`openai` for codex). */
  readonly aliases: readonly string[];
  /** Does the provider honour the per-chat reasoning-effort control? */
  readonly supportsEffort: boolean;
  /** The `chat.error` code for a turn refused because the provider is not signed in. */
  readonly loginRequiredCode: string;
  /**
   * Slash commands the provider's own CLI handles itself (`/context`, `/help`).
   * The provider intercepts these before any skill of the same name, so Patch
   * refuses to offer a colliding skill. Excludes Patch's own `/clear` and
   * `/goal`, which Patch handles before the provider sees them.
   */
  readonly builtinCommands: readonly string[];
  /** What the provider supports natively; features follow this (spec/02 § Provider adapters). */
  readonly capabilities: ProviderCapabilities;
  /**
   * Where the provider can fork a conversation (spec/04 § Forking, § Side
   * threads), read by `forkPointIndex`. `userTurnIds`: the user's own turn
   * carries a provider id, so a side thread can keep it. `wholeTurns`: the
   * provider forks only at turn ends, so a side thread off a user turn keeps
   * the turns before it.
   */
  readonly branching: { readonly userTurnIds: boolean; readonly wholeTurns: boolean };
  /** The provider's own settings Settings exposes (spec/10 § Provider settings). */
  readonly settings: readonly ProviderSettingDescriptor[];
  /**
   * The format of the provider's own configuration file the settings are
   * written into (each host's adapter says where the files are). Absent for a
   * provider with no settings of its own here; an ACP agent declares its own
   * (`AcpAgentConfig.ownSettings`).
   */
  readonly ownConfigFormat?: 'json' | 'toml';
  /**
   * Hosts report the provider's own configuration file (Claude Code's
   * `settings.json`, in `claude_settings.updated`), so Settings can show a value
   * set there when Patch has none chosen. False for a provider whose own
   * configuration no host reports.
   */
  readonly ownSettingsReportedByHost: boolean;
  /**
   * What Settings says about the provider's own session settings when it
   * declares none that Patch can expose (spec/10 § Provider settings), so an
   * empty list reads as the provider's fact rather than as Patch leaving it out.
   */
  readonly settingsNote?: string;
  /**
   * The Patch tools the provider's own native tools duplicate (subagents,
   * self-wake, goals). Withheld from its chats when it cannot switch the native
   * ones off (`capabilities.disableNativeTools`).
   */
  readonly nativeDuplicates: readonly string[];
}

// `as const satisfies` keeps the ids as literals so HarnessId is derived from
// this table rather than maintained beside it.
export const PROVIDERS = [
  {
    id: 'claude',
    label: 'Claude',
    modelPrefix: null,
    sessionIdPrefix: null,
    permissionModes: 'all',
    backendId: 'claude-code',
    accountsKey: 'claude',
    accountKinds: null,
    hostSignIn: 'pasteToken',
    aliases: ['claude-code'],
    supportsEffort: true,
    loginRequiredCode: 'claude_oauth_missing',
    builtinCommands: [
      'add-dir',
      'agents',
      'bug',
      'compact',
      'config',
      'context',
      'cost',
      'doctor',
      'export',
      'help',
      'hooks',
      'ide',
      'init',
      'login',
      'logout',
      'mcp',
      'memory',
      'model',
      'permissions',
      'plugin',
      'release-notes',
      'resume',
      'review',
      'rewind',
      'status',
      'terminal-setup',
      'theme',
      'todos',
      'usage',
      'vim',
    ],
    branching: { userTurnIds: true, wholeTurns: false },
    capabilities: {
      resume: true,
      editAtMessage: true,
      rewind: true,
      branchAtTurn: true,
      disableNativeTools: true,
      interrupt: true,
      // The Agent SDK's PostToolBatch hook hands waiting input to the agent at a tool boundary.
      steer: true,
      systemPrompt: true,
    },
    settings: [
      {
        key: 'cleanupPeriodDays',
        label: 'Delete sessions after',
        description:
          "Claude Code deletes a session's own files once it has been idle this long. Patch's record of the chat is kept.",
        kind: 'days',
        min: 1,
        max: 3650,
        providerDefault: 30,
        write: { as: 'number' },
      },
    ],
    ownConfigFormat: 'json',
    ownSettingsReportedByHost: true,
    nativeDuplicates: [
      'patch_agent',
      'patch_wake_me',
      'patch_loop',
      'patch_wake_status',
      'patch_cancel_wake',
    ],
  },
  {
    id: 'codex',
    label: 'ChatGPT',
    modelPrefix: 'openai/',
    sessionIdPrefix: 'codex-',
    // Codex has no classifier-driven approval, so no `auto`.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    backendId: 'codex',
    accountsKey: 'codex',
    accountKinds: {
      default: 'chatgpt',
      byModelPrefix: [{ prefix: 'openai/api/', kind: 'apiKey' }],
    },
    hostSignIn: 'accountFlow',
    aliases: ['openai', 'chatgpt'],
    supportsEffort: false,
    loginRequiredCode: 'chatgpt_login_required',
    builtinCommands: [
      'approvals',
      'compact',
      'diff',
      'init',
      'logout',
      'mcp',
      'mention',
      'model',
      'new',
      'quit',
      'resume',
      'review',
      'status',
      'undo',
    ],
    branching: { userTurnIds: false, wholeTurns: true },
    capabilities: {
      resume: true,
      editAtMessage: true,
      rewind: false,
      branchAtTurn: true,
      disableNativeTools: false,
      interrupt: true,
      steer: true,
      // As developer instructions.
      systemPrompt: true,
    },
    // ChatGPT has no setting that deletes or expires its own sessions: it keeps
    // every session until one is deleted (`codex delete`). What its own
    // configuration does offer is its prompt history (`[history]` in each
    // CODEX_HOME's config.toml, codex-cli 0.154): whether it is kept at all, and
    // how large it may grow before the oldest entries go.
    settings: [
      {
        key: 'history.persistence',
        label: 'Keep prompt history',
        description:
          'ChatGPT saves every prompt to its own history file. Off, it saves none. Sessions are kept either way.',
        kind: 'toggle',
        min: 0,
        max: 1,
        providerDefault: 1,
        write: { as: 'words', words: ['none', 'save-all'] },
      },
      {
        key: 'history.max_bytes',
        label: 'Prompt history size',
        description:
          'ChatGPT drops its oldest saved prompts once the history file grows past this size.',
        kind: 'megabytes',
        min: 1,
        max: 10240,
        providerDefault: null,
        write: { as: 'bytes' },
      },
    ],
    ownConfigFormat: 'toml',
    settingsNote:
      'ChatGPT has no setting to delete old sessions. It keeps every session until you delete it with ChatGPT itself.',
    ownSettingsReportedByHost: false,
    nativeDuplicates: ['patch_agent'],
  },
  // Any Agent Client Protocol agent (spec/02 § Provider adapters): Gemini CLI
  // and every agent added as a config entry. Models are
  // `acp/<agent>/<agent's model id>`. These are the capabilities ACP itself
  // guarantees every agent; what one agent adds (loading a saved session) it
  // advertises at `initialize`, and the host's adapter reads it from there.
  {
    id: 'acp',
    label: 'ACP agent',
    modelPrefix: 'acp/',
    sessionIdPrefix: 'acp-',
    // No classifier-driven approval. Plan needs a read-only mode the agent may
    // not have, so it is not offered across the board.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    backendId: 'acp',
    // Its credential is a provider key (Settings → Providers) or the agent's
    // own sign-in, not an account list.
    accountsKey: null,
    accountKinds: null,
    // Its key is a shared provider key (Settings → Providers), not a per-host sign-in.
    hostSignIn: null,
    aliases: [],
    supportsEffort: false,
    loginRequiredCode: 'acp_agent_signed_out',
    builtinCommands: [],
    branching: { userTurnIds: false, wholeTurns: false },
    capabilities: {
      // Per agent: the adapter reopens a saved session where the agent offers
      // session/load or session/resume, and refuses with a clear error where not.
      resume: true,
      editAtMessage: false,
      rewind: false,
      branchAtTurn: false,
      disableNativeTools: false,
      interrupt: true,
      steer: false,
      // ACP has no system prompt to append to.
      systemPrompt: false,
    },
    settings: [],
    ownSettingsReportedByHost: false,
    nativeDuplicates: [],
  },
] as const satisfies readonly ProviderDescriptor[];

export type ProviderId = (typeof PROVIDERS)[number]['id'];

/** The provider no model prefix claims. Exactly one entry has no prefix. */
export const DEFAULT_PROVIDER_ID: ProviderId = 'claude';

export function providerDescriptor(id: string): ProviderDescriptor {
  const p = (PROVIDERS as readonly ProviderDescriptor[]).find((d) => d.id === id);
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p;
}

/** Which provider a model id belongs to. No model yet is the default provider's. */
export function providerForModel(model: string | null | undefined): ProviderId {
  if (model) {
    for (const p of PROVIDERS as readonly ProviderDescriptor[]) {
      if (p.modelPrefix !== null && model.startsWith(p.modelPrefix)) return p.id as ProviderId;
    }
  }
  return DEFAULT_PROVIDER_ID;
}

/** The provider's own built-in slash commands for a chat on this model. */
export function providerBuiltinCommands(model: string | null | undefined): ReadonlySet<string> {
  return new Set(providerDescriptor(providerForModel(model)).builtinCommands);
}

/** Which provider minted a native session id; undefined when there is no session. */
export function providerForSessionId(sessionId: string | null | undefined): ProviderId | undefined {
  if (!sessionId) return undefined;
  for (const p of PROVIDERS as readonly ProviderDescriptor[]) {
    if (p.sessionIdPrefix !== null && sessionId.startsWith(p.sessionIdPrefix)) {
      return p.id as ProviderId;
    }
  }
  return DEFAULT_PROVIDER_ID;
}

/** A session id minted by the retired local-model loop; its history is read-only. */
export function isRetiredLocalSessionId(sessionId: string | null | undefined): boolean {
  return !!sessionId && sessionId.startsWith('local-');
}

/** The provider whose credentials are keyed by this backend id. */
export function providerForBackendId(backendId: string): ProviderId {
  const p = (PROVIDERS as readonly ProviderDescriptor[]).find((d) => d.backendId === backendId);
  if (!p) throw new Error(`unknown backend: ${backendId}`);
  return p.id as ProviderId;
}

/** A provider by id, backend id or CLI alias. */
export function providerByName(name: string): ProviderId {
  const p = (PROVIDERS as readonly ProviderDescriptor[]).find(
    (d) => d.id === name || d.backendId === name || d.aliases.includes(name),
  );
  if (!p) throw new Error(`unknown provider: ${name}`);
  return p.id as ProviderId;
}

/** The backend id a model's chats sign in with. */
export function backendIdForModel(model: string | null | undefined): ProviderBackendId {
  return providerDescriptor(providerForModel(model)).backendId as ProviderBackendId;
}

/** The capabilities the model's provider declares. */
export function providerCapabilities(model: string | null | undefined): ProviderCapabilities {
  return providerDescriptor(providerForModel(model)).capabilities;
}

/** Does the model's provider declare this capability? */
export function modelHasCapability(
  model: string | null | undefined,
  capability: ProviderCapability,
): boolean {
  return providerCapabilities(model)[capability];
}

/**
 * The Patch tools withheld from a chat on this model. Where the provider can
 * switch its native equivalents off (`disableNativeTools`) Patch's versions are
 * offered; where it cannot, the native ones stay and the Patch tools they
 * duplicate (the provider's `nativeDuplicates`) are withheld, so the agent never
 * sees two tools that do the same thing. A Patch tool with no native twin on the
 * provider stays.
 */
export function patchToolsOmittedFor(model: string | null | undefined): readonly string[] {
  const p = providerDescriptor(providerForModel(model));
  return p.capabilities.disableNativeTools ? [] : p.nativeDuplicates;
}

/** How every screen names the provider a model runs on. */
export function providerLabelForModel(model: string | null | undefined): string {
  return providerDescriptor(providerForModel(model)).label;
}

/** Where the model's provider keeps its accounts in the shared settings; null when it has none. */
export function accountsKeyForModel(model: string | null | undefined): ProviderAccountsKey | null {
  return providerDescriptor(providerForModel(model)).accountsKey as ProviderAccountsKey | null;
}

/**
 * The kind of account a model runs on, for a provider whose accounts have kinds
 * (`accountKinds`); null for one whose accounts do not.
 */
export function accountKindForModel(model: string | null | undefined): AccountKind | null {
  const kinds = providerDescriptor(providerForModel(model)).accountKinds;
  if (kinds === null) return null;
  return kindIn(kinds, model);
}

/**
 * The kind of account a chat of this provider runs on for `model` (none named
 * is the provider's default kind). For a provider's own adapter, which knows its
 * accounts have kinds; throws for a provider whose accounts do not.
 */
export function providerAccountKind(
  providerId: string,
  model: string | null | undefined,
): AccountKind {
  const kinds = providerDescriptor(providerId).accountKinds;
  if (kinds === null) throw new Error(`${providerId} accounts have no kinds`);
  return kindIn(kinds, model);
}

function kindIn(
  kinds: NonNullable<ProviderDescriptor['accountKinds']>,
  model: string | null | undefined,
): AccountKind {
  const hit = kinds.byModelPrefix.find((k) => model?.startsWith(k.prefix) === true);
  return hit ? hit.kind : kinds.default;
}

/**
 * Does this account serve the model? Always, for a provider whose accounts have
 * no kinds; otherwise only an account of the kind the model runs on. An account
 * that states no kind is of its provider's default kind.
 */
export function accountServesModel(
  account: { kind?: AccountKind | undefined },
  model: string | null | undefined,
): boolean {
  const kinds = providerDescriptor(providerForModel(model)).accountKinds;
  if (kinds === null) return true;
  return (account.kind ?? kinds.default) === accountKindForModel(model);
}

/**
 * Is an account connected that a chat on `model` can run on? `secrets` is the
 * shared settings' account lists, keyed by `accountsKey`. A provider with no
 * accounts (a local endpoint) has nothing to sign in to, so it is never signed out.
 */
export function modelAccountConnected(
  secrets: Partial<
    Record<
      ProviderAccountsKey,
      ReadonlyArray<{ connected: boolean; kind?: AccountKind | undefined }>
    >
  >,
  model: string | null | undefined,
): boolean {
  const key = accountsKeyForModel(model);
  if (key === null) return true;
  return (secrets[key] ?? []).some((a) => a.connected && accountServesModel(a, model));
}

/** Does the model's provider honour the reasoning-effort control? */
export function modelSupportsEffort(model: string | null | undefined): boolean {
  return providerDescriptor(providerForModel(model)).supportsEffort;
}

export type ProviderBackendId = (typeof PROVIDERS)[number]['backendId'];
export type AccountBackendId = (typeof ACCOUNT_PROVIDERS)[number]['backendId'];
export type ProviderAccountsKey = Exclude<(typeof PROVIDERS)[number]['accountsKey'], null>;

/** The providers that have accounts (a sign-in, a quota); everything account-shaped iterates these. */
export const ACCOUNT_PROVIDERS = PROVIDERS.filter(
  (p): p is Extract<(typeof PROVIDERS)[number], { accountsKey: string }> => p.accountsKey !== null,
);

/** Where the provider's accounts and strategy sit in the shared settings. */
export function accountsKeyForBackend(backendId: string): ProviderAccountsKey {
  const key = providerDescriptor(providerForBackendId(backendId)).accountsKey;
  if (key === null) throw new Error(`${backendId} has no accounts`);
  return key as ProviderAccountsKey;
}

/**
 * A provider's accounts out of the shared settings' lists, by its backend id
 * (`secrets[accountsKey]`). Empty while the list is absent.
 */
export function accountsForBackend<T>(
  secrets: Partial<Record<ProviderAccountsKey, readonly T[]>> | null | undefined,
  backendId: string,
): readonly T[] {
  return secrets?.[accountsKeyForBackend(backendId)] ?? [];
}

/** Is any account of the provider with this backend id connected? */
export function backendHasConnectedAccount(
  secrets:
    | Partial<Record<ProviderAccountsKey, ReadonlyArray<{ connected: boolean }>>>
    | null
    | undefined,
  backendId: string,
): boolean {
  return accountsForBackend(secrets, backendId).some((a) => a.connected);
}

/** Every backend id that holds accounts, for schemas that list them. */
export const BACKEND_IDS = ACCOUNT_PROVIDERS.map((p) => p.backendId) as unknown as [
  AccountBackendId,
  ...AccountBackendId[],
];

/**
 * Every set of own settings Settings shows (spec/10 § Provider settings; decision
 * 9): each provider's from the table that has settings or a note, then each ACP
 * agent's that declares some, under `acp:<agent>`. Surfaces draw this list, and
 * the server checks a write against it, so neither names a provider.
 */
export function ownSettingsGroups(
  acpAgents: readonly AcpAgentConfig[] | undefined,
): OwnSettingsGroup[] {
  const out: OwnSettingsGroup[] = [];
  for (const p of PROVIDERS as readonly ProviderDescriptor[]) {
    if (p.settings.length === 0 && p.settingsNote === undefined) continue;
    out.push({
      id: p.id,
      label: p.label,
      settings: p.settings,
      ...(p.settingsNote !== undefined ? { note: p.settingsNote } : {}),
    });
  }
  for (const agent of resolveAcpAgents(acpAgents)) {
    if (!agent.ownSettings) continue;
    out.push({
      id: acpSettingsId(agent.id),
      label: agent.label,
      settings: agent.ownSettings.settings,
    });
  }
  return out;
}

/** A setting a provider declares, by its key; throws for one it does not. */
export function providerSettingDescriptor(
  providerId: string,
  key: string,
): ProviderSettingDescriptor {
  const s = providerDescriptor(providerId).settings.find((d) => d.key === key);
  if (!s) throw new Error(`${providerId} has no setting ${key}`);
  return s;
}
