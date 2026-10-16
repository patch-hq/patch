import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/rest.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { Group, Note, Row, SettingsPage } from './ui.js';
import { patchShared } from './sharedWrite.js';
import { Toggle } from '../../components/Toggle.js';

const CLOUDFLARE_BOTBASE = 'https://dash.cloudflare.com/?to=/:account/application-security/botbase';

function PublicDetails(): JSX.Element {
  const saved = usePreferencesStore((s) => s.preferences.agentIdentity);
  const loaded = usePreferencesStore((s) => s.loaded);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);

  const commit = (field: 'name' | 'description' | 'operator' | 'contact'): void => {
    const value = draft[field].trim();
    if (value === saved[field]) return;
    if (field !== 'contact' && value === '') {
      setDraft(saved);
      return;
    }
    void patchShared('agent identity', { agentIdentity: { ...saved, [field]: value } });
  };

  return (
    <Group label="Public details" testid="settings-identity-details">
      <Row title="Name">
        <input
          type="text"
          aria-label="Agent name"
          data-testid="identity-name"
          value={draft.name}
          disabled={!loaded}
          maxLength={80}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          onBlur={() => commit('name')}
        />
      </Row>
      <Row title="Description" className="set-row-stack">
        <textarea
          aria-label="Agent description"
          data-testid="identity-description"
          value={draft.description}
          disabled={!loaded}
          maxLength={500}
          rows={2}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          onBlur={() => commit('description')}
        />
      </Row>
      <Row title="Operator">
        <input
          type="text"
          aria-label="Operator"
          data-testid="identity-operator"
          value={draft.operator}
          disabled={!loaded}
          maxLength={200}
          placeholder="Your name or organisation"
          onChange={(event) => setDraft({ ...draft, operator: event.target.value })}
          onBlur={() => commit('operator')}
        />
      </Row>
      <Row title="Operator contact">
        <input
          type="text"
          aria-label="Operator contact"
          data-testid="identity-contact"
          value={draft.contact}
          disabled={!loaded}
          maxLength={200}
          placeholder="name@example.com"
          onChange={(event) => setDraft({ ...draft, contact: event.target.value })}
          onBlur={() => commit('contact')}
        />
      </Row>
    </Group>
  );
}

export function AgentIdentityPage(): JSX.Element {
  const pushError = useUiStore((s) => s.pushError);
  const saved = usePreferencesStore((s) => s.preferences.agentIdentity);
  const { data, error, refetch } = useQuery({
    queryKey: ['web-bot-auth'],
    queryFn: () => api.webBotAuthStatus(),
  });

  const copy = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
    } catch (err) {
      pushError(`copy identity URL: ${(err as Error).message}`);
    }
  };

  const available = data?.ready === true;

  return (
    <SettingsPage title="Agent identity" testid="settings-identity">
      <Group label="Web Bot Auth" testid="settings-identity-status">
        {error ? (
          <Row title="Identity" sub={(error as Error).message}>
            <button type="button" className="set-btn" onClick={() => void refetch()}>
              Retry
            </button>
          </Row>
        ) : (
          <>
            <Row
              title="Identity"
              testid={
                data && !data.ready ? 'settings-identity-unavailable' : 'settings-identity-ready'
              }
              sub={data?.issue ?? undefined}
            >
              <span className={data?.ready ? 'set-state ok' : 'set-state'}>
                {data ? (data.ready ? 'Ready' : 'Unavailable') : 'Checking…'}
              </span>
            </Row>
            {available ? (
              <>
                <Row
                  title="Use agent identity"
                  sub={
                    saved.enabled
                      ? 'On — browser requests are signed'
                      : 'Off — browser requests are unsigned'
                  }
                  testid="identity-enabled-status"
                >
                  <Toggle
                    checked={saved.enabled}
                    onChange={(enabled) =>
                      void patchShared('agent identity', {
                        agentIdentity: { ...saved, enabled },
                      })
                    }
                    testid="identity-enabled"
                  />
                </Row>
                <Row title="Cloudflare approval" sub="Check Submission history in Cloudflare" />
                <Row title="Public key" testid="settings-identity-key-id" sub={data.keyId} />
                <Row
                  title="Key generation"
                  testid="settings-identity-key-generation"
                  sub="This server generated one cryptographically random Ed25519 key automatically when it first enabled Web Bot Auth. The private key is encrypted on this server and never leaves it."
                />
              </>
            ) : null}
          </>
        )}
      </Group>

      {available ? (
        <>
          <PublicDetails />

          <Group label="Public URLs" testid="settings-identity-urls">
            <Row title="Bot documentation URL" sub={data.agentUrl}>
              <button
                type="button"
                className="set-btn"
                data-testid="identity-copy-agent"
                onClick={() => void copy(data.agentUrl)}
              >
                Copy
              </button>
            </Row>
            <Row title="Signature URL" sub={data.directoryUrl}>
              <button
                type="button"
                className="set-btn"
                data-testid="identity-copy-directory"
                onClick={() => void copy(data.directoryUrl)}
              >
                Copy
              </button>
            </Row>
          </Group>

          <Group label="Cloudflare submission form" testid="identity-cloudflare-values">
            <Row title="Bot name" sub={saved.name}>
              <button
                type="button"
                className="set-btn"
                data-testid="identity-copy-name"
                onClick={() => void copy(saved.name)}
              >
                Copy
              </button>
            </Row>
            <Row title="Bot documentation URL" sub={data.agentUrl}>
              <button type="button" className="set-btn" onClick={() => void copy(data.agentUrl)}>
                Copy
              </button>
            </Row>
            <Row title="Operator" sub={saved.operator || 'Enter your name or organisation above'}>
              {saved.operator ? (
                <button type="button" className="set-btn" onClick={() => void copy(saved.operator)}>
                  Copy
                </button>
              ) : null}
            </Row>
            <Row title="Ownership" sub="I own this bot" />
            <Row title="Short description" sub={saved.description}>
              <button
                type="button"
                className="set-btn"
                onClick={() => void copy(saved.description)}
              >
                Copy
              </button>
            </Row>
            <Row title="Access type" sub="Direct" />
            <Row title="Categories" sub="Agent" />
            <Row title="Content use" sub="Reference" />
            <Row title="Identity attestation method" sub="web_bot_auth" />
            <Row title="Signature URL" sub={data.directoryUrl}>
              <button
                type="button"
                className="set-btn"
                onClick={() => void copy(data.directoryUrl)}
              >
                Copy
              </button>
            </Row>
            <Note>Cloudflare shows approval and any requested changes in Submission history.</Note>
          </Group>
          <a
            className="set-btn primary"
            href={CLOUDFLARE_BOTBASE}
            target="_blank"
            rel="noreferrer"
            data-testid="identity-cloudflare"
          >
            Open Cloudflare
          </a>
        </>
      ) : null}
    </SettingsPage>
  );
}
