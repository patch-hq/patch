// Settings → Bug reports: the switch for automatic GitHub issues (off unless
// turned on), and the Report a bug form. Neither ever sends a prompt or chat
// content: automatic reports carry only an error's message and stack, a manual
// one only what is typed here plus the recent error messages listed beneath it.

import { useState, type JSX } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/rest.js';
import { Toggle } from '../../components/Toggle.js';
import { BUILD_INFO } from '../../lib/buildInfo.js';
import { useUiStore } from '../../stores/uiStore.js';
import { problemText } from './sharedWrite.js';
import { Group, Row, SettingsPage } from './ui.js';

export function BugReportsPage(): JSX.Element {
  const qc = useQueryClient();
  const pushError = useUiStore((s) => s.pushError);
  const errors = useUiStore((s) => s.errors);
  const { data: status } = useQuery({
    queryKey: ['issue-reporting'],
    queryFn: () => api.issueReporting(),
    refetchInterval: 15_000,
  });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [sending, setSending] = useState(false);
  const [filedUrl, setFiledUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const recentErrors = errors.slice(-5).map((e) => e.message);

  async function toggle(next: boolean): Promise<void> {
    try {
      qc.setQueryData(['issue-reporting'], await api.setIssueReporting(next));
    } catch (e) {
      pushError(`bug reports: ${problemText(e)}`);
    }
  }

  async function send(): Promise<void> {
    setSending(true);
    setProblem(null);
    setFiledUrl(null);
    try {
      const res = await api.reportBug({
        title,
        description,
        surface: 'web',
        route: 'settings/bugs',
        build: BUILD_INFO.version,
        platform: navigator.userAgent.includes('Electron') ? 'desktop' : 'browser',
        recentErrors,
      });
      setFiledUrl(res.url);
      setTitle('');
      setDescription('');
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
      <Group label="Report a bug">
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
              value={title}
              data-testid="bug-title"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="set-field">
            <span className="set-row-title">Details</span>
            <textarea
              value={description}
              rows={4}
              data-testid="bug-description"
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {problem ? (
            <p className="set-error" role="alert" data-testid="bug-error">
              {problem}
            </p>
          ) : null}
          {filedUrl ? (
            <p data-testid="bug-filed">
              Filed:{' '}
              <a href={filedUrl} target="_blank" rel="noreferrer">
                {filedUrl}
              </a>
            </p>
          ) : null}
          <div className="set-actions">
            <span className="set-spacer" />
            <button
              type="submit"
              className="set-btn primary"
              data-testid="bug-send"
              disabled={sending || title.trim() === ''}
            >
              {sending ? 'Sending…' : 'Report a bug'}
            </button>
          </div>
        </form>
      </Group>
    </SettingsPage>
  );
}
