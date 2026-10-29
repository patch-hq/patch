// Settings → Providers: the account's provider keys and secrets. Both are shared
// by every host, so the page has no host switch. Claude Code's own settings.json
// is a per-host file and is edited on that host's page (HostsPage).

import type { JSX } from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { providerKeyInfo, type ProviderKeyId } from '@patch/wire';
import { isSubmitChord } from '../../lib/submitChord.js';
import { shortcutLabel } from '../../lib/shortcuts.js';
import { sendToHost } from './hostWrite.js';
import { api, type SharedState } from '../../api/rest.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { hostLabel } from './hostScope.js';
import { problemText, writeShared } from './sharedWrite.js';
import { Group, Note, Row, SettingsPage } from './ui.js';

export function ProvidersPage(): JSX.Element {
  return (
    <SettingsPage title="Providers" testid="settings-providers">
      <section className="set-group">
        <div className="set-group-head">
          <h2 className="set-label">Provider keys</h2>
        </div>
        <ProviderKeys />
      </section>
      <Secrets />
    </SettingsPage>
  );
}

/**
 * That host's Claude Code `settings.json`, as the machine holds it. Save sends
 * the text to the host, which writes the file or refuses text that is not a
 * JSON object; the editor closes when the host's report shows the file changed,
 * and stays open with the text while it has not.
 */
export function ClaudeSettingsEditor({ host }: { host: HostPresence }): JSX.Element {
  const report = host.claudeSettings;
  const [draft, setDraft] = useState<string | null>(null);
  const [sentOver, setSentOver] = useState<string | null>(null);
  const id = `host-${host.hostId}-claude-settings`;
  const value = report?.settingsJson;

  if (sentOver !== null && value !== sentOver) {
    setSentOver(null);
    setDraft(null);
  }

  function save(): void {
    if (draft === null || value === undefined) return;
    if (sendToHost(host, { type: 'host.claude_settings_set', hostId: host.hostId, text: draft })) {
      setSentOver(value);
    }
  }

  return (
    <Group label="Claude Code settings.json" testid={id}>
      <div className={`set-row${draft === null ? '' : ' stack'}`} data-testid={`${id}-row`}>
        <div className="set-row-head">
          <div className="set-row-text">
            <span className="set-row-title">{hostLabel(host)}</span>
            <span className="set-sub">
              {report === null ? 'Not reported yet' : value?.trim() === '' ? 'None' : 'Set'}
            </span>
          </div>
          {draft === null ? (
            <button
              type="button"
              className="set-btn"
              data-testid={`${id}-edit`}
              disabled={value === undefined}
              onClick={() => setDraft(value ?? '')}
            >
              Edit
            </button>
          ) : null}
        </div>
        {draft !== null ? (
          <>
            <textarea
              className="claude-settings-json"
              aria-label="Claude Code settings.json"
              data-testid={`${id}-json`}
              rows={14}
              placeholder="{}"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (!isSubmitChord(e)) return;
                e.preventDefault();
                save();
              }}
            />
            <div className="set-actions">
              <button
                type="button"
                className="set-btn ghost"
                data-testid={`${id}-cancel`}
                onClick={() => {
                  setSentOver(null);
                  setDraft(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="set-btn primary"
                data-testid={`${id}-save`}
                disabled={draft === value || sentOver !== null}
                title={shortcutLabel('⌘↵')}
                onClick={save}
              >
                Save
              </button>
            </div>
          </>
        ) : null}
      </div>
    </Group>
  );
}

/**
 * The account's provider keys — Gemini, OpenAI Realtime, Groq (spec/02 §
 * Provider keys) — shared settings held on the server and sent to every host.
 * Add / Replace takes a value in a write-only field; Revoke deletes it. A key
 * that only some hosts' environments supply names those hosts and offers to
 * adopt it as the shared value. The value is never shown back.
 */
function ProviderKeys(): JSX.Element {
  const connection = usePresenceStore((s) => s.connection);
  const hosts = usePresenceStore((s) => s.hosts);
  const shared = usePreferencesStore((s) => s.shared);
  const [editing, setEditing] = useState<ProviderKeyId | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  if (shared === null) {
    return (
      <div className="set-card">
        <Note testid="providers-keys-loading">Loading…</Note>
      </div>
    );
  }
  const reachable = connection === 'connected';
  // Which online hosts have each key in their own environment.
  const envHosts = (id: ProviderKeyId): HostPresence[] =>
    Object.values(hosts).filter(
      (h) => h.online && h.host?.providerKeys?.some((k) => k.id === id && k.envSet),
    );

  const run = async (what: string, call: () => Promise<SharedState>): Promise<boolean> => {
    setBusy(true);
    try {
      return await writeShared(what, call);
    } finally {
      setBusy(false);
    }
  };

  async function save(id: ProviderKeyId): Promise<void> {
    const value = draft.trim();
    if (value === '') return;
    if (await run(`${providerKeyInfo(id).label} key`, () => api.setProviderKey(id, value))) {
      setEditing(null);
      setDraft('');
    }
  }

  async function revoke(id: ProviderKeyId): Promise<void> {
    const { label } = providerKeyInfo(id);
    const ok = await useUiStore.getState().confirm({
      title: `Revoke ${label} key`,
      message: `Delete the ${label} key? A machine with one in its own environment goes back to that.`,
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    await run(`${label} key`, () => api.revokeProviderKey(id));
  }

  return (
    <div className="set-card" data-testid="providers-keys">
      {shared.secrets.providerKeys.map((k) => {
        const { label, envVar } = providerKeyInfo(k.id);
        const row = `provider-key-${k.id}`;
        const env = envHosts(k.id);
        const status = k.set
          ? `Set${k.last4 ? ` · ends ${k.last4}` : ''}`
          : env.length > 0
            ? `From the environment on ${env.map(hostLabel).join(', ')}`
            : 'Not set';
        return (
          <div
            key={k.id}
            className={`set-row${editing === k.id ? ' stack' : ''}`}
            data-testid={row}
            data-source={k.set ? 'ui' : env.length > 0 ? 'env' : 'none'}
          >
            <div className="set-row-head">
              <div className="set-row-text">
                <span className="set-row-title">
                  <span className={`set-dot${k.set || env.length > 0 ? '' : ' off'}`} aria-hidden />
                  {label}
                </span>
                <span className="set-sub" data-testid={`${row}-status`}>
                  {status}
                </span>
                <span className="set-sub mono">{envVar}</span>
              </div>
              {editing === k.id ? null : (
                <div className="set-row-ctrl">
                  {!k.set && env[0] ? (
                    <button
                      type="button"
                      className="set-btn"
                      data-testid={`${row}-adopt`}
                      disabled={!reachable || busy}
                      onClick={() =>
                        void run(`${label} key`, () => api.adoptProviderKey(k.id, env[0]!.hostId))
                      }
                    >
                      Use for all
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`set-btn${k.set || env.length > 0 ? '' : ' primary'}`}
                    data-testid={`${row}-edit`}
                    disabled={!reachable || busy}
                    onClick={() => {
                      setEditing(k.id);
                      setDraft('');
                    }}
                  >
                    {k.set ? 'Replace' : 'Add'}
                  </button>
                  {k.set ? (
                    <button
                      type="button"
                      className="set-btn danger"
                      data-testid={`${row}-revoke`}
                      disabled={!reachable || busy}
                      onClick={() => void revoke(k.id)}
                    >
                      Revoke
                    </button>
                  ) : null}
                </div>
              )}
            </div>
            {editing === k.id ? (
              <form
                className="set-inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(k.id);
                }}
              >
                <input
                  type="password"
                  className="set-grow"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`${label} key`}
                  placeholder={envVar}
                  data-testid={`${row}-input`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  autoFocus
                />
                <button
                  type="button"
                  className="set-btn ghost"
                  data-testid={`${row}-cancel`}
                  onClick={() => {
                    setEditing(null);
                    setDraft('');
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="set-btn primary"
                  data-testid={`${row}-save`}
                  disabled={!reachable || busy || draft.trim() === ''}
                >
                  Save
                </button>
              </form>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The account's secrets (spec/15 § Settings tab — Secrets): key/value pairs the
 * host injects into chats. Values are masked in the list and shown only in
 * the editor. A write is answered by the host through the server; a refusal
 * or a silent host is said, and the list is re-read from the server rather
 * than patched here.
 */
function Secrets(): JSX.Element {
  const qc = useQueryClient();
  const pushError = useUiStore((s) => s.pushError);
  const { data, error } = useQuery({ queryKey: ['secrets'], queryFn: () => api.listSecrets() });
  const [editing, setEditing] = useState<{ key: string; value: string; isNew: boolean } | null>(
    null,
  );
  const setMut = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => api.setSecret(key, value),
    onSuccess: () => {
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['secrets'] });
    },
    onError: (e, v) => pushError(`secret ${v.key}: ${problemText(e)}`),
  });
  const deleteMut = useMutation({
    mutationFn: (key: string) => api.deleteSecret(key),
    onSuccess: () => {
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['secrets'] });
    },
    onError: (e, key) => pushError(`secret ${key}: ${problemText(e)}`),
  });

  async function remove(key: string): Promise<void> {
    const ok = await useUiStore.getState().confirm({
      title: `Delete ${key}`,
      message: `Delete the secret ${key}? Chats stop receiving it.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) deleteMut.mutate(key);
  }

  const busy = setMut.isPending || deleteMut.isPending;
  const secrets = data?.secrets ?? [];
  const editor = (e: { key: string; value: string; isNew: boolean }): JSX.Element => (
    <form
      // A new secret's key is being typed: keying on it would remount the form
      // on every keystroke and lose the value field under the user.
      key={e.isNew ? 'edit-new' : `edit-${e.key}`}
      className="set-row stack set-form"
      data-testid="secret-editor"
      onSubmit={(ev) => {
        ev.preventDefault();
        const key = e.key.trim();
        if (key === '') return;
        setMut.mutate({ key, value: e.value });
      }}
    >
      {e.isNew ? (
        <label className="set-field">
          <span className="set-row-title">Key</span>
          <input
            className="mono"
            value={e.key}
            data-testid="secret-editor-key"
            placeholder="TODOIST_TOKEN"
            autoFocus
            onChange={(ev) => setEditing({ ...e, key: ev.target.value })}
          />
        </label>
      ) : (
        <span className="set-row-title mono">{e.key}</span>
      )}
      <label className="set-field">
        <span className="set-row-title">Value</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="mono"
          value={e.value}
          data-testid="secret-editor-value"
          autoFocus={!e.isNew}
          onChange={(ev) => setEditing({ ...e, value: ev.target.value })}
        />
      </label>
      <div className="set-actions">
        {e.isNew ? null : (
          <button
            type="button"
            className="set-btn danger"
            data-testid="secret-editor-delete"
            disabled={busy}
            onClick={() => void remove(e.key)}
          >
            Delete
          </button>
        )}
        <span className="set-spacer" />
        <button
          type="button"
          className="set-btn ghost"
          data-testid="secret-editor-cancel"
          onClick={() => setEditing(null)}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="set-btn primary"
          data-testid="secret-editor-save"
          disabled={busy || e.key.trim() === ''}
        >
          {setMut.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );

  return (
    <Group
      label="Secrets"
      testid="settings-secrets"
      after={
        editing?.isNew ? null : (
          <div className="set-add-bar start">
            <button
              type="button"
              className="set-btn"
              data-testid="secret-add"
              onClick={() => setEditing({ key: '', value: '', isNew: true })}
            >
              Add secret
            </button>
          </div>
        )
      }
    >
      {error ? (
        <Note testid="secrets-error">Could not read secrets: {problemText(error)}</Note>
      ) : !data ? (
        <Note>Loading…</Note>
      ) : secrets.length === 0 && !editing ? (
        <Note testid="secrets-empty">No secrets</Note>
      ) : null}
      {secrets.map((s) =>
        editing && !editing.isNew && editing.key === s.key ? (
          editor(editing)
        ) : (
          <Row
            key={s.key}
            title={<span className="mono">{s.key}</span>}
            sub="••••••••"
            testid={`secret-${s.key}`}
          >
            <button
              type="button"
              className="set-btn"
              data-testid={`secret-${s.key}-edit`}
              onClick={() => setEditing({ key: s.key, value: s.value, isNew: false })}
            >
              Edit
            </button>
          </Row>
        ),
      )}
      {editing?.isNew ? editor(editing) : null}
    </Group>
  );
}
