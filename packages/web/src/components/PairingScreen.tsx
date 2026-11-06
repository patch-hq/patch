// PairingScreen — shown when no credential is stored. The web surface signs in
// by APPROVAL from a device that is already signed in: on mount it asks
// (`POST /api/auth/signin/request`), every signed-in surface pops up an Allow /
// Deny prompt, and Allow shows a six-digit code that is typed here and
// redeemed for a credential — like signing in to an Apple device.
//
// The very first sign-in has no other device to ask, so a credential token (a
// JWT from `patch auth bootstrap`, or `patch pair` on a linked host) can
// still be pasted. It is validated for shape (isWellFormedCredential) and
// persisted to localStorage.
//
// The QR flow (`patch-pair://<host>?nonce=…`) is how the MOBILE surface enrols
// by scanning — see apps/mobile/app/pair.tsx and
// packages/web/src/components/LinkDeviceQr.tsx.

import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/rest.js';
import { deviceLabel } from '../lib/deviceLabel.js';
import { isWellFormedCredential, saveCredential } from '../lib/credential.js';
import { shortcutLabel } from '../lib/shortcuts.js';
import { isSubmitChord } from '../lib/submitChord.js';

export function PairingScreen({
  onPaired,
  rejectedReason,
}: {
  onPaired(): void;
  /**
   * Set when the server REJECTED the credential this surface was holding, as
   * opposed to there never having been one. Without this the screen appears
   * mid-session with no explanation, which reads as the app losing your work.
   */
  rejectedReason?: string;
}): JSX.Element {
  const [jwt, setJwt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<
    | { phase: 'asking' }
    | { phase: 'waiting'; id: string; secret: string }
    | { phase: 'ended'; reason: string }
    | { phase: 'unavailable'; reason: string }
  >({ phase: 'asking' });
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const started = useRef(-1);

  // Ask once per attempt. (The guard keeps a double-mounted effect from filing two.)
  useEffect(() => {
    if (started.current === attempt) return;
    started.current = attempt;
    setAsked({ phase: 'asking' });
    setCode('');
    setCodeError(null);
    api
      .signInRequest(deviceLabel())
      .then((r) => setAsked({ phase: 'waiting', id: r.id, secret: r.secret }))
      .catch((e: unknown) =>
        setAsked({
          phase: 'unavailable',
          reason:
            e instanceof ApiError && e.status === 400
              ? 'There is no account on this server yet, so there is no device to ask. Use a credential token.'
              : `Could not ask your other devices: ${(e as Error).message}`,
        }),
      );
  }, [attempt]);

  // Hear that it was denied or lapsed.
  const waitingId = asked.phase === 'waiting' ? asked.id : null;
  const waitingSecret = asked.phase === 'waiting' ? asked.secret : null;
  useEffect(() => {
    if (waitingId === null || waitingSecret === null) return;
    const t = setInterval(() => {
      api
        .signInState(waitingId, waitingSecret)
        .then((r) => {
          if (r.state === 'denied') setAsked({ phase: 'ended', reason: 'The sign-in was denied.' });
          else if (r.state === 'expired') {
            setAsked({ phase: 'ended', reason: 'The request timed out.' });
          }
        })
        .catch((e: unknown) =>
          setAsked({ phase: 'ended', reason: `Lost the request: ${(e as Error).message}` }),
        );
    }, 2000);
    return () => clearInterval(t);
  }, [waitingId, waitingSecret]);

  async function redeem(): Promise<void> {
    if (asked.phase !== 'waiting' || code.trim().length === 0) return;
    setRedeeming(true);
    setCodeError(null);
    try {
      const r = await api.signInRedeem(asked.id, asked.secret, code.trim());
      saveCredential(r.credential);
      onPaired();
    } catch (e) {
      const reason =
        e instanceof ApiError && typeof e.body === 'object' && e.body !== null
          ? (e.body as { error?: string }).error
          : undefined;
      if (reason === 'wrong_code') setCodeError('That code is not right. Try again.');
      else if (reason === 'not_approved')
        setCodeError('Allow the sign-in on your other device first.');
      else if (reason === 'locked' || reason === 'denied') {
        setAsked({ phase: 'ended', reason: 'Too many wrong codes. Ask again.' });
      } else if (reason === 'expired' || reason === 'unknown') {
        setAsked({ phase: 'ended', reason: 'The request timed out.' });
      } else setCodeError((e as Error).message);
    } finally {
      setRedeeming(false);
    }
  }

  /** The one sign-in path — Continue's and `⌘↵`'s (spec/14 § Keyboard shortcuts). */
  function submit(): void {
    const v = jwt.trim();
    if (v.length === 0) return;
    if (!isWellFormedCredential(v)) {
      setError(
        'That doesn’t look like a credential token. A token is a long JWT starting with “eyJ”. If you pasted a short pairing code, that’s the wrong value.',
      );
      return;
    }
    saveCredential(v);
    onPaired();
  }
  return (
    <main className="pairing-screen" data-testid="pairing-screen">
      <div className="pairing-window-drag" data-testid="pairing-window-drag" aria-hidden="true" />
      <h1 className="display">patch</h1>
      {rejectedReason !== undefined ? (
        <p className="pairing-signed-out" data-testid="pairing-signed-out" role="status">
          This surface was signed out. The server no longer accepts its credential, so sign in again
          below.
        </p>
      ) : null}
      {asked.phase === 'asking' ? (
        <p data-testid="signin-asking">Asking your other devices…</p>
      ) : null}
      {asked.phase === 'waiting' ? (
        <div data-testid="signin-waiting">
          <p>
            Allow this sign-in on a device that is already signed in to Patch, then type the code it
            shows.
          </p>
          <input
            className="pairing-code-input"
            data-testid="signin-code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            value={code}
            autoFocus
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, ''));
              if (codeError !== null) setCodeError(null);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              void redeem();
            }}
          />
          {codeError !== null ? (
            <p className="pairing-error" data-testid="signin-code-error" role="alert">
              {codeError}
            </p>
          ) : null}
          <button
            type="button"
            data-testid="signin-redeem"
            disabled={code.length !== 6 || redeeming}
            onClick={() => void redeem()}
          >
            Sign in
          </button>
        </div>
      ) : null}
      {asked.phase === 'ended' || asked.phase === 'unavailable' ? (
        <div data-testid="signin-ended">
          <p className="pairing-error" role="alert">
            {asked.reason}
          </p>
          {asked.phase === 'ended' ? (
            <button
              type="button"
              data-testid="signin-retry"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Ask again
            </button>
          ) : null}
        </div>
      ) : null}
      <details className="pairing-alt" open={asked.phase === 'unavailable'}>
        <summary>Use a credential token instead</summary>
        <p>
          Run <code>patch auth bootstrap</code> (very first sign-in) or <code>patch pair</code> on a
          linked host. It prints a long <strong>credential token</strong>, a JWT starting with{' '}
          <code>eyJ…</code>. Paste it below. (Not the short <em>pairing code</em>, which authorises
          a host, not a sign-in.)
        </p>
        <textarea
          className="pairing-input"
          data-testid="pairing-input"
          placeholder="paste credential token (starts with eyJ…)"
          value={jwt}
          onChange={(e) => {
            setJwt(e.target.value);
            if (error !== null) setError(null);
          }}
          onKeyDown={(e) => {
            if (!isSubmitChord(e)) return;
            e.preventDefault();
            submit();
          }}
          rows={4}
        />
        {error !== null ? (
          <p className="pairing-error" data-testid="pairing-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          data-testid="pairing-submit"
          disabled={jwt.trim().length === 0}
          title={shortcutLabel('⌘↵')}
          onClick={submit}
        >
          Continue
        </button>
      </details>
    </main>
  );
}
