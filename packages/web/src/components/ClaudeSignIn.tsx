// Sign in to Claude from any surface, with no terminal (spec/10 § Signing in to
// Claude from a surface). The server starts the sign-in and keeps its secret;
// this opens claude.ai in the person's own browser, where they sign in and are
// shown a code, and takes that code back. When the browser is on the same
// machine as the server, claude.ai sends the code straight to the server and
// this just waits for it. Used by Settings and by the welcome
// steps after the desktop app's first run.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../api/rest.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { problemText } from '../routes/settings/sharedWrite.js';

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; signInId: string; url: string; mode: 'loopback' | 'code' }
  | { kind: 'finishing'; signInId: string; url: string; mode: 'loopback' | 'code' };

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

  const signInId = phase.kind === 'waiting' ? phase.signInId : null;
  const loopbackWait = phase.kind === 'waiting' && phase.mode === 'loopback';
  // A same-machine sign-in finishes on the server by itself: ask until it has.
  useEffect(() => {
    if (!signInId || !loopbackWait) return;
    let stop = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await api.claudeSignInStatus(signInId);
        if (stop || r.status === 'waiting') return;
        if (r.status === 'failed') {
          setError(r.message);
          setPhase({ kind: 'idle' });
          return;
        }
        usePreferencesStore.getState().apply(await api.sharedSettings());
        if (stop) return;
        setPhase({ kind: 'idle' });
        onDone?.();
      } catch (e) {
        if (stop) return;
        setError(problemText(e));
        setPhase({ kind: 'idle' });
      }
    };
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [signInId, loopbackWait, onDone]);

  const start = async (): Promise<void> => {
    setError(null);
    setPhase({ kind: 'starting' });
    try {
      const { signInId, url, mode } = await api.claudeSignInStart({
        ...(label ? { label } : {}),
        ...(accountId ? { accountId } : {}),
      });
      // A new window is the person's own browser (desktop link policy), where
      // they are already signed in to claude.ai if they ever have been.
      window.open(url, '_blank', 'noopener');
      setCode('');
      setPhase({ kind: 'waiting', signInId, url, mode });
    } catch (e) {
      setError(problemText(e));
      setPhase({ kind: 'idle' });
    }
  };

  const finish = async (): Promise<void> => {
    if (phase.kind !== 'waiting') return;
    setError(null);
    setPhase({ kind: 'finishing', signInId: phase.signInId, url: phase.url, mode: phase.mode });
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
          : { kind: 'waiting', signInId: phase.signInId, url: phase.url, mode: phase.mode },
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

  const cancel = (): void => {
    if (phase.kind === 'waiting' && phase.mode === 'loopback') {
      void api.claudeSignInCancel(phase.signInId).catch(() => undefined);
    }
    setPhase({ kind: 'idle' });
    setError(null);
  };
  const reopen = (
    <a
      className="set-btn ghost"
      href={phase.url}
      target="_blank"
      rel="noreferrer"
      data-testid="claude-signin-reopen"
    >
      Open claude.ai again
    </a>
  );

  if (phase.mode === 'loopback') {
    return (
      <div className="claude-signin waiting" data-testid="claude-signin">
        <p className="claude-signin-label" data-testid="claude-signin-wait">
          Waiting for you to sign in at claude.ai…
        </p>
        <div className="set-inline">
          {reopen}
          <button
            type="button"
            className="set-btn ghost"
            data-testid="claude-signin-cancel"
            onClick={cancel}
          >
            Cancel
          </button>
        </div>
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
        {reopen}
        <button
          type="button"
          className="set-btn ghost"
          data-testid="claude-signin-cancel"
          disabled={busy}
          onClick={cancel}
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
