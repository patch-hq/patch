// Sign in to Claude from any surface, with no terminal (spec/10 § Signing in to
// Claude from a surface). The server starts the sign-in and keeps its secret;
// this opens claude.ai in the person's own browser, where they sign in and are
// shown a code, and takes that code back. Used by Settings and by the welcome
// steps after the desktop app's first run.

import type { JSX } from 'react';
import { useState } from 'react';
import { api } from '../api/rest.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { problemText } from '../routes/settings/sharedWrite.js';

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; signInId: string; url: string }
  | { kind: 'finishing'; signInId: string; url: string };

export function ClaudeSignIn({
  accountId,
  label,
  onDone,
  primary = false,
}: {
  /** Sign this row in again rather than adding an account. */
  accountId?: string;
  label?: string;
  onDone?: () => void;
  /** Draw the first button as the page's primary action. */
  primary?: boolean;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    setError(null);
    setPhase({ kind: 'starting' });
    try {
      const { signInId, url } = await api.claudeSignInStart();
      // A new window is the person's own browser (desktop link policy), where
      // they are already signed in to claude.ai if they ever have been.
      window.open(url, '_blank', 'noopener');
      setCode('');
      setPhase({ kind: 'waiting', signInId, url });
    } catch (e) {
      setError(problemText(e));
      setPhase({ kind: 'idle' });
    }
  };

  const finish = async (): Promise<void> => {
    if (phase.kind !== 'waiting') return;
    setError(null);
    setPhase({ kind: 'finishing', signInId: phase.signInId, url: phase.url });
    try {
      const state = await api.claudeSignInComplete({
        signInId: phase.signInId,
        code: code.trim(),
        ...(label ? { label } : {}),
        ...(accountId ? { accountId } : {}),
      });
      usePreferencesStore.getState().apply(state);
      setPhase({ kind: 'idle' });
      setCode('');
      onDone?.();
    } catch (e) {
      setError(problemText(e));
      const status = (e as { status?: number }).status;
      // An expired sign-in cannot be finished; anything else can be retried.
      setPhase(
        status === 410
          ? { kind: 'idle' }
          : { kind: 'waiting', signInId: phase.signInId, url: phase.url },
      );
    }
  };

  if (phase.kind === 'idle' || phase.kind === 'starting') {
    return (
      <div className="claude-signin" data-testid="claude-signin">
        <button
          type="button"
          className={`set-btn${primary ? ' primary' : ''}`}
          data-testid="claude-signin-start"
          disabled={phase.kind === 'starting'}
          onClick={() => void start()}
        >
          Sign in with Claude
        </button>
        {error ? (
          <p className="set-error" role="alert" data-testid="claude-signin-error">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const busy = phase.kind === 'finishing';
  return (
    <form
      className="claude-signin waiting"
      data-testid="claude-signin"
      onSubmit={(e) => {
        e.preventDefault();
        void finish();
      }}
    >
      <label className="claude-signin-label" htmlFor="claude-signin-code">
        Sign in at claude.ai, copy the code it shows, and paste it here.
      </label>
      <input
        id="claude-signin-code"
        type="text"
        className="set-input"
        data-testid="claude-signin-code"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        value={code}
        disabled={busy}
        onChange={(e) => setCode(e.target.value)}
      />
      <div className="set-inline">
        <button
          type="submit"
          className="set-btn primary"
          data-testid="claude-signin-finish"
          disabled={busy || code.trim() === ''}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <a
          className="set-btn ghost"
          href={phase.url}
          target="_blank"
          rel="noreferrer"
          data-testid="claude-signin-reopen"
        >
          Open claude.ai again
        </a>
        <button
          type="button"
          className="set-btn ghost"
          data-testid="claude-signin-cancel"
          disabled={busy}
          onClick={() => {
            setPhase({ kind: 'idle' });
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
      {error ? (
        <p className="set-error" role="alert" data-testid="claude-signin-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
