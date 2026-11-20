// The meeting's models and timing, shared by Settings → Meetings and the
// in-meeting settings.

import type { JSX } from 'react';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { useModelOptions } from './modelOptions.js';
import { PositiveNumberInput } from './PositiveNumberInput.js';
import { Row } from './ui.js';
import { patchShared } from './sharedWrite.js';
import type { AccountPreferences } from '../../api/rest.js';

/** A model picker row for one of the meeting's passes. */
function MeetingModelRow({
  title,
  field,
  testid,
  showProblem = false,
}: {
  title: string;
  /** The model list is one fetch: only one row says when it failed. */
  showProblem?: boolean;
  field: 'meetingAnalysisModel' | 'meetingCleanupModel' | 'meetingResearchModel';
  testid: string;
}): JSX.Element {
  const p = usePreferencesStore((s) => s.preferences);
  const loaded = usePreferencesStore((s) => s.loaded);
  const models = useModelOptions(p[field]);
  return (
    <Row
      title={title}
      sub={
        showProblem && models.problem ? (
          <span className="set-sub-error" role="alert" data-testid="meeting-model-problem">
            {models.problem.text}
          </span>
        ) : undefined
      }
    >
      <select
        aria-label={`Meeting ${title.toLowerCase()} model`}
        value={p[field]}
        disabled={!loaded}
        data-testid={testid}
        onChange={(e) => void patchShared('meeting settings', { [field]: e.target.value })}
      >
        {models.options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** The meeting's models, shared by this page and the in-meeting cog. */
export function MeetingModelRows(): JSX.Element {
  return (
    <>
      <MeetingModelRow
        title="Analysis"
        field="meetingAnalysisModel"
        testid="meeting-analysis-model"
        showProblem
      />
      <MeetingModelRow
        title="Clean-up"
        field="meetingCleanupModel"
        testid="meeting-cleanup-model"
      />
      <MeetingModelRow
        title="Research"
        field="meetingResearchModel"
        testid="meeting-research-model"
      />
    </>
  );
}

/** How often the meeting's passes run, shared by this page and the in-meeting cog. */
export function MeetingTimingRows(): JSX.Element {
  const p = usePreferencesStore((s) => s.preferences);
  const loaded = usePreferencesStore((s) => s.loaded);
  const write = (patch: Partial<AccountPreferences>): void => {
    void patchShared('meeting settings', patch);
  };
  return (
    <>
      <Row title="Update notes every">
        <PositiveNumberInput
          integer
          ariaLabel="Seconds between meeting analysis passes at Normal speed"
          value={p.meetingAnalyseSeconds}
          disabled={!loaded}
          testid="meeting-analyse-seconds"
          onCommit={(next) => {
            if (next >= 5 && next <= 300) write({ meetingAnalyseSeconds: next });
          }}
        />
        <span className="set-unit">seconds</span>
      </Row>
      <Row title="Research at most every">
        <PositiveNumberInput
          integer
          ariaLabel="Least seconds between meeting research passes"
          value={p.meetingResearchSeconds}
          disabled={!loaded}
          testid="meeting-research-seconds"
          onCommit={(next) => {
            if (next >= 15 && next <= 900) write({ meetingResearchSeconds: next });
          }}
        />
        <span className="set-unit">seconds</span>
      </Row>
    </>
  );
}
