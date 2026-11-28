// Settings → Manager → Home: which host runs the Manager and Speakers threads
// (spec/06 § Where special threads run, § Changing home).
//
// The user chooses; nothing moves it by itself. Choosing another host opens
// the handover before anything changes: the server's draft of the recent
// conversation, which the user edits or clears, and only "Move" sends it.

import React from 'react';
import { Alert } from 'react-native';
import { api } from '../../api/rest';
import { usePresenceStore } from '../../stores/presenceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { OptionPicker } from '../OptionPicker';
import { SettingsSection } from '../SettingsSection';
import { hostName, sortedHosts } from './HostSwitcher';
import { ButtonRow, ErrorLine, Field, Row, SettingsButton } from './ui';

interface Pending {
  hostId: string;
  message: string;
}

/** Where the Manager works when no folder is set (spec/06 § Where special threads run). */
export const DEFAULT_MANAGER_FOLDER_LABEL = '~/.patch/threads/manager';

export function ManagerHomeSection({ folder }: { folder: string }): React.ReactElement {
  const hosts = usePresenceStore((s) => s.hosts);
  const [current, setCurrent] = React.useState<string | null | undefined>(undefined);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    api.managerHome().then(
      (r) => live && setCurrent(r.hostId),
      (e: Error) => live && setLoadError(e.message),
    );
    return () => {
      live = false;
    };
  }, []);

  const nameOf = (id: string): string => {
    const h = hosts[id];
    return h ? hostName(h) : id;
  };
  const options = sortedHosts(hosts).map((h) => ({ id: h.hostId, label: hostName(h) }));

  const choose = async (hostId: string): Promise<void> => {
    if (hostId === current) return;
    setBusy(true);
    try {
      const { message } = await api.managerHomeDraft(hostId);
      setPending({ hostId, message });
    } catch (e) {
      Alert.alert('Couldn’t prepare the move', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const move = async (): Promise<void> => {
    if (!pending) return;
    setBusy(true);
    try {
      await api.setManagerHome(pending.hostId, pending.message);
      setCurrent(pending.hostId);
      setPending(null);
    } catch (e) {
      Alert.alert('Move failed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shown = pending?.hostId ?? current ?? null;
  return (
    <SettingsSection title="Home" testID="settings-manager-home">
      <Row
        title="Home host"
        subtitle="Runs the Manager and Speakers"
        right={
          <OptionPicker
            testID="manager-home"
            selectedId={shown ?? ''}
            selectedLabel={shown === null ? 'No host' : nameOf(shown)}
            options={options}
            onSelect={(id) => void choose(id)}
            emptyText="No hosts"
            disabled={current == null || busy || pending !== null}
          />
        }
      >
        {loadError !== null ? (
          <ErrorLine
            testID="manager-home-error"
            message={`Couldn’t load the home host: ${loadError}`}
          />
        ) : null}
      </Row>
      {pending && current ? (
        <Row
          testID="manager-home-handover"
          title={`Move from ${nameOf(current)} to ${nameOf(pending.hostId)}`}
          subtitle="A fresh session starts there. This message is sent to it first; edit or clear it."
          stack
        >
          <Field
            testID="manager-home-message"
            accessibilityLabel="Handover message"
            multiline
            value={pending.message}
            placeholder="No message: the new session starts with no context"
            onChangeText={(text) => setPending({ ...pending, message: text })}
            style={{ minHeight: 160, textAlignVertical: 'top' }}
          />
          <ButtonRow>
            <SettingsButton
              testID="manager-home-cancel"
              label="Cancel"
              variant="quiet"
              disabled={busy}
              onPress={() => setPending(null)}
            />
            <SettingsButton
              testID="manager-home-move"
              label={`Move to ${nameOf(pending.hostId)}`}
              disabled={busy}
              onPress={() => void move()}
            />
          </ButtonRow>
        </Row>
      ) : null}
      <ManagerFolderRow folder={folder} />
    </SettingsSection>
  );
}

/**
 * Home → Folder (spec/06 § Manager prompt and folder): the path, with Change
 * opening a path field. The server checks it on the home host before saving
 * it, and its refusal is shown under the field.
 */
function ManagerFolderRow({ folder }: { folder: string }): React.ReactElement {
  const [draft, setDraft] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const save = async (): Promise<void> => {
    if (draft === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await useSettingsStore.getState().updatePreferences({ managerFolder: draft.trim() });
      setDraft(null);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (draft === null) {
    return (
      <Row
        testID="manager-folder"
        title="Folder"
        subtitle={folder === '' ? DEFAULT_MANAGER_FOLDER_LABEL : folder}
        subtitleTestID="manager-folder-path"
        right={
          <SettingsButton
            testID="manager-folder-change"
            label="Change"
            onPress={() => {
              setProblem(null);
              setDraft(folder);
            }}
          />
        }
      />
    );
  }
  return (
    <Row testID="manager-folder" title="Folder" stack>
      <Field
        testID="manager-folder-input"
        accessibilityLabel="Manager folder"
        value={draft}
        placeholder={DEFAULT_MANAGER_FOLDER_LABEL}
        editable={!busy}
        onChangeText={setDraft}
        onSubmitEditing={() => void save()}
      />
      {problem !== null ? <ErrorLine testID="manager-folder-error" message={problem} /> : null}
      <ButtonRow>
        <SettingsButton
          testID="manager-folder-cancel"
          label="Cancel"
          variant="quiet"
          disabled={busy}
          onPress={() => setDraft(null)}
        />
        <SettingsButton
          testID="manager-folder-save"
          label="Save"
          disabled={busy}
          onPress={() => void save()}
        />
      </ButtonRow>
    </Row>
  );
}
