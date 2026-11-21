// The way out of a sign-in that did not come back, the same under every
// provider: try the sign-in again, or use an API key instead.

import type { JSX, ReactNode } from 'react';
import { useState } from 'react';

export function SignInTrouble({
  onRetry,
  apiKey,
  testId,
}: {
  onRetry: () => void;
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
      <p className="set-note" data-testid={`${testId}-trouble-help`}>
        The sign-in did not finish. Try again for a fresh sign-in, or use an API key instead.
      </p>
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
