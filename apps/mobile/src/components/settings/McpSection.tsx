// Settings → MCP (design/settings-redesign): the MCP servers the picked host
// wires into every chat. Patch's own tools server is built in and always on;
// then each of the host's `harnessMcpServers` with its command line and an
// enabled switch. Tapping one opens it to edit (McpServerEditor,
// app/settings/mcp-server.tsx): name, command line, environment as KEY=VALUE
// lines, and Remove. Add server opens the same screen empty.
//
// Every change sends the host's WHOLE list (`host.settings` harnessMcpServers),
// validated with the wire's McpServerList first; nothing is patched locally —
// the list settles on the host's fresh `host.host`.

import React from 'react';
import { Alert, Switch, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  VOICE_TOOL_GROUPS,
  mcpServerSummary,
  voiceToolCount,
  voiceToolCountNote,
  withVoiceToolSwitch,
  type McpServerConfig,
  type VoiceToolGroup,
} from '@patch/wire';
import { applyMcpDraft, commandLine, envText, serverTarget } from '../../lib/mcpServers';
import { space, useTheme } from '../../lib/theme';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore';
import { SettingsSection } from '../SettingsSection';
import { sendHostSettings } from './hostSend';
import {
  NoticeRow,
  hostName,
  unreportedText,
  updateToManageText,
  useSettingsHost,
} from './HostSwitcher';
import { SettingsPage } from './SettingsPage';
import { ButtonRow, ErrorLine, Field, FieldLabel, Row, RowValue, SettingsButton } from './ui';

export function McpPage(): React.ReactElement {
  const router = useRouter();
  const host = useSettingsHost();
  const gap = unreportedText(host);
  const servers = host?.host?.harnessMcpServers;
  return (
    <SettingsPage
      title="MCP"
      testID="settings-page-mcp"
      hostSwitcher
      right={
        host !== null && gap === null && servers !== undefined ? (
          <SettingsButton
            testID="mcp-add"
            label="Add server"
            onPress={() =>
              router.push({ pathname: '/settings/mcp-server', params: { hostId: host.hostId } })
            }
          />
        ) : null
      }
    >
      <SettingsSection title="Built in" testID="mcp-builtin">
        <Row
          testID="mcp-server-patch"
          title="Patch"
          subtitle="Built in"
          right={<RowValue>Always on</RowValue>}
        />
        {host !== null && gap === null && host.host?.voiceToolGroupsOff !== undefined
          ? VOICE_TOOL_GROUPS.map((g) => (
              <GroupRow
                key={g.id}
                host={host}
                group={g}
                off={host.host?.voiceToolGroupsOff ?? []}
              />
            ))
          : null}
      </SettingsSection>
      <SettingsSection title="MCP servers" testID="mcp-servers">
        {host === null || gap !== null ? (
          <NoticeRow text={gap ?? ''} />
        ) : servers === undefined ? (
          <NoticeRow testID="mcp-update" text={updateToManageText(host)} />
        ) : (
          servers.map((s) => <ServerRow key={s.name} host={host} list={servers} server={s} />)
        )}
        {host !== null &&
        gap === null &&
        servers !== undefined &&
        host.host?.voiceToolGroupsOff !== undefined ? (
          <NoticeRow
            testID="mcp-voice-count"
            text={voiceToolCountNote(
              voiceToolCount(servers, host.host.voiceToolGroupsOff, host.host.mcpTools ?? {}),
            )}
          />
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}

/** Voice and Agent switches side by side, each named. */
function Switches({
  testID,
  label,
  voice,
  agent,
  disabled,
  onVoice,
  onAgent,
}: {
  testID: string;
  label: string;
  voice?: boolean;
  agent?: boolean;
  disabled: boolean;
  onVoice?: (next: boolean) => void;
  onAgent?: (next: boolean) => void;
}): React.ReactElement {
  const colors = useTheme();
  const track = { false: colors.divider, true: colors.leafSoft };
  return (
    <View style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
      {voice !== undefined && onVoice ? (
        <View style={{ alignItems: 'center' }}>
          <RowValue>Voice</RowValue>
          <Switch
            testID={`${testID}-voice`}
            accessibilityLabel={`${label} voice`}
            value={voice}
            disabled={disabled}
            onValueChange={onVoice}
            trackColor={track}
            thumbColor={voice ? colors.leaf : colors.paper}
          />
        </View>
      ) : null}
      {agent !== undefined && onAgent ? (
        <View style={{ alignItems: 'center' }}>
          <RowValue>Agent</RowValue>
          <Switch
            testID={`${testID}-enabled`}
            accessibilityLabel={`${label} enabled`}
            value={agent}
            disabled={disabled}
            onValueChange={onAgent}
            trackColor={track}
            thumbColor={agent ? colors.leaf : colors.paper}
          />
        </View>
      ) : null}
    </View>
  );
}

function GroupRow({
  host,
  group,
  off,
}: {
  host: HostPresence;
  group: (typeof VOICE_TOOL_GROUPS)[number];
  off: readonly VoiceToolGroup[];
}): React.ReactElement {
  const conn = usePresenceStore((s) => s.connection);
  const reachable = conn === 'connected' && host.online;
  return (
    <Row
      testID={`mcp-group-${group.id}`}
      title={group.label}
      subtitle={group.description}
      right={
        <Switches
          testID={`mcp-group-${group.id}`}
          label={group.label}
          voice={!off.includes(group.id)}
          disabled={!reachable}
          onVoice={(on) =>
            void sendHostSettings(
              host.hostId,
              {
                voiceToolGroupsOff: on ? off.filter((x) => x !== group.id) : [...off, group.id],
              },
              'Voice tools',
            )
          }
        />
      }
    />
  );
}

function ServerRow({
  host,
  list,
  server,
}: {
  host: HostPresence;
  list: McpServerConfig[];
  server: McpServerConfig;
}): React.ReactElement {
  const router = useRouter();
  const conn = usePresenceStore((s) => s.connection);
  const reachable = conn === 'connected' && host.online;
  const set = (patch: Partial<McpServerConfig>): void =>
    void sendHostSettings(
      host.hostId,
      { harnessMcpServers: list.map((s) => (s.name === server.name ? { ...s, ...patch } : s)) },
      'MCP servers',
    );
  return (
    <Row
      testID={`mcp-server-${server.name}`}
      accessibilityLabel={`Edit ${server.name}`}
      title={server.name}
      subtitle={`${mcpServerSummary(server, host.host?.mcpTools?.[server.name])} · ${serverTarget(server)}`}
      onPress={() =>
        router.push({
          pathname: '/settings/mcp-server',
          params: { hostId: host.hostId, name: server.name },
        })
      }
      right={
        <Switches
          testID={`mcp-server-${server.name}`}
          label={server.name}
          voice={server.voice}
          agent={server.enabled}
          disabled={!reachable}
          onVoice={(voice) => set({ voice })}
          onAgent={(enabled) => set({ enabled })}
        />
      }
    />
  );
}

/**
 * One MCP server, to add (`name` absent) or edit: its name, its command line,
 * its environment as KEY=VALUE lines. Save validates the whole list before it
 * is sent and returns; Remove asks first.
 */
export function McpServerEditor({
  hostId,
  name,
}: {
  hostId: string;
  name: string | null;
}): React.ReactElement {
  const router = useRouter();
  const host = usePresenceStore((s) => s.hosts[hostId] ?? null);
  const list = host?.host?.harnessMcpServers;
  const existing = name === null ? null : (list?.find((s) => s.name === name) ?? null);
  const [draftName, setDraftName] = React.useState(existing?.name ?? '');
  const [transport, setTransport] = React.useState<'command' | 'url'>(
    existing && 'url' in existing ? 'url' : 'command',
  );
  const [line, setLine] = React.useState(
    existing && 'command' in existing ? commandLine(existing) : '',
  );
  const [env, setEnv] = React.useState(existing && 'env' in existing ? envText(existing.env) : '');
  const [url, setUrl] = React.useState(existing && 'url' in existing ? existing.url : '');
  const [tokenSecret, setTokenSecret] = React.useState(
    existing && 'url' in existing ? (existing.tokenSecret ?? '') : '',
  );
  const [voiceOff, setVoiceOff] = React.useState<string[]>(existing?.voiceOff ?? []);
  const read = name === null ? undefined : host?.host?.mcpTools?.[name];
  const [problem, setProblem] = React.useState<string | null>(null);
  const title = name === null ? 'Add server' : name;

  const gap = unreportedText(host);
  if (host === null || gap !== null || list === undefined || (name !== null && !existing)) {
    return (
      <SettingsPage title={title} testID="settings-mcp-editor">
        <SettingsSection>
          <NoticeRow
            testID="mcp-editor-unavailable"
            text={
              gap ??
              (list === undefined && host
                ? updateToManageText(host)
                : `${name ?? ''} is no longer on ${host ? hostName(host) : hostId}`)
            }
          />
        </SettingsSection>
      </SettingsPage>
    );
  }

  const save = (): void => {
    const result = applyMcpDraft(list, name, {
      name: draftName,
      transport,
      commandLine: line,
      envText: env,
      url,
      tokenSecret,
      voiceOff,
    });
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    setProblem(null);
    if (sendHostSettings(hostId, { harnessMcpServers: result.list }, 'MCP servers')) {
      router.back();
    }
  };

  const remove = (): void =>
    Alert.alert(`Remove ${name ?? ''}?`, `Chats on ${hostName(host)} stop getting its tools.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          if (
            sendHostSettings(
              hostId,
              { harnessMcpServers: list.filter((s) => s.name !== name) },
              'MCP servers',
            )
          ) {
            router.back();
          }
        },
      },
    ]);

  return (
    <SettingsPage
      title={title}
      testID="settings-mcp-editor"
      right={<SettingsButton testID="mcp-editor-save" label="Save" onPress={save} />}
    >
      <SettingsSection>
        <View style={{ padding: space.md }}>
          <FieldLabel>Name</FieldLabel>
          <Field
            testID="mcp-editor-name"
            accessibilityLabel="Name"
            value={draftName}
            onChangeText={setDraftName}
            placeholder="playwright"
          />
          <FieldLabel>Reached by</FieldLabel>
          <ButtonRow>
            <SettingsButton
              testID="mcp-editor-transport-url"
              label="Address"
              variant={transport === 'url' ? 'primary' : 'quiet'}
              onPress={() => setTransport('url')}
            />
            <SettingsButton
              testID="mcp-editor-transport-command"
              label="Command"
              variant={transport === 'command' ? 'primary' : 'quiet'}
              onPress={() => setTransport('command')}
            />
          </ButtonRow>
          {transport === 'url' ? (
            <>
              <FieldLabel>Address</FieldLabel>
              <Field
                testID="mcp-editor-url"
                accessibilityLabel="Address"
                value={url}
                onChangeText={setUrl}
                placeholder="http://homeassistant.local:8123/api/mcp"
              />
              <FieldLabel>Token secret</FieldLabel>
              <Field
                testID="mcp-editor-token-secret"
                accessibilityLabel="Token secret"
                value={tokenSecret}
                onChangeText={setTokenSecret}
                placeholder="HOME_ASSISTANT_TOKEN"
              />
            </>
          ) : (
            <>
              <FieldLabel>Command</FieldLabel>
              <Field
                testID="mcp-editor-command"
                accessibilityLabel="Command"
                value={line}
                onChangeText={setLine}
                placeholder="npx @playwright/mcp --headless"
              />
              <FieldLabel>Environment</FieldLabel>
              <Field
                testID="mcp-editor-env"
                accessibilityLabel="Environment"
                multiline
                value={env}
                onChangeText={setEnv}
                placeholder="KEY=VALUE"
                style={{ minHeight: 96, textAlignVertical: 'top' }}
              />
            </>
          )}
          {problem ? <ErrorLine testID="mcp-editor-error" message={problem} /> : null}
        </View>
      </SettingsSection>
      {read !== undefined && 'tools' in read && read.tools.length > 0 ? (
        <SettingsSection title="Tools for the voice" testID="mcp-editor-tools">
          {read.tools.map((t) => (
            <Row
              key={t.name}
              testID={`mcp-tool-${t.name}`}
              title={t.name}
              subtitle={t.description}
              right={
                <Switch
                  testID={`mcp-tool-${t.name}-voice`}
                  accessibilityLabel={`${t.name} for the voice`}
                  value={!voiceOff.includes(t.name)}
                  onValueChange={(on) =>
                    setVoiceOff(withVoiceToolSwitch({ voiceOff }, t.name, on).voiceOff)
                  }
                />
              }
            />
          ))}
        </SettingsSection>
      ) : null}
      <ButtonRow>
        <SettingsButton
          testID="mcp-editor-cancel"
          label="Cancel"
          variant="quiet"
          onPress={() => router.back()}
        />
        {name !== null ? (
          <SettingsButton
            testID="mcp-editor-remove"
            label="Remove"
            variant="danger"
            onPress={remove}
          />
        ) : null}
      </ButtonRow>
    </SettingsPage>
  );
}
