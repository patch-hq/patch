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
  isEndpointModel,
  providerForModel,
  providerForSessionId,
  type HarnessId,
  type PermissionMode,
} from '@patch/wire';
import { CodexTurnError } from './codexBackend.js';
import { CODEX_BACKEND_ID } from './codexAccounts.js';
import { ACP_BACKEND_ID } from './acpRegistry.js';
import { AcpLimitError } from './acpBackend.js';

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
  /** Does Patch prepare and read the provider's session file under the chat's own config dir? */
  readonly ownsSessionFile: boolean;
  /** Is a session bound to the account that made it, so an account switch needs a rebuild? */
  readonly sessionBoundToAccount: boolean;
  /** Does a turn run in a detached runner process the host reattaches to (spec/02 § Host restarts)? */
  readonly detachedTurnRunner: boolean;
  /** Does the host-wide out-of-credit aggregate describe this provider's accounts? */
  readonly hostCreditAggregate: boolean;
  /** Can a chat's session move to another host with the chat? */
  readonly sessionMovable: boolean;
  /** Does the host build this provider's account report itself, rather than a bare connected flag? */
  readonly buildsAccountReport: boolean;
  /** What a turn refused for want of a sign-in says. `reason` is the credential check's own. */
  readonly signedOutMessage: (hostId: string, reason: string) => string;
}

export const HARNESS_TRAITS: Record<HarnessId, HarnessTraits> = {
  claude: {
    backendId: CLAUDE_BACKEND_ID,
    resolvesPermissionModeByModel: true,
    generatesStatus: true,
    rateLimitSweeps: true,
    turnRetrySafe: () => true,
    limitMustStateReset: false,
    ownsSessionFile: true,
    sessionBoundToAccount: true,
    detachedTurnRunner: true,
    hostCreditAggregate: true,
    sessionMovable: true,
    buildsAccountReport: true,
    signedOutMessage: (hostId) =>
      `${hostId} isn't signed in to Claude, so this turn can't run. Sign in from Settings → Hosts.`,
  },
  codex: {
    backendId: CODEX_BACKEND_ID,
    resolvesPermissionModeByModel: false,
    generatesStatus: false,
    rateLimitSweeps: false,
    turnRetrySafe: (err) => err instanceof CodexTurnError && err.retrySafe,
    limitMustStateReset: true,
    ownsSessionFile: false,
    sessionBoundToAccount: false,
    detachedTurnRunner: true,
    hostCreditAggregate: false,
    sessionMovable: false,
    buildsAccountReport: false,
    signedOutMessage: (_hostId, reason) => reason,
  },
  // An ACP agent (acpBackend.ts): its turn runs under the detached runner, its
  // session is the agent's own and stays where the agent keeps it, and its
  // credential is a provider key or the agent's own sign-in.
  acp: {
    backendId: ACP_BACKEND_ID,
    resolvesPermissionModeByModel: false,
    generatesStatus: false,
    rateLimitSweeps: false,
    // A limit refused before any tool ran can run again on the agent's next account.
    turnRetrySafe: (err) => err instanceof AcpLimitError && err.retrySafe,
    // An agent's limit error states no reset: it fails visibly rather than parking.
    limitMustStateReset: true,
    ownsSessionFile: false,
    sessionBoundToAccount: false,
    detachedTurnRunner: true,
    hostCreditAggregate: false,
    sessionMovable: false,
    buildsAccountReport: false,
    signedOutMessage: (_hostId, reason) => reason,
  },
};

/**
 * A Claude chat on a model endpoint (spec/02 § Provider adapters) runs on no
 * Claude account, so nothing account-shaped applies to it, and its status line
 * is not generated on a Claude small-job model the user did not choose.
 */
const CLAUDE_ON_ENDPOINT: HarnessTraits = {
  ...HARNESS_TRAITS.claude,
  generatesStatus: false,
  rateLimitSweeps: false,
  turnRetrySafe: () => false,
  sessionBoundToAccount: false,
  hostCreditAggregate: false,
};

export function harnessTraitsForModel(model: string | null | undefined): HarnessTraits {
  const harness = providerForModel(model);
  return harness === 'claude' && isEndpointModel(model)
    ? CLAUDE_ON_ENDPOINT
    : HARNESS_TRAITS[harness];
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
