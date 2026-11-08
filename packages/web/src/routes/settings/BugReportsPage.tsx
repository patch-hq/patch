// Settings → Bug reports: the switch for automatic GitHub issues (off unless
// turned on), and the Report a bug button, which opens a preview of the whole payload to edit. Neither ever sends a prompt or chat
// content: automatic reports carry only an error's message and stack, a manual
// one only what the person sees in the preview and confirms with Send.

import { useState, type JSX } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ManualIssueReport } from '../../api/rest.js';
import { Toggle } from '../../components/Toggle.js';
import { BUILD_INFO } from '../../lib/buildInfo.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { problemText } from './sharedWrite.js';
import { Group, Row, SettingsPage } from './ui.js';

type Draft = ManualIssueReport;

const CONTEXT_FIELDS: [
  keyof Draft & ('build' | 'platform' | 'surface' | 'route' | 'model'),
  string,
][] = [
  ['model', 'Model in use'],
  ['build', 'App version'],
  ['platform', 'Platform'],
  ['surface', 'Surface'],
  ['route', 'Screen'],
];

function firstDefaultModel(
  hosts: ReturnType<typeof usePresenceStore.getState>['hosts'],
): string | null {
  for (const h of Object.values(hosts)) if (h.host?.defaultModel) return h.host.defaultModel;
  return null;
}

export function BugReportsPage(): JSX.Element {
  const qc = useQueryClient();
  const pushError = useUiStore((s) => s.pushError);
  const errors = useUiStore((s) => s.errors);
  const { data: status } = useQuery({
    queryKey: ['issue-reporting'],
    queryFn: () => api.issueReporting(),
    refetchInterval: 15_000,
  });
  const hosts = usePresenceStore((st) => st.hosts);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sending, setSending] = useState(false);
  const [filedUrl, setFiledUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  function edit(patch: Partial<Draft>): void {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  }

  // The context a report carries, filled in for the person to read, change or
  // delete. Nothing here is sent until they press Send.
  function openPreview(): void {
    setProblem(null);
    setFiledUrl(null);
    setDraft({
      title: '',
      description: '',
      build: BUILD_INFO.version,
      platform: navigator.userAgent.includes('Electron') ? 'desktop' : 'browser',
      surface: 'web',
      route: 'settings/bugs',
      model: firstDefaultModel(hosts) ?? '',
      recentErrors: errors.slice(-5).map((e) => e.message),
    });
  }

  async function toggle(next: boolean): Promise<void> {
    try {
      qc.setQueryData(['issue-reporting'], await api.setIssueReporting(next));
    } catch (e) {
      pushError(`bug reports: ${problemText(e)}`);
    }
  }

  async function send(): Promise<void> {
    if (!draft) return;
    setSending(true);
    setProblem(null);
    try {
      const res = await api.reportBug(draft);
      setFiledUrl(res.url);
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['issue-reporting'] });
    } catch (e) {
      setProblem(problemText(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <SettingsPage title="Bug reports" testid="settings-bugs">
      <Group>
        <Row title="File errors automatically" testid="issue-reporting">
          <Toggle
            checked={status?.enabled ?? false}
            disabled={!status}
            onChange={(next) => void toggle(next)}
            testid="issue-reporting-toggle"
          />
        </Row>
        {status?.enabled && !status.tokenConfigured ? (
          <p className="set-error" role="alert" data-testid="issue-reporting-no-token">
            No GitHub token on the server (PATCH_ISSUE_GITHUB_TOKEN), so nothing can be filed.
          </p>
        ) : null}
        {status?.lastError && status.tokenConfigured ? (
          <p className="set-error" role="alert" data-testid="issue-reporting-error">
            {status.lastError}
          </p>
        ) : null}
        {status ? (
          <Row title="Filed / waiting" testid="issue-reporting-counts">
            <span data-testid="issue-reporting-counts-value">
              {status.filed} / {status.pending}
            </span>
          </Row>
        ) : null}
      </Group>
      <Group>
        <div className="set-row">
          <button
            type="button"
            className="set-btn"
            data-testid="bug-open"
            onClick={openPreview}
            disabled={draft !== null}
          >
            Report a bug
          </button>
        </div>
        {filedUrl ? (
          <p data-testid="bug-filed">
            Filed:{' '}
            <a href={filedUrl} target="_blank" rel="noreferrer">
              {filedUrl}
            </a>
          </p>
        ) : null}
      </Group>
      {draft ? (
        <Group label="Review before sending">
          <form
            className="set-row stack set-form"
            data-testid="bug-form"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label className="set-field">
              <span className="set-row-title">What went wrong</span>
              <input
                value={draft.title}
                data-testid="bug-title"
                onChange={(e) => edit({ title: e.target.value })}
              />
            </label>
            <label className="set-field">
              <span className="set-row-title">Details</span>
              <textarea
                value={draft.description}
                rows={4}
                data-testid="bug-description"
                onChange={(e) => edit({ description: e.target.value })}
              />
            </label>
            {CONTEXT_FIELDS.map(([key, label]) => (
              <label className="set-field" key={key}>
                <span className="set-row-title">{label}</span>
                <input
                  value={draft[key]}
                  data-testid={`bug-${key}`}
                  onChange={(e) => edit({ [key]: e.target.value })}
                />
              </label>
            ))}
            <div className="set-field">
              <span className="set-row-title">Recent errors</span>
              {draft.recentErrors.length === 0 ? <span>None</span> : null}
              {draft.recentErrors.map((msg, i) => (
                <div className="set-actions" key={`${i}-${msg}`} data-testid="bug-recent-error">
                  <span>{msg}</span>
                  <span className="set-spacer" />
                  <button
                    type="button"
                    className="set-btn"
                    data-testid="bug-recent-error-remove"
                    onClick={() =>
                      edit({ recentErrors: draft.recentErrors.filter((_, j) => j !== i) })
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            {problem ? (
              <p className="set-error" role="alert" data-testid="bug-error">
                {problem}
              </p>
            ) : null}
            <div className="set-actions">
              <span className="set-spacer" />
              <button
                type="button"
                className="set-btn"
                data-testid="bug-cancel"
                onClick={() => setDraft(null)}
                disabled={sending}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="set-btn primary"
                data-testid="bug-send"
                disabled={sending || draft.title.trim() === ''}
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        </Group>
      ) : null}
    </SettingsPage>
  );
}
