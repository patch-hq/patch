// Claude Code's settings.json on one host (Settings → Machines → a machine), a plain file
// edited where it lives (spec/02 § Claude Code settings). The row says whether
// the machine has one; Edit opens it full screen (app/settings/claude-json.tsx).
// Save sends the text to that host, which writes the file or refuses text that
// is not a JSON object, in its own words (hostRefusalStore); the editor closes
// when the host's fresh snapshot shows the file changed.

import React from 'react';
import { useRouter } from 'expo-router';
import { radii, space, useTheme } from '../../lib/theme';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore';
import { SettingsSection } from '../SettingsSection';
import { NoticeRow, hostName } from './HostSwitcher';
import { sendToHost } from './hostSend';
import { SettingsPage } from './SettingsPage';
import { useSettledEdit } from './useSettledEdit';
import { ErrorLine, Field, Row, SettingsButton } from './ui';

export function ClaudeSettingsRow({ host }: { host: HostPresence }): React.ReactElement {
  const router = useRouter();
  const report = host.claudeSettings;
  return (
    <SettingsSection title="Claude Code settings.json" testID={`host-${host.hostId}-claude-json`}>
      <Row
        title={hostName(host)}
        subtitle={
          report == null ? 'Not reported yet' : report.settingsJson.trim() === '' ? 'None' : 'Set'
        }
        subtitleTestID="claude-json-summary"
        right={
          <SettingsButton
            testID="claude-json-edit"
            label="Edit"
            variant="quiet"
            disabled={report == null}
            onPress={() =>
              router.push({ pathname: '/settings/claude-json', params: { hostId: host.hostId } })
            }
          />
        }
      />
    </SettingsSection>
  );
}

export function ClaudeSettingsEditor({ hostId }: { hostId: string }): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const host = usePresenceStore((s) => s.hosts[hostId] ?? null);
  const report = host?.claudeSettings ?? null;
  const name = host ? hostName(host) : hostId;
  const [draft, setDraft] = React.useState(report?.settingsJson ?? '');
  const { waiting, problem, start, clearProblem } = useSettledEdit<'save'>(report, name, () =>
    router.back(),
  );

  if (report === null) {
    return (
      <SettingsPage title="settings.json" testID="settings-claude-json">
        <SettingsSection>
          <NoticeRow testID="claude-json-unreported" text={`${name} hasn’t reported yet`} />
        </SettingsSection>
      </SettingsPage>
    );
  }

  const save = (): void => {
    clearProblem();
    if (
      sendToHost(
        hostId,
        { type: 'host.claude_settings_set', hostId, text: draft },
        'Save settings.json',
      )
    ) {
      start('save');
    }
  };

  return (
    <SettingsPage
      title="settings.json"
      testID="settings-claude-json"
      right={
        <SettingsButton
          testID="claude-json-save"
          label={waiting === 'save' ? 'Saving…' : 'Save'}
          disabled={waiting !== null || draft === report.settingsJson}
          onPress={save}
        />
      }
    >
      <Field
        testID="claude-json-text"
        accessibilityLabel={`settings.json on ${name}`}
        multiline
        code
        value={draft}
        onChangeText={setDraft}
        placeholder="{}"
        style={{
          minHeight: 360,
          textAlignVertical: 'top',
          backgroundColor: colors.paperRaised,
          borderRadius: radii.md,
          padding: space.md,
        }}
      />
      {problem ? <ErrorLine testID="claude-json-error" message={problem} /> : null}
    </SettingsPage>
  );
}
