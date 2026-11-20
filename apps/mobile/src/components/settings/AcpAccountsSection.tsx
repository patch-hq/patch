// Settings → Usage → one section per ACP agent (spec/10 § Backend credentials,
// § Signing in). An ACP agent signs in with an API key: the server checks it,
// stores it encrypted and sends it to every host. The key is typed into a
// secure field and never shown back; each account shows its last four and its
// state. An agent that takes no key runs on its own sign-in on each host and
// has nothing to add here.

import React from 'react';
import { Alert, View } from 'react-native';
import { describeAccountState, resolveAcpAgents, type AcpAgentConfig } from '@patch/wire';
import { api, type SharedState } from '../../api/rest';
import { space } from '../../lib/theme';
import { formatReset } from '../../lib/usage';
import { usePresenceStore } from '../../stores/presenceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingsSection } from '../SettingsSection';
import { writeShared } from './sharedWrite';
import { STRATEGIES, STRATEGY_HINT, STRATEGY_LABEL, moveAccount } from './accountRows';
import { ButtonRow, Chips, Field, Muted, Row, SettingsButton } from './ui';

type AcpRow = NonNullable<SharedState['secrets']['acp']>[number];

export function AcpAccountsSections(): React.ReactElement | null {
  const configured = useSettingsStore((s) => s.data?.preferences.acpAgents);
  const rows = useSettingsStore((s) => s.data?.shared?.secrets.acp) ?? [];
  const agents = resolveAcpAgents(configured).filter((a) => a.apiKeyEnv !== undefined);
  if (agents.length === 0) return null;
  return (
    <>
      {agents.map((agent) => (
        <AgentSection
          key={agent.id}
          agent={agent}
          rows={rows.filter((r) => r.agentId === agent.id)}
        />
      ))}
    </>
  );
}

function AgentSection({
  agent,
  rows,
}: {
  agent: AcpAgentConfig;
  rows: AcpRow[];
}): React.ReactElement {
  const reachable = usePresenceStore((s) => s.connection) === 'connected';
  const strategy = useSettingsStore((s) => s.data?.preferences.accountStrategy.acp ?? 'priority');
  /** The account getting a new key, `new` for a new account, null when closed. */
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
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
  const save = async (): Promise<void> => {
    const key = draft.trim();
    if (key === '' || editing === null) return;
    const ok = await run(() =>
      editing === 'new'
        ? api.addAcpAccount(agent.id, key)
        : api.replaceAcpKey(agent.id, editing, key),
    );
    if (ok) close();
  };

  const keyForm = (
    <View style={{ marginTop: space.sm }}>
      <Field
        testID={`${id}-input`}
        accessibilityLabel={`${agent.label} API key`}
        placeholder="Paste API key"
        value={draft}
        onChangeText={setDraft}
        secureTextEntry
        autoFocus
      />
      <ButtonRow>
        <SettingsButton
          testID={`${id}-save`}
          label={busy ? 'Checking…' : 'Save'}
          disabled={!reachable || busy || draft.trim() === ''}
          onPress={() => void save()}
        />
        <SettingsButton testID={`${id}-cancel`} label="Cancel" variant="quiet" onPress={close} />
      </ButtonRow>
    </View>
  );

  return (
    <SettingsSection title={agent.label} testID={id}>
      {rows.length === 0 && editing === null ? (
        <Row title={<Muted>No accounts</Muted>} testID={`${id}-empty`} />
      ) : null}
      {rows.length > 1 ? (
        // One strategy for every ACP agent's accounts, as Claude and Codex each have one.
        <Row testID={`${id}-strategy`} title="Pick the account by" stack>
          <Chips
            options={STRATEGIES}
            selected={strategy}
            labelOf={(s) => STRATEGY_LABEL[s]}
            testIDPrefix={`${id}-strategy`}
            labelPrefix="ACP account strategy"
            hintOf={(s) => STRATEGY_HINT[s]}
            onSelect={(s) => void writeShared('ACP account strategy', () => api.setAcpStrategy(s))}
          />
        </Row>
      ) : null}
      {rows.map((row, index) => (
        <Row
          key={row.id}
          testID={`acp-account-${row.id}`}
          title={row.label}
          subtitle={[
            row.last4 ? `API key · ends ${row.last4}` : 'API key',
            row.state ? describeAccountState(row.state, (at) => formatReset(at)) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          subtitleTestID={`acp-account-${row.id}-status`}
          right={
            editing === row.id ? null : (
              <>
                {index > 0 ? (
                  <SettingsButton
                    testID={`acp-account-${row.id}-up`}
                    label="Move up"
                    variant="quiet"
                    disabled={!reachable || busy}
                    onPress={() =>
                      void run(() =>
                        api.orderAcpAccounts(
                          agent.id,
                          moveAccount(
                            rows.map((r) => r.id),
                            index,
                            -1,
                          ),
                        ),
                      )
                    }
                  />
                ) : null}
                <SettingsButton
                  testID={`acp-account-${row.id}-replace`}
                  label="Replace key"
                  variant="quiet"
                  disabled={!reachable || busy}
                  onPress={() => {
                    setEditing(row.id);
                    setDraft('');
                  }}
                />
                <SettingsButton
                  testID={`acp-account-${row.id}-remove`}
                  label="Remove"
                  variant="danger"
                  disabled={!reachable || busy}
                  onPress={() =>
                    Alert.alert(`Remove ${row.label}?`, 'Every host stops using its key.', [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Remove',
                        style: 'destructive',
                        onPress: () => void run(() => api.removeAcpAccount(agent.id, row.id)),
                      },
                    ])
                  }
                />
              </>
            )
          }
        >
          {editing === row.id ? keyForm : null}
        </Row>
      ))}
      {editing === 'new' ? (
        <Row title="New account" testID={`${id}-new`}>
          {keyForm}
        </Row>
      ) : (
        <Row
          title=""
          right={
            <SettingsButton
              testID={`${id}-add`}
              label="Add API key"
              disabled={!reachable || busy}
              onPress={() => {
                setEditing('new');
                setDraft('');
              }}
            />
          }
        />
      )}
    </SettingsSection>
  );
}
