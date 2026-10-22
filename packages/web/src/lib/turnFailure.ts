// A turn that failed partway through, said in words.
//
// The host reports the failure as free text (the provider's own sentence, often
// wrapped in an HTTP status). Most failures are worth a retry; one kind is not:
// when the input no longer fits the model's context window, sending the same
// conversation again fails the same way, so the bubble must say so instead of
// offering a bare "Tap to retry".
//
// Classified off the structured markers providers put in the error
// (`context_length_exceeded`, `rate_limit_exceeded`, HTTP status), with the
// wording of the common sentences as a second signal. Anything unrecognised is
// `unknown` and shown verbatim — never guessed into a friendlier category.

export type TurnFailureKind = 'context_length' | 'rate_limit' | 'auth' | 'network' | 'unknown';

export interface TurnFailureSummary {
  kind: TurnFailureKind;
  /** One plain sentence saying what happened and what to do. */
  headline: string;
  /** True when an unchanged retry is certain to fail the same way. */
  permanent: boolean;
}

const CONTEXT =
  /context_length_exceeded|exceeds the context window|maximum context length|prompt is too long|input is too long/i;
const RATE = /rate_limit|rate limit|\b429\b|too many requests/i;
const AUTH =
  /\b40[13]\b|invalid_api_key|authentication|unauthori[sz]ed|invalid x-api-key|permission_denied/i;
const NET =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network error|timed out/i;

export function classifyTurnFailure(message: string | undefined): TurnFailureSummary | undefined {
  if (message === undefined || message.trim() === '') return undefined;
  if (CONTEXT.test(message)) {
    return {
      kind: 'context_length',
      headline:
        'This conversation is too large for the model. Retrying unchanged will fail again — switch to a model with a larger context window, or start a new chat.',
      permanent: true,
    };
  }
  if (RATE.test(message)) {
    return {
      kind: 'rate_limit',
      headline: 'The provider is rate limiting requests. Retry in a little while.',
      permanent: false,
    };
  }
  if (AUTH.test(message)) {
    return {
      kind: 'auth',
      headline:
        "The provider rejected the credentials. Check the account's sign-in or API key before retrying.",
      permanent: false,
    };
  }
  if (NET.test(message)) {
    return {
      kind: 'network',
      headline: 'The connection to the provider failed. Retry once the network is back.',
      permanent: false,
    };
  }
  return { kind: 'unknown', headline: 'The turn failed.', permanent: false };
}
