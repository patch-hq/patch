// Sign in to ChatGPT from any surface, with no terminal and no host involved
// (spec/10 § Signing in). The server asks OpenAI for a device code and keeps it;
// this shows the code and the address, and watches the server until the person
// has approved on any device. That makes it the sign-in for a headless host's
// owner too: approve on a phone, and every host picks the login up.

import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { api, type ChatGPTSignInStarted } from '../api/rest.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { problemText } from '../routes/settings/sharedWrite.js';

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting'; started: ChatGPTSignInStarted };

export function ChatGPTSignIn({
  accountId,
  label,
  onDone,
  primary = false,
}: {
  /** Sign this row in again rather than adding an account. */
  accountId?: string;
  label?: string;
  onDone?: () => void;
  primary?: boolean;
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
      setPhase({ kind: 'waiting', started });
    } catch (e) {
      setError(problemText(e));
      setPhase({ kind: 'idle' });
    }
  };

  if (phase.kind !== 'waiting') {
    return (
      <div className="chatgpt-signin" data-testid="chatgpt-signin-box">
        <button
          type="button"
          className={`set-btn${primary ? ' primary' : ''}`}
          data-testid="chatgpt-signin"
          disabled={phase.kind === 'starting'}
          onClick={() => void start()}
        >
          Sign in with ChatGPT
        </button>
        {error ? (
          <p className="set-error" role="alert" data-testid="chatgpt-login-error">
            {error}
          </p>
        ) : null}
      </div>
    );
  }
  const { started } = phase;
  return (
    <div className="set-inline" role="status" data-testid="chatgpt-login-pending">
      <span className="set-row-title">
        Open the sign-in page on any device, enter this code, and come back here.
      </span>
      <code className="set-code" data-testid="chatgpt-login-code">
        {started.userCode}
      </code>
      <a
        className="set-btn"
        href={started.url}
        target="_blank"
        rel="noreferrer"
        data-testid="chatgpt-login-open"
      >
        Open sign-in
      </a>
      <button
        type="button"
        className="set-btn ghost"
        data-testid="chatgpt-login-cancel"
        onClick={() => {
          void api.chatgptSignInCancel(started.signInId).catch(() => undefined);
          setPhase({ kind: 'idle' });
        }}
      >
        Cancel sign-in
      </button>
      {warning ? (
        <p className="set-error" role="status">
          {warning}
        </p>
      ) : null}
    </div>
  );
}
