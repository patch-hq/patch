// Sign in to ChatGPT from any surface, with no terminal and no host involved
// (spec/10 § Signing in). The server asks OpenAI for a device code and keeps it;
// this shows the code and the address, and watches the server until the person
// has approved on any device. That makes it the sign-in for a headless host's
// owner too: approve on a phone, and every host picks the login up.

import type { JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { api, type ChatGPTSignInStarted } from '../api/rest.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { problemText } from '../routes/settings/sharedWrite.js';
import { SignInTrouble } from './SignInTrouble.js';

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; started: ChatGPTSignInStarted };

export function ChatGPTSignIn({
  accountId,
  label,
  onDone,
  primary = false,
  apiKey,
}: {
  /** Sign this row in again rather than adding an account. */
  accountId?: string;
  label?: string;
  onDone?: () => void;
  primary?: boolean;
  /** An API-key button: beside the sign-in until it starts, under "Trouble signing in?" after. */
  apiKey?: ReactNode;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const waitingId = phase.kind === 'waiting' ? phase.started.signInId : null;
  const interval = phase.kind === 'waiting' ? phase.started.intervalSeconds : 5;
  useEffect(() => {
    if (waitingId === null) return;
    const timer = setTimeout(
      () => {
        void (async () => {
          try {
            const res = await api.chatgptSignInStatus(waitingId);
            if (!live.current) return;
            if (res.status === 'complete') {
              usePreferencesStore.getState().apply(res.state);
              setPhase({ kind: 'idle' });
              onDone?.();
            } else if (res.status === 'failed') {
              setError(res.error);
              setPhase({ kind: 'idle' });
            } else {
              setWarning(res.warning ?? null);
              // Poll again: a new object re-runs this effect.
              setPhase((p) => (p.kind === 'waiting' ? { ...p } : p));
            }
          } catch (e) {
            if (!live.current) return;
            setError(problemText(e));
            // An expired sign-in cannot be finished; anything else can be looked at again.
            if ((e as { status?: number }).status === 410) setPhase({ kind: 'idle' });
            else setPhase((p) => (p.kind === 'waiting' ? { ...p } : p));
          }
        })();
      },
      Math.max(1, interval) * 1000,
    );
    return () => clearTimeout(timer);
  }, [waitingId, interval, phase, onDone]);

  const start = async (): Promise<void> => {
    setError(null);
    setWarning(null);
    setPhase({ kind: 'starting' });
    try {
      const started = await api.chatgptSignInStart({
        ...(accountId ? { accountId } : {}),
        ...(label ? { label } : {}),
      });
      // Like Claude: the person's own browser opens by itself.
      window.open(started.url, '_blank', 'noopener');
      setPhase({ kind: 'waiting', started });
    } catch (e) {
      setError(problemText(e));
      setPhase({ kind: 'idle' });
    }
  };

  if (phase.kind !== 'waiting') {
    return (
      <div className="chatgpt-signin" data-testid="chatgpt-signin-box">
        <div className="set-inline">
          <button
            type="button"
            className={`set-btn${primary ? ' primary' : ''}`}
            data-testid="chatgpt-signin"
            disabled={phase.kind === 'starting'}
            onClick={() => void start()}
          >
            Sign in with ChatGPT
          </button>
          {apiKey}
        </div>
        {error ? (
          <p className="set-error" role="alert" data-testid="chatgpt-login-error">
            {error}
          </p>
        ) : null}
      </div>
    );
  }
  const { started } = phase;
  const cancel = (): void => {
    void api.chatgptSignInCancel(started.signInId).catch(() => undefined);
    setPhase({ kind: 'idle' });
  };
  return (
    <div className="chatgpt-signin waiting" role="status" data-testid="chatgpt-login-pending">
      <p className="claude-signin-label">
        Waiting for you to sign in at ChatGPT… If asked, enter this code.
      </p>
      <code className="set-code" data-testid="chatgpt-login-code">
        {started.userCode}
      </code>
      <div className="set-inline">
        <a
          className="set-btn ghost"
          href={started.url}
          target="_blank"
          rel="noreferrer"
          data-testid="chatgpt-login-open"
        >
          Open ChatGPT again
        </a>
        <button
          type="button"
          className="set-btn ghost"
          data-testid="chatgpt-login-cancel"
          onClick={cancel}
        >
          Cancel
        </button>
        <SignInTrouble
          testId="chatgpt-signin"
          happened={error ?? 'ChatGPT has not confirmed the code yet.'}
          apiKey={apiKey}
          onRetry={() => {
            cancel();
            void start();
          }}
        />
      </div>
      {warning ? (
        <p className="set-error" role="status">
          {warning}
        </p>
      ) : null}
    </div>
  );
}
