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
import { LOCAL_BACKEND_ID } from './localModels.js';

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
  /** The run option that carries a reseed of Patch's history into a fresh session; null = none. */
  readonly reseedOption: 'codexReseed' | 'localReseed' | null;
  /** The run option that appends items to an existing session on a provider switch; null = none. */
  readonly appendOption: 'codexAppendItems' | null;
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
    reseedOption: null,
    appendOption: null,
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
    reseedOption: 'codexReseed',
    appendOption: 'codexAppendItems',
    signedOutMessage: (_hostId, reason) => reason,
  },
  // A local endpoint has no account, no quota and no status model of its own.
  local: {
    backendId: LOCAL_BACKEND_ID,
    resolvesPermissionModeByModel: false,
    generatesStatus: false,
    rateLimitSweeps: false,
    turnRetrySafe: () => false,
    limitMustStateReset: false,
    ownsSessionFile: false,
    sessionBoundToAccount: false,
    detachedTurnRunner: false,
    hostCreditAggregate: false,
    sessionMovable: false,
    reseedOption: 'localReseed',
    appendOption: null,
    signedOutMessage: (_hostId, reason) => reason,
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
