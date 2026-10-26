// A provider-stated account limit, as the backends now report it: structured
// facts on the failure, never a sentence for Patch to match.
import { TurnFailedError, type LimitFacts } from '../src/sdkBackend.js';

export const REJECTED: LimitFacts = { kind: 'rate_limit', status: 'rejected' };

export function limitError(message: string, extra: LimitFacts = {}): TurnFailedError {
  return new TurnFailedError(message, { ...REJECTED, ...extra });
}
