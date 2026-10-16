import React from 'react';
import { Alert, Linking } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { api, type AccountPreferences, type WebBotAuthStatus } from '../../api/rest';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingsSection } from '../SettingsSection';
import { Field, Muted, Row, RowValue, SettingsButton, ToggleRow, WithSettings } from './ui';
import { SettingsPage } from './SettingsPage';

const CLOUDFLARE_BOTBASE = 'https://dash.cloudflare.com/?to=/:account/application-security/botbase';

function writeIdentity(agentIdentity: AccountPreferences['agentIdentity']): void {
  void useSettingsStore
    .getState()
    .updatePreferences({ agentIdentity })
    .catch((error: Error) => Alert.alert('Settings failed', error.message));
}

function IdentityFields({
  value,
}: {
  value: AccountPreferences['agentIdentity'];
}): React.ReactElement {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const commit = (field: 'name' | 'description' | 'operator' | 'contact'): void => {
    const next = draft[field].trim();
    if (next === value[field]) return;
    if (field !== 'contact' && next === '') {
      setDraft(value);
      return;
    }
    writeIdentity({ ...value, [field]: next });
  };
  return (
    <SettingsSection title="Public details" testID="settings-identity-details">
      <Row
        title="Name"
        stack
        right={
          <Field
            testID="identity-name"
            accessibilityLabel="Agent name"
            value={draft.name}
            onChangeText={(name) => setDraft({ ...draft, name })}
            onBlur={() => commit('name')}
            maxLength={80}
          />
        }
      />
      <Row
        title="Description"
        stack
        right={
          <Field
            testID="identity-description"
            accessibilityLabel="Agent description"
            value={draft.description}
            onChangeText={(description) => setDraft({ ...draft, description })}
            onBlur={() => commit('description')}
            maxLength={500}
            multiline
          />
        }
      />
      <Row
        title="Operator"
        stack
        right={
          <Field
            testID="identity-operator"
            accessibilityLabel="Operator"
            value={draft.operator}
            onChangeText={(operator) => setDraft({ ...draft, operator })}
            onBlur={() => commit('operator')}
            maxLength={200}
            placeholder="Your name or organisation"
          />
        }
      />
      <Row
        title="Operator contact"
        stack
        right={
          <Field
            testID="identity-contact"
            accessibilityLabel="Operator contact"
            value={draft.contact}
            onChangeText={(contact) => setDraft({ ...draft, contact })}
            onBlur={() => commit('contact')}
            maxLength={200}
            placeholder="name@example.com"
          />
        }
      />
    </SettingsSection>
  );
}

async function copy(value: string): Promise<void> {
  try {
    await Clipboard.setStringAsync(value);
  } catch (error) {
    Alert.alert('Copy failed', (error as Error).message);
  }
}

export function AgentIdentityPage(): React.ReactElement {
  const [status, setStatus] = React.useState<WebBotAuthStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(() => {
    setError(null);
    void api
      .webBotAuthStatus()
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
  }, []);
  React.useEffect(load, [load]);
  React.useEffect(() => {
    if (!useSettingsStore.getState().data) void useSettingsStore.getState().load();
  }, []);
  const available = status?.ready === true;

  return (
    <SettingsPage title="Agent identity" testID="settings-page-identity">
      <SettingsSection title="Web Bot Auth" testID="settings-identity-status">
        <Row
          title="Identity"
          subtitle={error ?? status?.issue ?? undefined}
          testID={
            status && !status.ready ? 'settings-identity-unavailable' : 'settings-identity-ready'
          }
          right={
            error ? (
              <SettingsButton label="Retry" variant="quiet" onPress={load} />
            ) : (
              <RowValue>{status ? (status.ready ? 'Ready' : 'Unavailable') : 'Checking…'}</RowValue>
            )
          }
        />
        {available ? (
          <>
            <Row title="Public key" subtitle={status.keyId} testID="settings-identity-key-id" />
            <Row
              title="Key generation"
              subtitle="This server generated one cryptographically random Ed25519 key automatically when it first enabled Web Bot Auth. The private key is encrypted on this server and never leaves it."
              testID="settings-identity-key-generation"
            />
          </>
        ) : null}
      </SettingsSection>

      {available ? (
        <WithSettings testID="identity-settings">
          {(settings) => {
            const identity = settings.preferences.agentIdentity;
            return (
              <>
                <SettingsSection title="Use in browser">
                  <ToggleRow
                    label="Use agent identity"
                    value={identity.enabled}
                    onChange={(enabled) => writeIdentity({ ...identity, enabled })}
                    testID="identity-enabled"
                    subtitle={
                      identity.enabled
                        ? 'On — browser requests are signed'
                        : 'Off — browser requests are unsigned'
                    }
                  />
                  <Row
                    title="Browser requests"
                    subtitle={
                      identity.enabled
                        ? 'On — browser requests are signed'
                        : 'Off — browser requests are unsigned'
                    }
                    testID="identity-enabled-status"
                  />
                  <Row
                    title="Cloudflare approval"
                    subtitle="Check Submission history in Cloudflare"
                  />
                </SettingsSection>
                <IdentityFields value={identity} />

                <SettingsSection title="Public URLs" testID="settings-identity-urls">
                  <Row
                    title="Bot documentation URL"
                    subtitle={status.agentUrl}
                    right={
                      <SettingsButton
                        testID="identity-copy-agent"
                        label="Copy"
                        variant="quiet"
                        onPress={() => void copy(status.agentUrl)}
                      />
                    }
                  />
                  <Row
                    title="Signature URL"
                    subtitle={status.directoryUrl}
                    right={
                      <SettingsButton
                        testID="identity-copy-directory"
                        label="Copy"
                        variant="quiet"
                        onPress={() => void copy(status.directoryUrl)}
                      />
                    }
                  />
                </SettingsSection>

                <SettingsSection
                  title="Cloudflare submission form"
                  testID="identity-cloudflare-values"
                >
                  <Row
                    title="Bot name"
                    subtitle={identity.name}
                    right={
                      <SettingsButton
                        testID="identity-copy-name"
                        label="Copy"
                        variant="quiet"
                        onPress={() => void copy(identity.name)}
                      />
                    }
                  />
                  <Row
                    title="Bot documentation URL"
                    subtitle={status.agentUrl}
                    right={
                      <SettingsButton
                        label="Copy"
                        variant="quiet"
                        onPress={() => void copy(status.agentUrl)}
                      />
                    }
                  />
                  <Row
                    title="Operator"
                    subtitle={identity.operator || 'Enter your name or organisation above'}
                    right={
                      identity.operator ? (
                        <SettingsButton
                          label="Copy"
                          variant="quiet"
                          onPress={() => void copy(identity.operator)}
                        />
                      ) : undefined
                    }
                  />
                  <Row title="Ownership" right={<Muted>I own this bot</Muted>} />
                  <Row
                    title="Short description"
                    subtitle={identity.description}
                    right={
                      <SettingsButton
                        label="Copy"
                        variant="quiet"
                        onPress={() => void copy(identity.description)}
                      />
                    }
                  />
                  <Row title="Access type" right={<Muted>Direct</Muted>} />
                  <Row title="Categories" right={<Muted>Agent</Muted>} />
                  <Row title="Content use" right={<Muted>Reference</Muted>} />
                  <Row title="Identity attestation method" right={<Muted>web_bot_auth</Muted>} />
                  <Row
                    title="Signature URL"
                    subtitle={status.directoryUrl}
                    right={
                      <SettingsButton
                        label="Copy"
                        variant="quiet"
                        onPress={() => void copy(status.directoryUrl)}
                      />
                    }
                  />
                  <Row
                    title="Submission"
                    right={
                      <SettingsButton
                        testID="identity-cloudflare"
                        label="Open Cloudflare"
                        onPress={() => void Linking.openURL(CLOUDFLARE_BOTBASE)}
                      />
                    }
                  />
                </SettingsSection>
              </>
            );
          }}
        </WithSettings>
      ) : null}
    </SettingsPage>
  );
}
