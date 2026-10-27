// The host's harness registry (spec/02 § Agent backends).
//
// `@patch/wire`'s PROVIDERS table holds the plain facts about a provider (id,
// model prefix, permission modes). This holds the host-side behaviour that
// differs between them. It is a Record over every ProviderId, so adding a
// provider to PROVIDERS fails the build here until its traits are written —
// chatRunner never branches on a provider by name, it reads these.

import {
  CLAUDE_BACKEND_ID,
  HARNESS_PERMISSION_MODES,
  providerForModel,
  providerForSessionId,
  type HarnessId,
  type PermissionMode,
} from '@patch/wire';
import { CodexTurnError } from './codexBackend.js';
import { CODEX_BACKEND_ID } from './codexAccounts.js';

export interface HarnessTraits {
  /** The `backendId` this provider's credentials report under (`host.unauthenticated`). */
  readonly backendId: string;
  /** Does Patch resolve the chat's permission mode against the model (degrade rule)? */
  readonly resolvesPermissionModeByModel: boolean;
  /** Does the host auto-generate the chat's status line on this provider? */
  readonly generatesStatus: boolean;
  /** Is the parked-turn rate-limit resume sweep this provider's to run? */
  readonly rateLimitSweeps: boolean;
  /** May a failed turn be retried on another account? A provider that cannot say answers per error. */
  readonly turnRetrySafe: (err: unknown) => boolean;
  /** Must a limit failure STATE when it lifts before the turn is parked for auto-resume? */
  readonly limitMustStateReset: boolean;
}

export const HARNESS_TRAITS: Record<HarnessId, HarnessTraits> = {
  claude: {
    backendId: CLAUDE_BACKEND_ID,
    resolvesPermissionModeByModel: true,
    generatesStatus: true,
    rateLimitSweeps: true,
    turnRetrySafe: () => true,
    limitMustStateReset: false,
  },
  codex: {
    backendId: CODEX_BACKEND_ID,
    resolvesPermissionModeByModel: false,
    generatesStatus: false,
    rateLimitSweeps: false,
    turnRetrySafe: (err) => err instanceof CodexTurnError && err.retrySafe,
    limitMustStateReset: true,
  },
};

export function harnessTraitsForModel(model: string | null | undefined): HarnessTraits {
  return HARNESS_TRAITS[providerForModel(model)];
}

/**
 * Can the model's provider run this mode at all? (The per-model refinement is
 * `permissionModesFor`; this is the provider-level table a chat is stamped from.)
 */
export function harnessModesInclude(
  model: string | null | undefined,
  mode: PermissionMode,
): boolean {
  return HARNESS_PERMISSION_MODES[providerForModel(model)].includes(mode);
}

export { providerForModel as harnessOfModel, providerForSessionId as harnessOfSessionId };
