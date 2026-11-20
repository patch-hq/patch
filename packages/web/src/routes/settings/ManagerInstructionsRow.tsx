// Settings → Manager → Prompts → Instructions: the Manager chat's CLAUDE.md
// (spec/06 § Where special threads run). It is a file the user owns on the
// Manager's home host, so it is read and saved through host files, over the
// version it was opened at: a file changed on the host since is refused, not
// overwritten.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/rest.js';
import { usePresenceStore } from '../../stores/presenceStore.js';
import { MANAGER_HOME_QUERY, serverSays } from './ManagerHomeGroup.js';
import { hostLabel } from './hostScope.js';

interface Loaded {
  path: string;
  content: string;
  version: string;
}

/** Where the Manager's CLAUDE.md lives under a host user's home. */
export function managerClaudeMdPath(home: string): string {
  return `${home.replace(/\/+$/, '')}/.patch/threads/manager/CLAUDE.md`;
}

export function ManagerInstructionsRow(): JSX.Element {
  const home = useQuery({ queryKey: MANAGER_HOME_QUERY, queryFn: () => api.managerHome() });
  const hostId = home.data?.hostId ?? null;
  const host = usePresenceStore((s) => (hostId ? s.hosts[hostId] : undefined));
  const online = host?.online === true;

  const [file, setFile] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (id: string): Promise<void> => {
    setProblem(null);
    try {
      const { path } = await api.hostFilesList(id);
      const read = await api.hostFileRead(id, managerClaudeMdPath(path));
      setFile({ path: read.path, content: read.content, version: read.version });
    } catch (e) {
      setFile(null);
      setProblem(serverSays(e));
    }
  };

  useEffect(() => {
    setFile(null);
    setDraft(null);
    if (hostId && online) void load(hostId);
  }, [hostId, online]);

  const save = async (): Promise<void> => {
    if (!hostId || !file || draft === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const saved = await api.hostFileWrite(hostId, {
        path: file.path,
        content: draft,
        baseVersion: file.version,
      });
      setFile({ path: saved.path, content: draft, version: saved.version });
      setDraft(null);
    } catch (e) {
      setProblem(
        e instanceof ApiError && e.status === 409
          ? 'The file changed on the host since it was opened. Reload it, then make your edit again.'
          : serverSays(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const where = hostId ? (host ? hostLabel(host) : hostId) : null;
  const sub = where
    ? `The Manager chat's CLAUDE.md on ${where}. Its agent reads it at the start of each session.`
    : 'The Manager chat’s CLAUDE.md, on its home host.';

  return (
    <div className="set-row stack" data-testid="manager-instructions">
      <div className="set-row-head">
        <div className="set-row-text">
          <span className="set-row-title">Instructions</span>
          <span className="set-sub">{sub}</span>
        </div>
        {file && draft === null ? (
          <button
            type="button"
            className="set-btn ghost"
            data-testid="manager-instructions-edit"
            onClick={() => setDraft(file.content)}
          >
            Edit
          </button>
        ) : null}
      </div>
      {!hostId ? (
        <span className="set-sub" data-testid="manager-instructions-no-home">
          Choose a home host above first.
        </span>
      ) : !online ? (
        <span className="set-sub" data-testid="manager-instructions-offline">
          {where} is offline, so its file can’t be read right now.
        </span>
      ) : problem ? (
        <div className="set-actions">
          <span className="set-sub" role="alert" data-testid="manager-instructions-problem">
            {problem}
          </span>
          <button
            type="button"
            className="set-btn ghost"
            data-testid="manager-instructions-reload"
            onClick={() => {
              setDraft(null);
              void load(hostId);
            }}
          >
            Reload
          </button>
        </div>
      ) : null}
      {file && draft !== null ? (
        <>
          <textarea
            aria-label="Manager instructions"
            data-testid="manager-instructions-text"
            value={draft}
            rows={16}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="set-actions">
            <button
              type="button"
              className="set-btn ghost"
              data-testid="manager-instructions-cancel"
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="set-btn primary"
              data-testid="manager-instructions-save"
              disabled={busy || draft === file.content}
              onClick={() => void save()}
            >
              Save
            </button>
          </div>
        </>
      ) : file ? (
        <pre
          className={file.content.trim() ? 'set-pre' : 'set-pre default'}
          data-testid="manager-instructions-shown"
        >
          {file.content.trim() ? file.content : 'Empty. The Manager runs on Patch’s own guidance.'}
        </pre>
      ) : null}
    </div>
  );
}
