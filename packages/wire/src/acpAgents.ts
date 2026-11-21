// Agent Client Protocol agents (spec/02 § Provider adapters).
//
// Every ACP agent runs through the one `acp` provider. An agent is DATA, not
// code: the command that starts it speaking ACP on stdio, a label, which of
// the shared provider keys (Settings → Providers) it reads from which
// environment variable, and the variable an ACP account's API key is passed in
// (Settings → AI accounts; spec/10 § Backend credentials). Patch ships the
// entries below; an account adds more, or replaces one by id, through the
// shared `acpAgents` setting.
//
// A model of an ACP agent is `acp/<agent id>/<the agent's own model id>`.

import { z } from 'zod';
import { ProviderKeyId } from './provider-keys.js';
import { OwnSetting } from './ownSettings.js';

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export const AcpAgentConfig = z
  .object({
    /** Stable id, part of every model and session id: lower-case letters and digits. */
    id: z.string().regex(/^[a-z0-9]{1,32}$/),
    /** How the agent is named on every screen. */
    label: z.string().min(1).max(64),
    /** The executable, found on the host's PATH or given as an absolute path. */
    command: z.string().min(1),
    /** Arguments that start it speaking ACP on stdio (Gemini CLI: `--acp`). */
    args: z.array(z.string()),
    /**
     * Environment variables the agent reads its credential from, each set from a
     * shared provider key (`{ "GEMINI_API_KEY": "gemini" }`). A key that is not
     * set leaves the variable to the agent's own sign-in.
     */
    keys: z.record(z.string().regex(ENV_NAME), ProviderKeyId).optional(),
    /**
     * The environment variable the agent reads an API key from, which a signed
     * in ACP account's key is passed in (`GEMINI_API_KEY`). It wins over a
     * shared provider key mapped to the same variable. Without one the agent
     * takes no account: it runs on its own sign-in on each host.
     */
    apiKeyEnv: z.string().regex(ENV_NAME).optional(),
    /**
     * The provider-key check that validates an account's key before the server
     * stores it (a free, read-only request; spec/10 § Signing in). Without one
     * a key is stored unchecked and the agent's own answer on the next turn or
     * probe says whether it works.
     */
    apiKeyCheck: ProviderKeyId.optional(),
    /**
     * The agent's OWN settings Settings exposes (spec/10 § Provider settings),
     * such as how long it keeps sessions, and the file it reads them from:
     * `file` under the home directory, or under `$<homeEnv>` where the agent
     * reads that variable instead. Only JSON files. Chosen values are kept
     * under `providerSettings['acp:<id>']`; an agent without this shows none.
     */
    ownSettings: z
      .object({
        file: z
          .string()
          .min(1)
          .refine(
            (f) => !f.startsWith('/') && !f.split('/').includes('..'),
            'a path under the home directory',
          ),
        homeEnv: z.string().regex(ENV_NAME).optional(),
        settings: z.array(OwnSetting).min(1),
      })
      .strict()
      .optional(),
    /**
     * The agent's own session mode for each Patch permission mode it has one
     * for. Without one, Patch answers the agent's permission requests itself
     * under that mode.
     */
    modes: z
      .object({
        default: z.string().min(1).optional(),
        acceptEdits: z.string().min(1).optional(),
        bypassPermissions: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AcpAgentConfig = z.infer<typeof AcpAgentConfig>;

/** The agents Patch knows without any configuration. */
export const BUILTIN_ACP_AGENTS: readonly AcpAgentConfig[] = [
  {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    args: ['--acp'],
    keys: { GEMINI_API_KEY: 'gemini' },
    apiKeyEnv: 'GEMINI_API_KEY',
    apiKeyCheck: 'gemini',
    // Gemini CLI's own session cleanup (`general.sessionRetention` in its
    // settings.json, gemini-cli 0.70): on by default, keeping 30 days, never
    // less than its own minimum of one day.
    ownSettings: {
      file: '.gemini/settings.json',
      homeEnv: 'GEMINI_CLI_HOME',
      settings: [
        {
          key: 'general.sessionRetention.enabled',
          label: 'Delete old sessions',
          description:
            'Gemini CLI deletes its own saved sessions once they are older than the age below.',
          kind: 'toggle',
          min: 0,
          max: 1,
          providerDefault: 1,
          write: { as: 'boolean' },
        },
        {
          key: 'general.sessionRetention.maxAge',
          label: 'Delete sessions after',
          description:
            "Gemini CLI deletes a saved session once it is this old. Patch's record of the chat is kept.",
          kind: 'days',
          min: 1,
          max: 3650,
          providerDefault: 30,
          write: { as: 'days-duration' },
        },
      ],
    },
    modes: { default: 'default', acceptEdits: 'autoEdit', bypassPermissions: 'yolo' },
  },
];

/** The built-in agents with the account's own entries applied (same id replaces). */
export function resolveAcpAgents(
  configured: readonly AcpAgentConfig[] | undefined,
): AcpAgentConfig[] {
  const byId = new Map<string, AcpAgentConfig>();
  for (const a of BUILTIN_ACP_AGENTS) byId.set(a.id, a);
  for (const a of configured ?? []) byId.set(a.id, a);
  return [...byId.values()];
}

/** The `providerSettings` key an ACP agent's own settings are kept under. */
export function acpSettingsId(agentId: string): string {
  return `acp:${agentId}`;
}

/**
 * Every set of own settings Settings shows (spec/10 § Provider settings): each
 * provider's from the table, then each ACP agent's that declares some. One list,
 * so surfaces and the server read the same thing and name no provider.
 */
export interface OwnSettingsGroup {
  /** The `providerSettings` key. */
  id: string;
  label: string;
  settings: readonly OwnSetting[];
  /** What the provider says when it has none Patch can expose. */
  note?: string;
}

export const ACP_MODEL_PREFIX = 'acp/';

/** `acp/<agent>/<model>` → its parts; undefined for any other model. */
export function parseAcpModel(
  model: string | null | undefined,
): { agentId: string; modelId: string } | undefined {
  if (!model?.startsWith(ACP_MODEL_PREFIX)) return undefined;
  const rest = model.slice(ACP_MODEL_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { agentId: rest.slice(0, slash), modelId: rest.slice(slash + 1) };
}

export function acpModelId(agentId: string, modelId: string): string {
  return `${ACP_MODEL_PREFIX}${agentId}/${modelId}`;
}
