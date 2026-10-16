// Job defaults, on the Jobs page (spec/14 § Jobs view, spec/08 § Autonomy
// prompt): the default model and the one autonomy prompt every job's first
// user-turn is prefaced with, unless that job overrides it in its own editor.
// Account-wide: the dispatcher that reads them runs on the server.

import type { JSX } from 'react';
import { DEFAULT_JOB_AUTONOMY_PROMPT } from '@patch/wire/jobs';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { Group, Row } from './settings/ui.js';
import { LayerEditor } from './settings/AgentPage.js';
import { patchShared } from './settings/sharedWrite.js';
import { useModelOptions } from './settings/modelOptions.js';
import { useUiStore } from '../stores/uiStore.js';
import { failed } from '../lib/errorCopy.js';

export function JobDefaults(): JSX.Element {
  const prompt = usePreferencesStore((s) => s.preferences.jobAutonomyPrompt);
  return (
    <details className="job-defaults" data-testid="job-defaults">
      <summary>Defaults for all jobs</summary>
      <Group testid="job-defaults-group">
        <JobDefaultModelRow />
        <LayerEditor
          title="Autonomy prompt"
          sub={prompt.split('\n')[0] ?? ''}
          initial={prompt}
          testid="job-autonomy-prompt-default"
          placeholder={DEFAULT_JOB_AUTONOMY_PROMPT}
          onSave={(text) => patchShared('autonomy prompt', { jobAutonomyPrompt: text })}
          onReset={
            prompt === DEFAULT_JOB_AUTONOMY_PROMPT
              ? undefined
              : () =>
                  patchShared('autonomy prompt', { jobAutonomyPrompt: DEFAULT_JOB_AUTONOMY_PROMPT })
          }
        />
      </Group>
    </details>
  );
}

/** The model a job's chat runs on unless the job's own editor picks one. */
function JobDefaultModelRow(): JSX.Element {
  const value = usePreferencesStore((s) => s.preferences.jobDefaultModel);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  const { options, problem } = useModelOptions(value);
  return (
    <Row
      title="Default model for jobs"
      sub={
        problem ? (
          <span
            data-testid={
              problem.kind === 'no-host' ? 'job-default-model-no-host' : 'job-default-model-error'
            }
          >
            {problem.text}
          </span>
        ) : undefined
      }
    >
      <select
        id="job-default-model"
        aria-label="Default model for jobs"
        value={value}
        disabled={!loaded}
        data-testid="job-default-model"
        onChange={(e) => {
          void update({ jobDefaultModel: e.target.value }).catch((err: Error) =>
            pushError(failed('settings'), undefined, err.message),
          );
        }}
      >
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </Row>
  );
}
