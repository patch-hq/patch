// SpeechSetupModal — shown when the first meeting on a host finds no speech
// set up. Two routes, both chosen by the user: a cloud speech key, or the local
// voice models downloaded onto that host. Either one makes meetings work, and
// the meeting that was refused is started again as soon as it does.

import { useEffect, useState, type JSX } from 'react';
import { api } from '../api/rest.js';
import { startMeeting } from '../lib/meetingControl.js';
import { sendToHost } from '../routes/settings/hostWrite.js';
import { hostLabel } from '../routes/settings/hostScope.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useSpeechSetupStore } from '../stores/speechSetupStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { ModalOverlay } from './ModalOverlay.js';

/** The components the local route downloads (about 1.9 GB together). */
const LOCAL_COMPONENTS = ['whisper', 'kokoro'] as const;

export function SpeechSetupModal(): JSX.Element | null {
  const request = useSpeechSetupStore((s) => s.request);
  const close = useSpeechSetupStore((s) => s.close);
  const host = usePresenceStore((s) => (request ? (s.hosts[request.hostId] ?? null) : null));
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const components = host?.host?.components ?? [];
  const whisper = components.find((c) => c.id === 'whisper');
  const localBytes = components
    .filter((c) => (LOCAL_COMPONENTS as readonly string[]).includes(c.id))
    .reduce((n, c) => n + c.bytes, 0);
  const localGb = (localBytes / 1_000_000_000).toFixed(1);
  const progress = LOCAL_COMPONENTS.map((id) => components.find((c) => c.id === id)).filter(
    (c) => c !== undefined,
  );
  const overall =
    progress.length === 0
      ? 0
      : progress.reduce(
          (n, c) => n + (c.state === 'installed' ? 1 : (c.progress ?? 0)) * c.bytes,
          0,
        ) /
        Math.max(
          1,
          progress.reduce((n, c) => n + c.bytes, 0),
        );
  const failed = progress.find((c) => c.state === 'failed');

  // The local route is done when the speech model is installed on the host.
  useEffect(() => {
    if (!request || !downloading || whisper?.state !== 'installed') return;
    const { chatId } = request;
    close();
    setDownloading(false);
    void startMeeting(chatId);
  }, [request, downloading, whisper?.state, close]);

  useEffect(() => {
    if (!request) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, close]);

  if (!request) return null;
  const name = host ? hostLabel(host) : 'this host';

  async function saveKey(): Promise<void> {
    const value = key.trim();
    if (value === '' || !request) return;
    setBusy(true);
    try {
      await api.setProviderKey('groq', value);
      const { chatId } = request;
      setKey('');
      close();
      void startMeeting(chatId);
    } catch (err) {
      useUiStore.getState().pushError(`Could not save the speech key: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function download(): void {
    if (!host) return;
    let sent = false;
    for (const id of LOCAL_COMPONENTS) {
      const c = components.find((x) => x.id === id);
      if (c?.state === 'installed' || c?.state === 'downloading') continue;
      sent =
        sendToHost(host, {
          type: 'host.component_install',
          hostId: host.hostId,
          componentId: id,
        }) || sent;
    }
    setDownloading(sent || progress.some((c) => c.state === 'downloading'));
  }

  return (
    <ModalOverlay testId="speech-setup-overlay">
      <div className="modal-backdrop" data-testid="speech-setup-backdrop" onClick={close} />
      <div
        className="modal-card confirm-modal"
        data-testid="speech-setup"
        role="dialog"
        aria-modal="true"
        aria-label="Set up speech"
      >
        <h2 className="modal-title">Meetings need speech set up on {name}</h2>
        <p className="modal-message">Choose one. The meeting starts once it is ready.</p>
        <p className="modal-message">Add a speech API key (Groq)</p>
        <input
          type="password"
          className="modal-input"
          data-testid="speech-setup-key"
          placeholder="Groq API key"
          value={key}
          disabled={busy || downloading}
          onChange={(e) => setKey(e.target.value)}
        />
        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn primary-btn"
            data-testid="speech-setup-save-key"
            disabled={busy || downloading || key.trim() === ''}
            onClick={() => void saveKey()}
          >
            Save key
          </button>
        </div>
        <p className="modal-message">
          Or download the local voice models (about {localGb} GB on {name})
        </p>
        {downloading ? (
          <p className="modal-message" data-testid="speech-setup-progress">
            Downloading {Math.round(overall * 100)}%
          </p>
        ) : null}
        {failed ? (
          <p className="modal-message" data-testid="speech-setup-failed">
            {failed.label} failed: {failed.error ?? 'download failed'}
          </p>
        ) : null}
        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn"
            data-testid="speech-setup-cancel"
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn primary-btn"
            data-testid="speech-setup-download"
            disabled={busy || downloading || !host}
            onClick={download}
          >
            Download models
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
