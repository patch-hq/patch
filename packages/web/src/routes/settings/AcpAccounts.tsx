// Settings → AI accounts → one group per ACP agent (spec/10 § Backend
// credentials, § Signing in). An ACP agent signs in with an API key: the server
// checks it, stores it encrypted and sends it to every host. The key is typed
// into a write-only field and never shown back; each account shows its last
// four characters and its state. An agent that takes no key runs on its own
// sign-in on each host and has nothing to add here.

import type { JSX } from 'react';
import { useState } from 'react';
import { describeAccountState, resolveAcpAgents, type AcpAgentConfig } from '@patch/wire';
import { api, type SharedState } from '../../api/rest.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { formatResetLocal } from '../../lib/usage.js';
import { writeShared } from './sharedWrite.js';
import { Group, Note, Row } from './ui.js';

type AcpRow = NonNullable<SharedState['secrets']['acp']>[number];

/** The key field, open for a new account (`accountId` null) or a new key on one. */
interface Editing {
  agentId: string;
  accountId: string | null;
}

export function AcpAccounts(): JSX.Element | null {
  const configured = usePreferencesStore((s) => s.preferences.acpAgents);
  const shared = usePreferencesStore((s) => s.shared);
  const agents = resolveAcpAgents(configured).filter((a) => a.apiKeyEnv !== undefined);
  if (agents.length === 0) return null;
  return (
    <>
      {agents.map((agent) => (
        <AgentGroup
          key={agent.id}
          agent={agent}
          rows={(shared?.secrets.acp ?? []).filter((a) => a.agentId === agent.id)}
          loaded={shared !== null}
        />
      ))}
    </>
  );
}

function AgentGroup({
  agent,
  rows,
  loaded,
}: {
  agent: AcpAgentConfig;
  rows: AcpRow[];
  loaded: boolean;
}): JSX.Element {
  const reachable = usePresenceStore((s) => s.connection) === 'connected';
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const id = `acp-accounts-${agent.id}`;

  const close = (): void => {
    setEditing(null);
    setDraft('');
  };
  const run = async (call: () => Promise<SharedState>): Promise<boolean> => {
    setBusy(true);
    try {
      return await writeShared(`${agent.label} account`, call);
    } finally {
      setBusy(false);
    }
  };
  async function save(): Promise<void> {
    const key = draft.trim();
    if (key === '' || editing === null) return;
    const ok = await run(() =>
      editing.accountId === null
        ? api.addAcpAccount(agent.id, key)
        : api.replaceAcpKey(agent.id, editing.accountId, key),
    );
    if (ok) close();
  }
  async function remove(row: AcpRow): Promise<void> {
    const ok = await useUiStore.getState().confirm({
      title: `Remove ${row.label}`,
      message: `Remove ${row.label}? Every host stops using its key.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) await run(() => api.removeAcpAccount(agent.id, row.id));
  }

  const keyForm = (
    <form
      className="set-inline"
      data-testid={`${id}-form`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        type="password"
        className="set-grow"
        autoComplete="off"
        spellCheck={false}
        aria-label={`${agent.label} API key`}
        placeholder="Paste API key"
        data-testid={`${id}-input`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        autoFocus
      />
      <button type="button" className="set-btn ghost" data-testid={`${id}-cancel`} onClick={close}>
        Cancel
      </button>
      <button
        type="submit"
        className="set-btn primary"
        data-testid={`${id}-save`}
        disabled={!reachable || busy || draft.trim() === ''}
      >
        {busy ? 'Checking…' : 'Save'}
      </button>
    </form>
  );

  return (
    <Group
      label={agent.label}
      testid={id}
      after={
        editing?.accountId === null ? null : (
          <div className="set-add-bar start">
            <button
              type="button"
              className="set-btn"
              data-testid={`${id}-add`}
              disabled={!reachable || busy || !loaded}
              onClick={() => {
                setEditing({ agentId: agent.id, accountId: null });
                setDraft('');
              }}
            >
              Add API key
            </button>
          </div>
        )
      }
    >
      {!loaded ? <Note>Loading…</Note> : null}
      {loaded && rows.length === 0 && editing === null ? (
        <Note testid={`${id}-empty`}>No accounts</Note>
      ) : null}
      {rows.map((row) =>
        editing?.accountId === row.id ? (
          <div key={row.id} className="set-row stack" data-testid={`acp-account-${row.id}`}>
            <span className="set-row-title">{row.label}</span>
            {keyForm}
          </div>
        ) : (
          <Row
            key={row.id}
            title={row.label}
            sub={[
              row.last4 ? `API key · ends ${row.last4}` : 'API key',
              row.state ? describeAccountState(row.state, formatResetLocal) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            testid={`acp-account-${row.id}`}
          >
            <button
              type="button"
              className="set-btn"
              data-testid={`acp-account-${row.id}-replace`}
              disabled={!reachable || busy}
              onClick={() => {
                setEditing({ agentId: agent.id, accountId: row.id });
                setDraft('');
              }}
            >
              Replace key
            </button>
            <button
              type="button"
              className="set-btn danger"
              data-testid={`acp-account-${row.id}-remove`}
              disabled={!reachable || busy}
              onClick={() => void remove(row)}
            >
              Remove
            </button>
          </Row>
        ),
      )}
      {editing?.accountId === null ? (
        <div className="set-row stack" data-testid={`${id}-new`}>
          {keyForm}
        </div>
      ) : null}
    </Group>
  );
}
