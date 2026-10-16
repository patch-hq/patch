// Settings → Hooks (spec/14 § `/settings` details — Hooks, spec/20-hooks.md):
// every configured message hook as a row with its enable switch, an editor
// opened by row or by Add with the same fields as web, and Save / Delete.

import React from 'react';
import { Alert, Pressable, Switch, Text, View } from 'react-native';
import type { Hook, HookKind } from '@patch/wire/hooks';
import { isJunkFolder, isReservedSpecialThread } from '@patch/wire';
import { api } from '../../api/rest';
import { useChatStore } from '../../stores/chatStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useUiStore } from '../../stores/uiStore';
import {
  blankDraft,
  canSave,
  draftFromHook,
  draftToBody,
  toggleIn,
  type HookDraft,
} from '../../lib/hooksEditor';
import { radii, space, typography, useTheme } from '../../lib/theme';
import { SettingsSection } from '../SettingsSection';
import { ModelChoice } from './ModelChoice';
import { SettingsPage } from './SettingsPage';
import {
  ButtonRow,
  Chips,
  ErrorLine,
  Field,
  FieldLabel,
  Muted,
  Row,
  SettingsButton,
  ToggleRow,
} from './ui';

const KINDS: readonly HookKind[] = ['script', 'prompt'];

export function HooksPage(): React.ReactElement {
  return (
    <SettingsPage title="Hooks" testID="settings-page-hooks">
      <HooksList />
    </SettingsPage>
  );
}

function HooksList(): React.ReactElement {
  const [hooks, setHooks] = React.useState<Hook[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<HookDraft | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async (): Promise<void> => {
    try {
      setHooks((await api.listHooks()).hooks);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    try {
      await work();
      await load();
      return true;
    } catch (e) {
      useUiStore.getState().pushError(`hook: ${(e as Error).message}`);
      return false;
    }
  };

  const save = async (d: HookDraft): Promise<void> => {
    setBusy(true);
    const ok = await run(() =>
      d.id ? api.patchHook(d.id, draftToBody(d)) : api.createHook(draftToBody(d)),
    );
    setBusy(false);
    if (ok) setEditing(null);
  };

  const remove = (id: string, name: string): void => {
    Alert.alert(
      `Delete ${name}`,
      `Delete the hook "${name}"? It stops checking messages immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void run(() => api.deleteHook(id)).then((ok) => {
              if (ok) setEditing(null);
            });
          },
        },
      ],
    );
  };

  return (
    <SettingsSection title="Message hooks" testID="settings-hooks">
      {loadError ? (
        <ErrorLine
          testID="hooks-error"
          message={`Could not read hooks: ${loadError}`}
          onRetry={() => void load()}
        />
      ) : hooks === null ? (
        <Muted testID="hooks-loading">Loading…</Muted>
      ) : hooks.length === 0 && !editing ? (
        <Muted testID="hooks-empty">No hooks configured</Muted>
      ) : null}
      {(hooks ?? []).map((h) =>
        editing && editing.id === h.id ? (
          <HookEditor
            key={h.id}
            draft={editing}
            busy={busy}
            onChange={setEditing}
            onCancel={() => setEditing(null)}
            onSave={() => void save(editing)}
            onDelete={() => remove(h.id, h.name)}
          />
        ) : (
          <Row
            key={h.id}
            testID={`hook-${h.id}`}
            title={h.name}
            subtitle={`${h.when} · ${h.kind}`}
            onPress={() => setEditing(draftFromHook(h))}
            right={
              <Switch
                testID={`hook-${h.id}-enabled`}
                accessibilityLabel={`${h.name} enabled`}
                value={h.enabled}
                onValueChange={(next) =>
                  void run(() => (next ? api.enableHook(h.id) : api.disableHook(h.id)))
                }
              />
            }
          />
        ),
      )}
      {editing && editing.id === null ? (
        <HookEditor
          draft={editing}
          busy={busy}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSave={() => void save(editing)}
        />
      ) : null}
      {editing ? null : (
        <ButtonRow>
          <SettingsButton
            testID="hook-add"
            label="Add hook"
            variant="quiet"
            onPress={() => setEditing(blankDraft())}
          />
        </ButtonRow>
      )}
    </SettingsSection>
  );
}

function HookEditor({
  draft,
  busy,
  onChange,
  onCancel,
  onSave,
  onDelete,
}: {
  draft: HookDraft;
  busy: boolean;
  onChange: (d: HookDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete?: () => void;
}): React.ReactElement {
  const hosts = usePresenceStore((s) => s.hosts);
  const chats = useChatStore((s) => s.chats);
  const [folders, setFolders] = React.useState<string[]>([]);
  const [folderError, setFolderError] = React.useState<string | null>(null);
  React.useEffect(() => {
    api
      .folders()
      .then((r) =>
        setFolders(
          r.hosts.flatMap((h) => [...h.roots, ...h.recent.filter((f) => !isJunkFolder(f))]),
        ),
      )
      .catch((e: Error) => setFolderError(e.message));
  }, []);

  const hostOptions = Object.values(hosts).map((h) => ({
    value: h.hostId,
    label: h.host?.hostName ?? h.hostId,
  }));
  const chatList = Object.values(chats).filter((c) => !isReservedSpecialThread(c.chatId));
  const folderOptions = [
    ...new Set([...folders, ...chatList.map((c) => c.folder).filter((f) => !isJunkFolder(f))]),
  ]
    .filter((f) => f !== '')
    .sort()
    .map((f) => ({ value: f, label: f }));
  const chatOptions = Object.values(chats).map((c) => ({
    value: c.chatId,
    label: c.name ?? c.folder ?? c.chatId,
  }));

  return (
    <Row title={draft.id ? 'Edit hook' : 'New hook'} stack testID="hook-editor">
      <FieldLabel>Name</FieldLabel>
      <Field
        testID="hook-editor-name"
        accessibilityLabel="Hook name"
        value={draft.name}
        onChangeText={(name) => onChange({ ...draft, name })}
      />
      <FieldLabel>Kind</FieldLabel>
      <Chips
        options={KINDS}
        selected={draft.kind}
        onSelect={(kind) => onChange({ ...draft, kind })}
        testIDPrefix="hook-editor-kind"
        labelPrefix="Kind"
      />
      {draft.kind === 'script' ? (
        <>
          <FieldLabel>Command</FieldLabel>
          <Field
            testID="hook-editor-command"
            accessibilityLabel="Hook command"
            code
            multiline
            value={draft.command}
            onChangeText={(command) => onChange({ ...draft, command })}
          />
        </>
      ) : (
        <>
          <FieldLabel>Instructions</FieldLabel>
          <Field
            testID="hook-editor-instructions"
            accessibilityLabel="Hook instructions"
            multiline
            autoCapitalize="sentences"
            value={draft.instructions}
            onChangeText={(instructions) => onChange({ ...draft, instructions })}
          />
          <ModelChoice
            label="Model"
            testID="hook-editor-model"
            value={draft.model}
            onSelect={(model) => onChange({ ...draft, model })}
          />
        </>
      )}
      <MultiChips
        label="Hosts (none selected = any)"
        testID="hook-editor-hosts"
        values={draft.hosts}
        options={hostOptions}
        onChange={(hs) => onChange({ ...draft, hosts: hs })}
      />
      <MultiChips
        label="Folders (none selected = any)"
        testID="hook-editor-folders"
        values={draft.folders}
        options={folderOptions}
        onChange={(fs) => onChange({ ...draft, folders: fs })}
      />
      {folderError ? (
        <ErrorLine
          testID="hook-editor-folders-error"
          message={`Couldn’t load folders: ${folderError}`}
        />
      ) : null}
      <MultiChips
        label="Chats (none selected = any)"
        testID="hook-editor-chatids"
        values={draft.chatIds}
        options={chatOptions}
        onChange={(ids) => onChange({ ...draft, chatIds: ids })}
      />
      <ToggleRow
        label="Special threads only"
        testID="hook-editor-special-threads"
        value={draft.specialThreads}
        onChange={(specialThreads) => onChange({ ...draft, specialThreads })}
      />
      <FieldLabel>Filter (JSONata, optional)</FieldLabel>
      <Field
        testID="hook-editor-filter"
        accessibilityLabel="Hook filter"
        code
        value={draft.filter}
        onChangeText={(filter) => onChange({ ...draft, filter })}
      />
      <FieldLabel>Timeout (ms)</FieldLabel>
      <Field
        testID="hook-editor-timeout"
        accessibilityLabel="Hook timeout"
        keyboardType="number-pad"
        placeholder="15000"
        value={draft.timeoutMs}
        onChangeText={(timeoutMs) => onChange({ ...draft, timeoutMs })}
      />
      <ToggleRow
        label="Enabled"
        testID="hook-editor-enabled"
        value={draft.enabled}
        onChange={(enabled) => onChange({ ...draft, enabled })}
      />
      <ButtonRow>
        {onDelete ? (
          <SettingsButton
            testID="hook-editor-delete"
            label="Delete"
            variant="danger"
            onPress={onDelete}
          />
        ) : null}
        <SettingsButton
          testID="hook-editor-cancel"
          label="Cancel"
          variant="ghost"
          onPress={onCancel}
        />
        <SettingsButton
          testID="hook-editor-save"
          label={busy ? 'Saving…' : 'Save'}
          disabled={busy || !canSave(draft)}
          onPress={onSave}
        />
      </ButtonRow>
    </Row>
  );
}

/** A gate list as toggleable chips; a saved value no longer offered stays listed. */
function MultiChips({
  label,
  testID,
  values,
  options,
  onChange,
}: {
  label: string;
  testID: string;
  values: string[];
  options: Array<{ value: string; label: string }>;
  onChange: (next: string[]) => void;
}): React.ReactElement {
  const colors = useTheme();
  const all = [
    ...values
      .filter((v) => !options.some((o) => o.value === v))
      .map((v) => ({ value: v, label: v })),
    ...options,
  ];
  return (
    <View testID={testID} style={{ gap: space.xs }}>
      <FieldLabel>{label}</FieldLabel>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
        {all.map((o) => {
          const on = values.includes(o.value);
          return (
            <Pressable
              key={o.value}
              testID={`${testID}-${o.value}`}
              accessibilityRole="button"
              accessibilityLabel={o.label}
              accessibilityState={{ selected: on }}
              onPress={() => onChange(toggleIn(values, o.value))}
              style={{
                paddingHorizontal: space.md - 2,
                paddingVertical: 3,
                borderRadius: radii.pill,
                borderWidth: 1,
                borderColor: on ? colors.leaf : colors.divider,
                backgroundColor: on ? colors.accentTint : 'transparent',
              }}
            >
              <Text style={{ ...typography.meta, color: on ? colors.leafSoft : colors.ink3 }}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
