// Settings → Voice → Voice devices → Add device (spec/16 § Pairing).
//
// A voice device is set up with Patch's address and a long-lived device token.
// The token is minted here and shown once; revoking the device in the list cuts
// it off. Any device that speaks the voice endpoint uses the same token, so
// there is nothing device-specific about this flow.

import type { JSX } from 'react';
import { useState } from 'react';
import { api } from '../api/rest.js';

/** Where the Voice PE firmware's web setup page lives. */
const VOICE_PE_SETUP_URL = 'https://patch-hq.github.io/patch-voice-pe/';

export function AddVoiceDevice({ onClose }: { onClose: () => void }): JSX.Element {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const server = window.location.origin;

  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.addVoiceDevice(label.trim());
      setToken(res.token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
  };

  return (
    <div className="set-pair" data-testid="voice-device-add-panel">
      {token === null ? (
        <>
          <label className="set-field">
            <span className="set-row-title">Name</span>
            <input
              data-testid="voice-device-label"
              placeholder="Kitchen"
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          {error ? (
            <p className="set-error" data-testid="voice-device-add-error">
              {error}
            </p>
          ) : null}
          <div className="set-actions">
            <button
              type="button"
              className="set-btn"
              data-testid="voice-device-add-submit"
              disabled={busy || label.trim().length === 0}
              onClick={() => void add()}
            >
              Create token
            </button>
            <button
              type="button"
              className="set-btn"
              data-testid="voice-device-add-close"
              onClick={onClose}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="set-sub">
            Set the device up with this server address and token. The token is shown only now.
          </p>
          <code className="set-code" data-testid="voice-device-server">
            {server}
          </code>
          <code className="set-code" data-testid="voice-device-token">
            {token}
          </code>
          <p className="set-sub">
            For a Home Assistant Voice PE, open the{' '}
            <a href={VOICE_PE_SETUP_URL} target="_blank" rel="noreferrer">
              setup page
            </a>
            .
          </p>
          <div className="set-actions">
            <button
              type="button"
              className="set-btn"
              data-testid="voice-device-token-copy"
              onClick={() => void copy()}
            >
              {copied ? 'Copied' : 'Copy token'}
            </button>
            <button
              type="button"
              className="set-btn"
              data-testid="voice-device-add-close"
              onClick={onClose}
            >
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
}
