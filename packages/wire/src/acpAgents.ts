// Agent Client Protocol agents (spec/02 § Provider adapters).
//
// Every ACP agent runs through the one `acp` provider. An agent is DATA, not
// code: the command that starts it speaking ACP on stdio, a label, and which
// of the shared provider keys (Settings → Providers) it reads from which
// environment variable. Patch ships the entries below; an account adds more,
// or replaces one by id, through the shared `acpAgents` setting.
//
// A model of an ACP agent is `acp/<agent id>/<the agent's own model id>`.

import { z } from 'zod';
import { ProviderKeyId } from './provider-keys.js';

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
    keys: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), ProviderKeyId).optional(),
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
