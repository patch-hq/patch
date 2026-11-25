// Settings → Chats: what patch does to a chat on its own — naming it, and
// summarising where it has got to after each turn. Both spend tokens, which
// is why they are switches; neither is about an account or a limit, which is
// why they are not on Usage. Shared settings (spec/01 § Settings).

import { useEffect, useState, type JSX } from 'react';
import { Toggle } from '../../components/Toggle.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { CHAT_SORTS, type GroupSort } from '../../lib/chatGroups.js';
import {
  accountsForBackend,
  BACKGROUND_ACCOUNT_AUTO,
  DEFAULT_CLEANUP_PERIOD_DAYS,
  parseSmallJobModels,
} from '@patch/wire';
import { patchShared } from './sharedWrite.js';
import { hourLabel } from '../../lib/snoozePresets.js';
import { Group, Row, SettingsPage } from './ui.js';

/**
 * The models the small one-shot jobs run on, set model first (spec/02 § Small
 * jobs). Committed on Enter or blur; a list the wire refuses is said and the
 * field goes back to what is saved.
 */
function SmallJobModelsRow(): JSX.Element {
  const saved = usePreferencesStore((s) => s.preferences.smallJobModels);
  const loaded = usePreferencesStore((s) => s.loaded);
  const pushError = useUiStore((s) => s.pushError);
  const text = saved.join(', ');
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  function commit(): void {
    if (draft.trim() === text) return;
    const parsed = parseSmallJobModels(draft);
    if ('error' in parsed) {
      pushError(`small-job models: ${parsed.error}`);
      setDraft(text);
      return;
    }
    void patchShared('small-job models', { smallJobModels: parsed.models }).then((ok) => {
      if (!ok) setDraft(text);
    });
  }
  return (
    <Row title="Models for small jobs" testid="small-job-models">
      <input
        type="text"
        aria-label="Models for small jobs"
        value={draft}
        disabled={!loaded}
        data-testid="small-job-models-input"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </Row>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function ChatsPage(): JSX.Element {
  const titleGen = usePreferencesStore((s) => s.preferences.titleGenerationEnabled);
  const statusGen = usePreferencesStore((s) => s.preferences.statusGenerationEnabled);
  const morning = usePreferencesStore((s) => s.preferences.snoozeMorningHour);
  const evening = usePreferencesStore((s) => s.preferences.snoozeEveningHour);
  const cleanupDays = usePreferencesStore((s) => s.preferences.cleanupPeriodDays);
  const backgroundAccount = usePreferencesStore((s) => s.preferences.backgroundAccount);
  const secrets = usePreferencesStore((s) => s.shared?.secrets);
  const claudeAccounts = accountsForBackend<{ id: string; label: string }>(secrets, 'claude-code');
  const loaded = usePreferencesStore((s) => s.loaded);
  const groupSort = useUiStore((s) => s.groupSort);
  const setGroupSort = useUiStore((s) => s.setGroupSort);
  return (
    <SettingsPage
      intro="Chat titles and status lines, clean-up, and how the sidebar is ordered."
      title="Chats"
      testid="settings-chats"
    >
      <Group>
        <Row title="Generate chat titles" testid="title-generation">
          <Toggle
            checked={titleGen}
            disabled={!loaded}
            onChange={(next) =>
              void patchShared('title generation', { titleGenerationEnabled: next })
            }
            testid="title-generation-toggle"
          />
        </Row>
        <Row title="Summarise chat status after each turn" testid="status-generation">
          <Toggle
            checked={statusGen}
            disabled={!loaded}
            onChange={(next) =>
              void patchShared('status generation', { statusGenerationEnabled: next })
            }
            testid="status-generation-toggle"
          />
        </Row>
        {/* Which Claude account titles and status run on (spec/10 § Choosing an account). */}
        <Row title="Account for titles and status" testid="background-account">
          <select
            aria-label="Account for titles and status"
            value={backgroundAccount}
            disabled={!loaded}
            data-testid="background-account-select"
            onChange={(e) =>
              void patchShared('account for titles and status', {
                backgroundAccount: e.target.value,
              })
            }
          >
            <option value={BACKGROUND_ACCOUNT_AUTO}>Automatic</option>
            {(claudeAccounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </Row>
        <SmallJobModelsRow />
      </Group>
      <Group label="Cleanup" testid="settings-cleanup">
        <Row title="Never delete chats or agent worktrees" testid="cleanup-never">
          <Toggle
            checked={cleanupDays === 0}
            disabled={!loaded}
            onChange={(never) =>
              void patchShared('cleanup period', {
                cleanupPeriodDays: never ? 0 : DEFAULT_CLEANUP_PERIOD_DAYS,
              })
            }
            testid="cleanup-never-toggle"
          />
        </Row>
        <Row title="Delete chats and stale agent worktrees after" testid="cleanup-period">
          <input
            type="number"
            min={1}
            className="set-num"
            aria-label="Cleanup period (days)"
            data-testid="cleanup-period-days"
            key={cleanupDays}
            defaultValue={cleanupDays === 0 ? '' : cleanupDays}
            disabled={!loaded || cleanupDays === 0}
            onBlur={(e) => setCleanupDays(e.target.value, cleanupDays)}
            onKeyDown={(e) => {
              if (e.key === 'Enter')
                setCleanupDays((e.target as HTMLInputElement).value, cleanupDays);
            }}
          />
          <span className="set-unit">days</span>
        </Row>
      </Group>
      <Group label="Sidebar" testid="settings-sidebar">
        <Row title="Order projects by" testid="group-sort">
          <select
            aria-label="Order projects by"
            value={groupSort}
            data-testid="group-sort-select"
            onChange={(e) => setGroupSort(e.target.value as GroupSort)}
          >
            <option value="same-as-chats">Same as chats</option>
            {CHAT_SORTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Row>
      </Group>
      <Group label="Snooze defaults" testid="settings-snooze">
        <Row title="Morning wake time (Tomorrow, Next Monday)" testid="snooze-morning">
          <HourSelect
            label="Snooze morning hour"
            value={morning}
            disabled={!loaded}
            testid="snooze-morning-hour"
            onChange={(h) => void patchShared('snooze morning hour', { snoozeMorningHour: h })}
          />
        </Row>
        <Row title="Evening wake time (same day)" testid="snooze-evening">
          <HourSelect
            label="Snooze evening hour"
            value={evening}
            disabled={!loaded}
            testid="snooze-evening-hour"
            onChange={(h) => void patchShared('snooze evening hour', { snoozeEveningHour: h })}
          />
        </Row>
      </Group>
    </SettingsPage>
  );
}

function setCleanupDays(raw: string, current: number): void {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n === current) return;
  void patchShared('cleanup period', { cleanupPeriodDays: n });
}

function HourSelect(props: {
  label: string;
  value: number;
  disabled: boolean;
  testid: string;
  onChange: (hour: number) => void;
}): JSX.Element {
  return (
    <select
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      data-testid={props.testid}
      onChange={(e) => props.onChange(Number(e.target.value))}
    >
      {HOURS.map((h) => (
        <option key={h} value={h}>
          {String(h).padStart(2, '0')}:00 ({hourLabel(h)})
        </option>
      ))}
    </select>
  );
}
