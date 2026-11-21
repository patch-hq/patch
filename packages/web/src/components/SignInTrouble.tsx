// The way out of a sign-in that did not come back, the same under every
// provider: try the sign-in again, or use an API key instead.

import type { JSX, ReactNode } from 'react';
import { useState } from 'react';

export function SignInTrouble({
  onRetry,
  apiKey,
  testId,
  happened,
}: {
  onRetry: () => void;
  /** What has gone wrong so far, in words: shown once the options open. */
  happened: string;
  apiKey?: ReactNode;
  testId: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className="set-btn ghost"
        data-testid={`${testId}-trouble`}
        onClick={() => setOpen(true)}
      >
        Trouble signing in?
      </button>
    );
  }
  return (
    <div className="set-inline" data-testid={`${testId}-trouble-options`}>
      <span className="set-sub" data-testid={`${testId}-trouble-reason`}>
        {happened}
      </span>
      <button
        type="button"
        className="set-btn ghost"
        data-testid={`${testId}-retry`}
        onClick={onRetry}
      >
        Try again
      </button>
      {apiKey}
    </div>
  );
}
