// Gemini CLI as the first ACP provider (spec/02 § Provider adapters).
//
// The agent is the user's own `gemini` install run in its ACP mode, so turns use
// the version, configuration and sign-in the user has in their terminal. Patch
// keeps no Gemini account and sets no API key: a host whose `gemini` is absent
// says so, and one that is signed out is told by the agent itself.

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { providerDescriptor } from '@patch/wire';
import { AcpBackend, type AcpAgentCommand } from './acpBackend.js';

const GEMINI = providerDescriptor('gemini');
export const GEMINI_BACKEND_ID = GEMINI.backendId;
export const GEMINI_SESSION_PREFIX = GEMINI.sessionIdPrefix!;
const GEMINI_MODEL_PREFIX = GEMINI.modelPrefix!;

export const isGeminiModel = (model?: string): boolean =>
  model?.startsWith(GEMINI_MODEL_PREFIX) === true;

/** The `gemini` executable on the host's PATH, or undefined. */
export function findGemini(pathVar: string | undefined = process.env['PATH']): string | undefined {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'gemini');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

export const GEMINI_MISSING =
  'The Gemini CLI is not installed on this host. Install it (npm install -g @google/gemini-cli), sign in by running gemini once, then try again.';

/** The command that starts Gemini in ACP mode for a model like `gemini/gemini-2.5-pro`. */
export function geminiCommand(
  model: string | undefined,
  executable = findGemini(),
): AcpAgentCommand {
  if (!executable) throw new Error(GEMINI_MISSING);
  const name = model?.startsWith(GEMINI_MODEL_PREFIX)
    ? model.slice(GEMINI_MODEL_PREFIX.length)
    : '';
  return { command: executable, args: ['--acp', ...(name ? ['--model', name] : [])] };
}

/** The models Gemini offers, as catalogue entries (`gemini/<model>`). */
export async function geminiModels(
  backend: AcpBackend,
  cwd: string,
): Promise<Array<{ id: string; label: string }>> {
  return (await backend.models(cwd)).map((m) => ({
    id: `${GEMINI_MODEL_PREFIX}${m.id}`,
    label: m.label,
  }));
}

export function makeGeminiBackend(): AcpBackend {
  return new AcpBackend({
    sessionPrefix: GEMINI_SESSION_PREFIX,
    resolveAgent: (opts) => geminiCommand(opts.model),
  });
}
