// Settings → Goals (spec/14 § `/settings` details — Goals, spec/04 § Goals):
// how a chat's goal is judged and when it gives up on an agent that will not do
// the work. Account-wide: the judge runs on each chat's own host, which takes
// these from the shared settings.

import type { JSX } from 'react';
import { DEFAULT_GOAL_EVAL_PROMPT, GOAL_STRINGENCIES, GOAL_STRINGENCY_LABELS } from '@patch/wire';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { failed } from '../../lib/errorCopy.js';
import { useModelOptions } from './modelOptions.js';
import { Group, Row, SettingsPage } from './ui.js';
import { PromptRow } from './PromptRow.js';
import { patchShared } from './sharedWrite.js';
import { PositiveNumberInput } from './PositiveNumberInput.js';

export function GoalsPage(): JSX.Element {
  const preferences = usePreferencesStore((s) => s.preferences);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  const judgeModel = useModelOptions(preferences.goalModel);

  const write = (patch: Parameters<typeof update>[0]): void => {
    void update(patch).catch((e: Error) => pushError(failed('settings'), undefined, e.message));
  };

  return (
    <SettingsPage
      title="Goals"
      intro="How a chat's goal is judged, and when it stops pushing."
      testid="settings-goals-page"
    >
      <Group label="Goals" testid="settings-goals-group">
        <Row title="Judge model">
          <select
            aria-label="Goal judge model"
            value={preferences.goalModel}
            disabled={!loaded}
            data-testid="goal-model"
            onChange={(e) => write({ goalModel: e.target.value })}
          >
            {judgeModel.options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="set-unit">judges every chat, whatever model the chat runs</span>
        </Row>
        <Row title="Stringency">
          <select
            aria-label="Goal judge stringency"
            value={preferences.goalStringency}
            disabled={!loaded}
            data-testid="goal-stringency"
            onChange={(e) => write({ goalStringency: Number(e.target.value) as 1 | 2 | 3 })}
          >
            {GOAL_STRINGENCIES.map((n) => (
              <option key={n} value={n}>
                {n} · {GOAL_STRINGENCY_LABELS[n]}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Stop after">
          <PositiveNumberInput
            integer
            ariaLabel="Refusals in a row before a goal stops pushing"
            value={preferences.goalRefusalLimit}
            disabled={!loaded}
            testid="goal-refusal-limit"
            onCommit={(next) => write({ goalRefusalLimit: next })}
          />
          <span className="set-unit">refusals in a row</span>
        </Row>
        <PromptRow
          id="goal-judge"
          title="Judge prompt"
          sub="The judge's instructions. Patch adds the goal, the conversation and the answer format around them."
          defaultText={DEFAULT_GOAL_EVAL_PROMPT}
          current={preferences.goalEvalPrompt}
          onSave={(text) => patchShared('goal judge prompt', { goalEvalPrompt: text })}
          onDefault={() =>
            patchShared('goal judge prompt', { goalEvalPrompt: DEFAULT_GOAL_EVAL_PROMPT })
          }
        />
      </Group>
    </SettingsPage>
  );
}
