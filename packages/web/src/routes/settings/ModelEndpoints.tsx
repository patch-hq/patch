// Settings → Providers → Model endpoints (spec/02 § Provider adapters).
//
// Local model servers and routers are not providers: each is an endpoint a
// harness Patch already drives runs its models on. An OpenAI-compatible one
// runs in Codex, an Anthropic-compatible one in Claude Code. The list is a
// shared setting; a key is a shared secret, written once and never shown.

import type { JSX } from 'react';
import { useState } from 'react';
import { endpointIdFor, type ModelEndpoint, type ModelEndpointApi } from '@patch/wire';
import { api } from '../../api/rest.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { patchShared, writeShared } from './sharedWrite.js';
import { Group, Note, Row } from './ui.js';

export const API_LABEL: Record<ModelEndpointApi, string> = {
  openai: 'OpenAI-compatible · runs in ChatGPT',
  anthropic: 'Anthropic-compatible · runs in Claude Code',
};

interface Draft {
  label: string;
  api: ModelEndpointApi;
  baseUrl: string;
  models: string;
  key: string;
}
const EMPTY: Draft = { label: '', api: 'openai', baseUrl: '', models: '', key: '' };

export function ModelEndpoints(): JSX.Element {
  const endpoints = usePreferencesStore((s) => s.preferences.modelEndpoints) ?? [];
  const loaded = usePreferencesStore((s) => s.loaded);
  const shared = usePreferencesStore((s) => s.shared);
  const reachable = usePresenceStore((s) => s.connection) === 'connected';
  const [adding, setAdding] = useState<Draft | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const keys = shared?.secrets.endpointKeys ?? [];

  const busyWhile = async <T,>(run: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try {
      return await run();
    } finally {
      setBusy(false);
    }
  };

  async function add(d: Draft): Promise<void> {
    const endpoint: ModelEndpoint = {
      id: endpointIdFor(
        d.label,
        endpoints.map((e) => e.id),
      ),
      label: d.label.trim(),
      api: d.api,
      baseUrl: d.baseUrl.trim(),
      ...(d.models.trim()
        ? {
            models: d.models
              .split(',')
              .map((m) => m.trim())
              .filter(Boolean),
          }
        : {}),
    };
    await busyWhile(async () => {
      if (!(await patchShared('Model endpoint', { modelEndpoints: [...endpoints, endpoint] })))
        return;
      const key = d.key.trim();
      if (key && !(await writeShared('Endpoint key', () => api.setEndpointKey(endpoint.id, key))))
        return;
      setAdding(null);
    });
  }

  async function remove(e: ModelEndpoint): Promise<void> {
    const ok = await useUiStore.getState().confirm({
      title: `Remove ${e.label}`,
      message: `Remove ${e.label} and its key? Chats on its models stay readable but cannot continue until it is added again with the same name.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await busyWhile(() =>
      patchShared('Model endpoint', { modelEndpoints: endpoints.filter((x) => x.id !== e.id) }),
    );
  }

  async function saveKey(id: string): Promise<void> {
    const value = keyDraft.trim();
    if (!value) return;
    if (await busyWhile(() => writeShared('Endpoint key', () => api.setEndpointKey(id, value)))) {
      setKeyFor(null);
      setKeyDraft('');
    }
  }

  const draft = adding;
  return (
    <Group label="Model endpoints" testid="settings-model-endpoints">
      {endpoints.length === 0 && draft === null ? (
        <Note testid="model-endpoints-empty">
          Ollama, LM Studio, llama.cpp, vLLM, OpenRouter or LiteLLM
        </Note>
      ) : null}
      {endpoints.map((e) => {
        const key = keys.find((k) => k.id === e.id);
        const row = `model-endpoint-${e.id}`;
        return (
          <Row
            key={e.id}
            title={e.label}
            sub={
              <>
                <span data-testid={`${row}-api`}>{API_LABEL[e.api]}</span>
                {' · '}
                <span data-testid={`${row}-url`}>{e.baseUrl}</span>
                {e.models ? ` · ${e.models.join(', ')}` : ''}
                {' · '}
                <span data-testid={`${row}-key`}>
                  {key ? `Key set${key.last4 ? ` · ends ${key.last4}` : ''}` : 'No key'}
                </span>
              </>
            }
            testid={row}
            className={keyFor === e.id ? 'stack' : undefined}
          >
            {keyFor === e.id ? (
              <form
                className="set-inline"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void saveKey(e.id);
                }}
              >
                <input
                  type="password"
                  className="set-grow"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`${e.label} key`}
                  placeholder="Paste key"
                  data-testid={`${row}-key-input`}
                  value={keyDraft}
                  onChange={(ev) => setKeyDraft(ev.target.value)}
                  autoFocus
                />
                <button type="button" className="set-btn ghost" onClick={() => setKeyFor(null)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="set-btn primary"
                  data-testid={`${row}-key-save`}
                  disabled={!reachable || busy || keyDraft.trim() === ''}
                >
                  Save
                </button>
              </form>
            ) : (
              <div className="set-row-ctrl">
                <button
                  type="button"
                  className="set-btn"
                  data-testid={`${row}-key-edit`}
                  disabled={!reachable || busy}
                  onClick={() => {
                    setKeyFor(e.id);
                    setKeyDraft('');
                  }}
                >
                  {key ? 'Replace key' : 'Add key'}
                </button>
                {key ? (
                  <button
                    type="button"
                    className="set-btn ghost"
                    data-testid={`${row}-key-revoke`}
                    disabled={!reachable || busy}
                    onClick={() =>
                      void busyWhile(() =>
                        writeShared('Endpoint key', () => api.revokeEndpointKey(e.id)),
                      )
                    }
                  >
                    Remove key
                  </button>
                ) : null}
                <button
                  type="button"
                  className="set-btn danger"
                  data-testid={`${row}-remove`}
                  disabled={!reachable || busy}
                  onClick={() => void remove(e)}
                >
                  Remove
                </button>
              </div>
            )}
          </Row>
        );
      })}
      {draft === null ? (
        <Row title="Add an endpoint" testid="model-endpoint-add-row">
          <button
            type="button"
            className="set-btn primary"
            data-testid="model-endpoint-add"
            disabled={!loaded || !reachable}
            onClick={() => setAdding(EMPTY)}
          >
            Add
          </button>
        </Row>
      ) : (
        <Row title="New endpoint" testid="model-endpoint-new" className="stack">
          <form
            className="set-stack"
            onSubmit={(ev) => {
              ev.preventDefault();
              void add(draft);
            }}
          >
            <input
              aria-label="Name"
              placeholder="Name, e.g. Ollama"
              data-testid="model-endpoint-new-label"
              value={draft.label}
              onChange={(ev) => setAdding({ ...draft, label: ev.target.value })}
              autoFocus
            />
            <select
              aria-label="API"
              data-testid="model-endpoint-new-api"
              value={draft.api}
              onChange={(ev) => setAdding({ ...draft, api: ev.target.value as ModelEndpointApi })}
            >
              <option value="openai">{API_LABEL.openai}</option>
              <option value="anthropic">{API_LABEL.anthropic}</option>
            </select>
            <input
              type="url"
              aria-label="Base URL"
              placeholder={
                draft.api === 'openai' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:4000'
              }
              data-testid="model-endpoint-new-url"
              value={draft.baseUrl}
              onChange={(ev) => setAdding({ ...draft, baseUrl: ev.target.value })}
            />
            <input
              aria-label="Models"
              placeholder="Models, comma separated (blank: what the endpoint lists)"
              data-testid="model-endpoint-new-models"
              value={draft.models}
              onChange={(ev) => setAdding({ ...draft, models: ev.target.value })}
            />
            <input
              type="password"
              autoComplete="off"
              aria-label="Key"
              placeholder="Key (optional)"
              data-testid="model-endpoint-new-key"
              value={draft.key}
              onChange={(ev) => setAdding({ ...draft, key: ev.target.value })}
            />
            <div className="set-inline">
              <button type="button" className="set-btn ghost" onClick={() => setAdding(null)}>
                Cancel
              </button>
              <button
                type="submit"
                className="set-btn primary"
                data-testid="model-endpoint-new-save"
                disabled={busy || draft.label.trim() === '' || draft.baseUrl.trim() === ''}
              >
                Save
              </button>
            </div>
          </form>
        </Row>
      )}
    </Group>
  );
}
