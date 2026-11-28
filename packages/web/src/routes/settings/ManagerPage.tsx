// Settings → Manager: account-wide preferences for the Manager and the
// Manager/Speakers threads (spec/14 § `/settings` details — Manager,
// spec/06 § Session rotation). Account-wide, not per host or surface: the loops
// that act on them run on the server, so they are read from and written back
// to it.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_MANAGER_PROMPT,
  DEFAULT_MANAGER_VOICE_PROMPT,
  SPECIAL_THREAD_IDS,
  type ManagerWake,
} from '@patch/wire';
import { api } from '../../api/rest.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { Toggle } from '../../components/Toggle.js';
import { useModelOptions } from './modelOptions.js';
import { Group, Pills, Row, SettingsPage } from './ui.js';
import { patchShared } from './sharedWrite.js';
import { failed } from '../../lib/errorCopy.js';
import { PositiveNumberInput } from './PositiveNumberInput.js';
import { BatchIntervalSlider } from './BatchIntervalSlider.js';
import { ManagerHomeGroup, serverSays } from './ManagerHomeGroup.js';
import { PromptRow } from './PromptRow.js';

const WAKE_LABELS: Record<ManagerWake, string> = {
  off: 'Off',
  each: 'Each one',
  batched: 'Batched',
};

export const MANAGER_SESSION_QUERY = ['manager-session'] as const;

/** `today 09:12`, `yesterday 18:40`, `3 Nov 09:12`. */
export function sessionStarted(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = (t: number): string => new Date(t).toDateString();
  if (day(at) === day(now)) return `today ${time}`;
  if (day(at) === day(now - 86_400_000)) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * Context → This session (spec/06 § Bounded context): the current session's
 * message count and start, and Clear, a fresh session with nothing carried.
 */
function ManagerSessionRow(): JSX.Element {
  const queryClient = useQueryClient();
  const pushError = useUiStore((s) => s.pushError);
  const [busy, setBusy] = useState(false);
  const chat = useQuery({
    queryKey: MANAGER_SESSION_QUERY,
    queryFn: () => api.getChat(SPECIAL_THREAD_IDS.manager),
    refetchInterval: 30_000,
  });
  const session = chat.data?.session;
  let sub: JSX.Element | string;
  if (chat.isError) {
    sub = (
      <span className="set-sub-error" data-testid="manager-session-error">
        {serverSays(chat.error)}
      </span>
    );
  } else if (!chat.isSuccess) {
    sub = 'Loading…';
  } else if (session === undefined) {
    sub = 'Not reported by the home host yet';
  } else if (session === null) {
    sub = 'No session yet';
  } else {
    sub = `${session.messages} message${session.messages === 1 ? '' : 's'} · started ${sessionStarted(session.startedAt)}`;
  }

  async function clear(): Promise<void> {
    setBusy(true);
    try {
      await api.rotateChat(SPECIAL_THREAD_IDS.manager, { carry: false });
      await queryClient.invalidateQueries({ queryKey: MANAGER_SESSION_QUERY });
    } catch (e) {
      pushError(failed('clearing the Manager’s session'), undefined, serverSays(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row title="This session" sub={sub} testid="manager-session">
      <button
        type="button"
        className="set-link"
        data-testid="manager-clear"
        disabled={busy || !session}
        onClick={() => void clear()}
      >
        Clear
      </button>
    </Row>
  );
}

export function ManagerPage(): JSX.Element {
  const preferences = usePreferencesStore((s) => s.preferences);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  const [addressWord, setAddressWord] = useState(preferences.addressWord);
  const model = useModelOptions(preferences.specialThreadModel);

  // Track the server's value until the field is actually edited, so a load
  // arriving after mount is not left showing a stale word.
  useEffect(() => {
    setAddressWord(preferences.addressWord);
  }, [preferences.addressWord]);

  const write = (patch: Parameters<typeof update>[0]): void => {
    void update(patch).catch((e: Error) => pushError(failed('settings'), undefined, e.message));
  };

  return (
    <SettingsPage
      title="Manager"
      intro="The chat that keeps an eye on all the others: where it runs, what it's told, and its voice."
      experimental
      testid="settings-manager-page"
    >
      <ManagerHomeGroup />

      <Group label="Prompts" testid="settings-manager-prompts">
        <PromptRow
          id="manager"
          title="Prompt"
          defaultText={DEFAULT_MANAGER_PROMPT}
          current={preferences.managerPrompt}
          onSave={(text) => patchShared('Manager prompt', { managerPrompt: text })}
          onDefault={() => patchShared('Manager prompt', { managerPrompt: DEFAULT_MANAGER_PROMPT })}
        />
        <PromptRow
          id="manager-voice"
          title="Voice"
          sub="Who the voice is on a call to the Manager. The rules for its tools are added after this."
          defaultText={DEFAULT_MANAGER_VOICE_PROMPT}
          current={preferences.managerVoicePrompt}
          onSave={(text) => patchShared('Manager voice prompt', { managerVoicePrompt: text })}
          onDefault={() =>
            patchShared('Manager voice prompt', {
              managerVoicePrompt: DEFAULT_MANAGER_VOICE_PROMPT,
            })
          }
        />
      </Group>

      <Group label="Finished chats" testid="settings-manager-wake">
        <Row title="Send to the Manager">
          <Pills
            label="Send finished chats"
            options={['off', 'each', 'batched'] as const}
            labels={WAKE_LABELS}
            value={preferences.managerWake}
            disabled={!loaded}
            testid="manager-wake-mode"
            onChange={(next) => write({ managerWake: next })}
          />
        </Row>
        <Row title="Every">
          <BatchIntervalSlider
            value={preferences.managerWakeIntervalMinutes}
            disabled={!loaded || preferences.managerWake !== 'batched'}
            testid="manager-wake-interval"
            onCommit={(next) => write({ managerWakeIntervalMinutes: next })}
          />
        </Row>
      </Group>

      <Group label="Context" testid="settings-manager-context">
        <ManagerSessionRow />
        <Row title="Start fresh after">
          <PositiveNumberInput
            ariaLabel="Start a fresh session after (messages)"
            value={preferences.managerContextWindow}
            disabled={!loaded}
            integer
            testid="manager-context-window"
            onCommit={(next) => write({ managerContextWindow: next })}
          />
          <span className="set-unit" data-testid="manager-context-window-unit">
            messages, keeping the last{' '}
            {Math.max(1, Math.floor(preferences.managerContextWindow / 2))}
          </span>
        </Row>
      </Group>

      <Group label="Manager" testid="settings-manager">
        <Row title="Quiet hours">
          <input
            id="quiet-start"
            type="time"
            aria-label="Quiet hours start"
            value={preferences.quietHoursStart}
            disabled={!loaded}
            data-testid="manager-quiet-start"
            onChange={(e) => write({ quietHoursStart: e.target.value })}
          />
          <span className="set-unit">–</span>
          <input
            type="time"
            aria-label="Quiet hours end"
            value={preferences.quietHoursEnd}
            disabled={!loaded}
            data-testid="manager-quiet-end"
            onChange={(e) => write({ quietHoursEnd: e.target.value })}
          />
        </Row>
        <Row title="Address word">
          <input
            id="address-word"
            type="text"
            aria-label="Address word"
            className="set-word"
            value={addressWord}
            disabled={!loaded}
            data-testid="manager-address-word"
            onChange={(e) => setAddressWord(e.target.value)}
            onBlur={() => {
              const next = addressWord.trim();
              if (next === '' || next === preferences.addressWord) {
                setAddressWord(preferences.addressWord);
                return;
              }
              write({ addressWord: next });
            }}
          />
        </Row>
      </Group>

      {/* The special threads' model + scheduled session rotation. Separate from
          "Model for new chats" because it governs a different thing — the
          always-on threads, not ad-hoc spawns — and grew out of a real
          incident: Manager sat on `claude-opus-5` for 18 days without a single
          auto-compaction, running ~750k cached tokens a turn. */}
      <Group label="Manager and Speakers threads" testid="settings-special-threads">
        <Row
          title="Model"
          sub={
            model.problem ? (
              <span
                data-testid={
                  model.problem.kind === 'no-host'
                    ? 'special-thread-model-no-host'
                    : 'special-thread-model-error'
                }
              >
                {model.problem.text}
              </span>
            ) : undefined
          }
        >
          <select
            id="special-thread-model"
            aria-label="Manager and Speakers model"
            value={preferences.specialThreadModel}
            disabled={!loaded}
            data-testid="special-thread-model"
            onChange={(e) => write({ specialThreadModel: e.target.value })}
          >
            {model.options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Start a fresh session daily">
          <Toggle
            checked={preferences.rotationEnabled}
            disabled={!loaded}
            onChange={(next) => write({ rotationEnabled: next })}
            testid="rotation-enabled"
          />
        </Row>
        <Row title="At">
          <input
            id="rotation-time"
            type="time"
            aria-label="Fresh session at"
            value={preferences.rotationTime}
            disabled={!loaded}
            data-testid="rotation-time"
            onChange={(e) => write({ rotationTime: e.target.value })}
          />
        </Row>
      </Group>
    </SettingsPage>
  );
}
