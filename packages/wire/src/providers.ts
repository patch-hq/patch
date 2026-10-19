// The provider registry (spec/02 § Agent backends).
//
// A provider is an agent harness a chat can run on. EVERYTHING a surface or the
// host needs to know about one that is a plain fact — its id, how its models
// are named, which permission modes it can run, how its native session ids
// look — lives in one entry of PROVIDERS. Adding a provider is one entry here
// plus its backend registered with the daemon's harness registry
// (`packages/host/src/harnesses.ts`); no other file names a provider.
//
// Model routing: a provider claims a model by `modelPrefix` (`openai/gpt-5`).
// The one provider with no prefix (`claude`) is the default for any model no
// prefix claims, so every model Anthropic releases from here on works unedited.

import type { PermissionMode } from './events.js';

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
  /**
   * Slash commands the provider's own CLI handles itself (`/context`, `/help`).
   * The provider intercepts these before any skill of the same name, so Patch
   * refuses to offer a colliding skill. Excludes Patch's own `/clear` and
   * `/goal`, which Patch handles before the provider sees them.
   */
  readonly builtinCommands: readonly string[];
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
  },
  {
    id: 'codex',
    label: 'Codex',
    modelPrefix: 'openai/',
    sessionIdPrefix: 'codex-',
    // Codex has no classifier-driven approval, so no `auto`.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
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
