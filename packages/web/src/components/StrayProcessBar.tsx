// StrayProcessBar — processes this chat started outside Patch's tracked tools
// (spec/14 § Main chat panel — Stray process bar; spec/02 § Stray processes).
//
// A `nohup long-thing &` in a plain Bash call is neither a watch nor a refused
// background request, so nothing else shows it. This lists each one with its
// command and how long it has run, and ✕ stops it. Drawn through the shared
// StatusRow. Absent when there is nothing running, and absent on a host that
// cannot detect them (501) — a host-wide limit, not something about this chat.
// Any other failure is shown, never swallowed.

import { useCallback, useEffect, useState, type JSX } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import type { StrayProcessRow } from '@patch/wire';
import { api } from '../api/rest.js';
import { formatElapsed } from '../lib/backgroundTasks.js';
import { StatusRow } from './StatusRow.js';

const POLL_MS = 5_000;

export function StrayProcessBar({ chatId }: { chatId: string }): JSX.Element | null {
  const [rows, setRows] = useState<StrayProcessRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const apply = useCallback((res: { processes: StrayProcessRow[] }) => {
    if (!Array.isArray(res.processes)) {
      throw new Error('stray-processes response has no processes list');
    }
    setRows(res.processes);
    setError(null);
  }, []);
  const fail = useCallback((e: unknown) => {
    if ((e as { status?: number }).status === 501) {
      setUnsupported(true);
      return;
    }
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  useEffect(() => {
    setUnsupported(false);
    setRows([]);
    let alive = true;
    const load = (): void => {
      void (async () => {
        try {
          const res = await api.strayProcesses(chatId);
          if (alive) apply(res);
        } catch (e) {
          if (alive) fail(e);
        }
      })();
    };
    load();
    const poll = window.setInterval(load, POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      alive = false;
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [chatId, apply, fail]);

  async function stop(pid: number): Promise<void> {
    try {
      apply(await api.strayProcessStop(chatId, pid));
    } catch (e) {
      fail(e);
    }
  }

  if (unsupported) return null;
  const running = rows.filter((r) => r.running);
  const ended = rows.filter((r) => !r.running);
  if (error === null && running.length === 0 && ended.length === 0) return null;
  const shown = showEnded ? rows : running;

  return (
    <div data-testid="stray-process-bar" role="status">
      {error !== null ? (
        <StatusRow label="Processes" testId="stray-process-error">
          <span className="status-grow">{`Can't list background processes: ${error}`}</span>
        </StatusRow>
      ) : null}
      {shown.map((r) => (
        <StatusRow
          key={`${r.pid}-${r.startedAt}`}
          icon={
            r.running ? <LoaderCircle className="status-spinner" size={16} aria-hidden /> : null
          }
          label="Process"
          className={r.running ? '' : 'status-row-ended'}
          testId="stray-process-row"
          data-ended={r.running ? 'false' : 'true'}
          meta={
            r.running
              ? formatElapsed(r.startedAt, now)
              : `ended after ${formatElapsed(r.startedAt, r.endedAt ?? now)}`
          }
          action={
            r.running ? (
              <span
                data-testid="stray-process-kill"
                role="button"
                tabIndex={0}
                aria-label={`Stop process ${r.pid}`}
                title={`Stop process ${r.pid}`}
                onClick={() => void stop(r.pid)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  void stop(r.pid);
                }}
              >
                <X size={14} aria-hidden />
              </span>
            ) : null
          }
        >
          <span className="status-grow" data-testid="stray-process-command" title={r.command}>
            {r.command}
          </span>
        </StatusRow>
      ))}
      {ended.length > 0 ? (
        <StatusRow nested>
          <button
            type="button"
            className="status-link status-link-underline status-muted"
            data-testid="stray-process-show-ended"
            aria-pressed={showEnded}
            onClick={() => setShowEnded(!showEnded)}
          >
            {showEnded ? 'hide ended' : `show ended (${ended.length})`}
          </button>
        </StatusRow>
      ) : null}
    </div>
  );
}
