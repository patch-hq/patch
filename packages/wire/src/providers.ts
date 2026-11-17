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
}

export type ProviderCapability = keyof ProviderCapabilities;

/**
 * One of a provider's OWN settings (spec/10 § Provider settings): a value the
 * provider itself reads from its own configuration, such as how long it keeps
 * a session. Patch shows it and writes the user's choice through; it never
 * sets one the user has not chosen.
 */
export interface ProviderSettingDescriptor {
  /** The key in the provider's own configuration file, and in `providerSettings`. */
  readonly key: string;
  readonly label: string;
  /** One line saying what the setting does, in the provider's terms. */
  readonly description: string;
  /** A whole number of days. */
  readonly kind: 'days';
  readonly min: number;
  readonly max: number;
  /** What the provider does while the setting is absent from its configuration. */
  readonly providerDefault: number;
}

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
   * (a local model server): it has no credential store, strategy or usage.
   */
  readonly accountsKey: string | null;
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
  /** The provider's own settings Settings exposes (spec/10 § Provider settings). */
  readonly settings: readonly ProviderSettingDescriptor[];
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
    capabilities: {
      resume: true,
      editAtMessage: true,
      rewind: true,
      branchAtTurn: true,
      disableNativeTools: true,
      interrupt: true,
      steer: false,
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
      },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    modelPrefix: 'openai/',
    sessionIdPrefix: 'codex-',
    // Codex has no classifier-driven approval, so no `auto`.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    backendId: 'codex',
    accountsKey: 'codex',
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
    capabilities: {
      resume: true,
      editAtMessage: true,
      rewind: false,
      branchAtTurn: true,
      disableNativeTools: false,
      interrupt: true,
      steer: true,
    },
    settings: [],
  },
  {
    id: 'local',
    label: 'Local model',
    modelPrefix: 'local/',
    sessionIdPrefix: 'local-',
    // No classifier-driven approval, so no `auto` (openaiCompatPermission refuses it).
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    backendId: 'local',
    accountsKey: null,
    aliases: ['ollama', 'llamacpp', 'lmstudio'],
    supportsEffort: false,
    loginRequiredCode: 'local_endpoint_missing',
    builtinCommands: [],
    capabilities: {
      resume: true,
      editAtMessage: false,
      rewind: false,
      branchAtTurn: false,
      disableNativeTools: false,
      interrupt: true,
      steer: false,
    },
    settings: [],
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
 * The Patch tools that replace something a provider also offers natively:
 * subagents (`patch_agent`), self-wakes and loops, and goals (principles.md
 * § Patch-owned state). A chat gets one version of each, never both.
 */
export const PATCH_TOOLS_REPLACING_NATIVE: readonly string[] = [
  'patch_agent',
  'patch_wake_me',
  'patch_loop',
  'patch_wake_status',
  'patch_cancel_wake',
  'patch_goal_set',
  'patch_goal_get',
  'patch_goal_clear',
];

/**
 * The Patch tools withheld from a chat on this model. Where the provider can
 * switch its native equivalents off (`disableNativeTools`) Patch's versions are
 * offered; where it cannot, the native ones stay and Patch's are withheld so the
 * agent never sees two tools that do the same thing.
 */
export function patchToolsOmittedFor(model: string | null | undefined): readonly string[] {
  return modelHasCapability(model, 'disableNativeTools') ? [] : PATCH_TOOLS_REPLACING_NATIVE;
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

/** Every backend id that holds accounts, for schemas that list them. */
export const BACKEND_IDS = ACCOUNT_PROVIDERS.map((p) => p.backendId) as unknown as [
  AccountBackendId,
  ...AccountBackendId[],
];

/** A setting a provider declares, by its key; throws for one it does not. */
export function providerSettingDescriptor(
  providerId: string,
  key: string,
): ProviderSettingDescriptor {
  const s = providerDescriptor(providerId).settings.find((d) => d.key === key);
  if (!s) throw new Error(`${providerId} has no setting ${key}`);
  return s;
}
