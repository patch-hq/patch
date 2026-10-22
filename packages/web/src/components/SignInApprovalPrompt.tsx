// SignInApprovalPrompt — the signed-in half of "sign in from another device".
// A new device asks; this pops up on every signed-in surface. Allow reveals a
// six-digit code to type on the new device, Deny turns it away.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { signInQuestion } from '@patch/wire';
import { api } from '../api/rest.js';
import { useSignInStore } from '../stores/signInStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';

export function SignInApprovalPrompt(): JSX.Element | null {
  const requests = useSignInStore((s) => s.requests);
  const surfaceId = usePresenceStore((s) => s.surfaceId);
  const [now, setNow] = useState(() => Date.now());
  const [shown, setShown] = useState<{ label: string; code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // What was asked while this surface was away: the live event is gone, the list is not.
  useEffect(() => {
    if (surfaceId === null) return;
    let cancelled = false;
    api
      .signInPending()
      .then((r) => {
        if (!cancelled) for (const req of r.requests) useSignInStore.getState().add(req);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(`Could not check for sign-in requests: ${(e as Error).message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [surfaceId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const current = requests.find((r) => r.expiresAt > now);

  async function answer(id: string, allow: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (allow) {
        const r = await api.signInApprove(id);
        setShown({ label: r.label, code: r.code });
      } else {
        await api.signInDeny(id);
      }
      useSignInStore.getState().remove(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (shown !== null) {
    return (
      <div
        className="signin-prompt"
        data-testid="signin-code"
        role="dialog"
        aria-label="sign-in code"
      >
        <p>
          Type this code on <strong>{shown.label}</strong>
        </p>
        <div className="signin-code" data-testid="signin-code-value">
          {shown.code}
        </div>
        <div className="signin-buttons">
          <button type="button" data-testid="signin-done" onClick={() => setShown(null)}>
            Done
          </button>
        </div>
      </div>
    );
  }
  if (current === undefined && error === null) return null;
  return (
    <div
      className="signin-prompt"
      data-testid="signin-prompt"
      role="dialog"
      aria-label="sign-in request"
    >
      {current !== undefined ? (
        <>
          <p>{signInQuestion(current.label)}</p>
          <div className="signin-buttons">
            <button
              type="button"
              className="deny"
              data-testid="signin-deny"
              disabled={busy}
              onClick={() => void answer(current.id, false)}
            >
              Deny
            </button>
            <button
              type="button"
              data-testid="signin-allow"
              disabled={busy}
              onClick={() => void answer(current.id, true)}
            >
              Allow
            </button>
          </div>
        </>
      ) : null}
      {error !== null ? (
        <p className="signin-error" data-testid="signin-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
