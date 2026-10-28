// Settings → Prompts: every prompt Patch sends to an agent, in one place. Each
// shows the text in force and whether it is Patch's default or a custom
// version; switching to Custom opens the default for editing, and Default
// writes the built-in text back.

import { useState } from 'react';
import type { JSX } from 'react';
import {
  DEFAULT_GOAL_EVAL_PROMPT,
  DEFAULT_LINK_SUMMARY_PROMPT,
  DEFAULT_MEETING_ACTIONS_PROMPT,
  DEFAULT_MEETING_NOTES_PROMPT,
  DEFAULT_MEETING_NOW_PROMPT,
  DEFAULT_QUESTION_EXPIRED_PROMPT,
  DEFAULT_SWEEP_PROMPT,
  DEFAULT_WATCH_CHECK_IN_PROMPT,
} from '@patch/wire';
import { DEFAULT_JOB_AUTONOMY_PROMPT } from '@patch/wire/jobs';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { failed } from '../../lib/errorCopy.js';
import { useModelOptions } from './modelOptions.js';
import { PositiveNumberInput } from './PositiveNumberInput.js';
import { Group, Pills, Row, SettingsPage } from './ui.js';
import { patchShared } from './sharedWrite.js';

type Mode = 'default' | 'custom';

function PromptRow({
  id,
  title,
  sub,
  defaultText,
  current,
  onSave,
  onDefault,
}: {
  id: string;
  title: string;
  sub: string;
  /** What Patch sends when nothing is customised. */
  defaultText: string;
  /** The text in force; equal to `defaultText` while on the default. */
  current: string;
  onSave: (text: string) => Promise<boolean>;
  onDefault: () => Promise<boolean>;
}): JSX.Element {
  const custom = current !== defaultText;
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const mode: Mode = custom || editing ? 'custom' : 'default';

  const choose = (next: Mode): void => {
    if (next === 'custom') {
      setDraft(current);
      return;
    }
    void onDefault().then((ok) => {
      if (ok) setDraft(null);
    });
  };
  const save = (): void => {
    if (draft === null) return;
    void onSave(draft).then((ok) => {
      if (ok) setDraft(null);
    });
  };

  return (
    <div className="set-row stack" data-testid={`prompt-${id}`}>
      <div className="set-row-head">
        <div className="set-row-text">
          <span className="set-row-title">{title}</span>
          <span className="set-sub">{sub}</span>
        </div>
        <Pills
          label={`${title} version`}
          options={['default', 'custom'] as const}
          labels={{ default: 'Default', custom: 'Custom' }}
          value={mode}
          testid={`prompt-${id}-mode`}
          onChange={choose}
        />
      </div>
      {editing ? (
        <>
          <textarea
            aria-label={title}
            data-testid={`prompt-${id}-text`}
            value={draft}
            rows={10}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="set-actions">
            <button
              type="button"
              className="set-btn ghost"
              data-testid={`prompt-${id}-cancel`}
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="set-btn primary"
              data-testid={`prompt-${id}-save`}
              onClick={save}
            >
              Save
            </button>
          </div>
        </>
      ) : (
        <pre className="set-pre" data-testid={`prompt-${id}-shown`}>
          {current}
        </pre>
      )}
    </div>
  );
}

/** The meeting's models and timing, shared by this page and the in-meeting cog. */
export function MeetingModelRows(): JSX.Element {
  const p = usePreferencesStore((s) => s.preferences);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  const analysisModel = useModelOptions(p.meetingAnalysisModel);
  const cleanupModel = useModelOptions(p.meetingCleanupModel);
  const researchModel = useModelOptions(p.meetingResearchModel);
  const write = (patch: Parameters<typeof update>[0]): void => {
    void update(patch).catch((e: Error) => pushError(failed('settings'), undefined, e.message));
  };
  return (
    <>
      <Row title="Analysis model">
        <select
          aria-label="Meeting analysis model"
          value={p.meetingAnalysisModel}
          disabled={!loaded}
          data-testid="meeting-analysis-model"
          onChange={(e) => write({ meetingAnalysisModel: e.target.value })}
        >
          {analysisModel.options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="set-unit">writes the live notes</span>
      </Row>
      <Row title="Clean-up model">
        <select
          aria-label="Meeting clean-up model"
          value={p.meetingCleanupModel}
          disabled={!loaded}
          data-testid="meeting-cleanup-model"
          onChange={(e) => write({ meetingCleanupModel: e.target.value })}
        >
          {cleanupModel.options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="set-unit">repairs mis-heard names before the notes</span>
      </Row>
      <Row title="Research model">
        <select
          aria-label="Meeting research model"
          value={p.meetingResearchModel}
          disabled={!loaded}
          data-testid="meeting-research-model"
          onChange={(e) => write({ meetingResearchModel: e.target.value })}
        >
          {researchModel.options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="set-unit">looks things up on the web for the agent feed</span>
      </Row>
      <Row title="Transcription model">
        <input
          type="text"
          aria-label="Meeting transcription model"
          key={p.meetingTranscriptionModel}
          defaultValue={p.meetingTranscriptionModel}
          placeholder="Machine default"
          disabled={!loaded}
          data-testid="meeting-transcription-model"
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next !== p.meetingTranscriptionModel) write({ meetingTranscriptionModel: next });
          }}
        />
        <span className="set-unit">
          model directory (local) or Groq model name; empty is the host's
        </span>
      </Row>
      <Row title="Analyse every">
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
        <span className="set-unit">seconds, at Normal speed (5–300)</span>
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
        <span className="set-unit">seconds: each pass is a model plus web search (15–900)</span>
      </Row>
    </>
  );
}

export function PromptsPage(): JSX.Element {
  const p = usePreferencesStore((s) => s.preferences);
  // The tools guidance default is the host's own text.
  const toolsDefault = usePresenceStore(
    (s) =>
      Object.values(s.hosts).find((h) => h.host?.harnessToolsPromptDefault !== undefined)?.host
        ?.harnessToolsPromptDefault ?? '',
  );
  const tools = p.harnessToolsPrompt ?? toolsDefault;

  return (
    <SettingsPage title="Prompts" testid="settings-prompts-page">
      <Group testid="settings-prompts-group">
        <Row title="Background task check-in every">
          <PositiveNumberInput
            integer
            ariaLabel="Minutes between background task check-ins"
            value={p.watchCheckInMinutes}
            testid="watch-check-in-minutes"
            onCommit={(next) =>
              void patchShared('check-in interval', { watchCheckInMinutes: next })
            }
          />
          <span className="set-unit">minutes</span>
        </Row>
        <PromptRow
          id="watch-check-in"
          title="Background task check-in"
          sub="Sent to an agent while its background task runs. {description}, {running}, {lastOutput} and {taskId} are filled in."
          defaultText={DEFAULT_WATCH_CHECK_IN_PROMPT}
          current={p.watchCheckInPrompt}
          onSave={(text) => patchShared('check-in prompt', { watchCheckInPrompt: text })}
          onDefault={() =>
            patchShared('check-in prompt', { watchCheckInPrompt: DEFAULT_WATCH_CHECK_IN_PROMPT })
          }
        />
        <PromptRow
          id="sweep"
          title="Manager principles"
          sub="Which questions the Manager may answer for you when a chat goes idle."
          defaultText={DEFAULT_SWEEP_PROMPT}
          current={p.sweepPrompt}
          onSave={(text) => patchShared('sweep prompt', { sweepPrompt: text })}
          onDefault={() => patchShared('sweep prompt', { sweepPrompt: DEFAULT_SWEEP_PROMPT })}
        />
        <PromptRow
          id="goal-judge"
          title="Goal judge"
          sub="How a chat's goal is judged met or not."
          defaultText={DEFAULT_GOAL_EVAL_PROMPT}
          current={p.goalEvalPrompt}
          onSave={(text) => patchShared('goal judge prompt', { goalEvalPrompt: text })}
          onDefault={() =>
            patchShared('goal judge prompt', { goalEvalPrompt: DEFAULT_GOAL_EVAL_PROMPT })
          }
        />
        <PromptRow
          id="link-summary"
          title="Link summary"
          sub="What the Summarise button beside a message link runs with."
          defaultText={DEFAULT_LINK_SUMMARY_PROMPT}
          current={p.linkSummaryPrompt}
          onSave={(text) => patchShared('link summary prompt', { linkSummaryPrompt: text })}
          onDefault={() =>
            patchShared('link summary prompt', { linkSummaryPrompt: DEFAULT_LINK_SUMMARY_PROMPT })
          }
        />
        <PromptRow
          id="job-autonomy"
          title="Job autonomy"
          sub="Prefaces every job's first message unless the job has its own."
          defaultText={DEFAULT_JOB_AUTONOMY_PROMPT}
          current={p.jobAutonomyPrompt}
          onSave={(text) => patchShared('autonomy prompt', { jobAutonomyPrompt: text })}
          onDefault={() =>
            patchShared('autonomy prompt', { jobAutonomyPrompt: DEFAULT_JOB_AUTONOMY_PROMPT })
          }
        />
        <PromptRow
          id="question-expired"
          title="Question timed out"
          sub="Told to an agent when a question it asked goes unanswered. {seconds} is the window."
          defaultText={DEFAULT_QUESTION_EXPIRED_PROMPT}
          current={p.questionExpiredPrompt}
          onSave={(text) => patchShared('question timeout prompt', { questionExpiredPrompt: text })}
          onDefault={() =>
            patchShared('question timeout prompt', {
              questionExpiredPrompt: DEFAULT_QUESTION_EXPIRED_PROMPT,
            })
          }
        />
        <PromptRow
          id="tools"
          title="Patch tools guidance"
          sub="How agents are told to use Patch's own tools. Empty turns it off."
          defaultText={toolsDefault}
          current={tools}
          onSave={(text) => patchShared('tools prompt', { harnessToolsPrompt: text })}
          onDefault={() => patchShared('tools prompt', { harnessToolsPrompt: null })}
        />
        <PromptRow
          id="system"
          title="System prompt"
          sub="Replaces Claude Code's own system prompt for every chat. Default leaves it alone."
          defaultText=""
          current={p.harnessSystemPrompt}
          onSave={(text) => patchShared('system prompt', { harnessSystemPrompt: text })}
          onDefault={() => patchShared('system prompt', { harnessSystemPrompt: '' })}
        />
      </Group>
      <Group label="Meetings" testid="settings-prompts-meetings">
        <MeetingModelRows />
        <PromptRow
          id="meeting-now"
          title="Meeting: Now"
          sub="How the live Now block is written. Also editable from the meeting page."
          defaultText={DEFAULT_MEETING_NOW_PROMPT}
          current={p.meetingNowPrompt}
          onSave={(text) => patchShared('meeting: now prompt', { meetingNowPrompt: text })}
          onDefault={() =>
            patchShared('meeting: now prompt', { meetingNowPrompt: DEFAULT_MEETING_NOW_PROMPT })
          }
        />
        <PromptRow
          id="meeting-notes"
          title="Meeting: Notes"
          sub="How the key-point topics are written and condensed."
          defaultText={DEFAULT_MEETING_NOTES_PROMPT}
          current={p.meetingNotesPrompt}
          onSave={(text) => patchShared('meeting: notes prompt', { meetingNotesPrompt: text })}
          onDefault={() =>
            patchShared('meeting: notes prompt', {
              meetingNotesPrompt: DEFAULT_MEETING_NOTES_PROMPT,
            })
          }
        />
        <PromptRow
          id="meeting-actions"
          title="Meeting: Actions"
          sub="What counts as an action card."
          defaultText={DEFAULT_MEETING_ACTIONS_PROMPT}
          current={p.meetingActionsPrompt}
          onSave={(text) => patchShared('meeting: actions prompt', { meetingActionsPrompt: text })}
          onDefault={() =>
            patchShared('meeting: actions prompt', {
              meetingActionsPrompt: DEFAULT_MEETING_ACTIONS_PROMPT,
            })
          }
        />
      </Group>
    </SettingsPage>
  );
}
