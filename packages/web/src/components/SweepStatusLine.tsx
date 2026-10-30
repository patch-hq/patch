// The Manager view's slim sweep-status line (spec/06 § The sweep — "Visible"):
// "Last sweep 14:30 · answered 2 · digest 1", expandable to what it did to
// which chat, plus a "Check now" button. Local component state — one
// account, one sweep loop, nothing else on the page needs this.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type SweepRun } from '../api/rest.js';
import { useUiStore } from '../stores/uiStore.js';
import { failed } from '../lib/errorCopy.js';

function summarize(run: SweepRun): string {
  const counts: Record<string, number> = {};
  for (const a of run.actions) counts[a.action] = (counts[a.action] ?? 0) + 1;
  const parts: string[] = [];
  if (counts['answer']) parts.push(`answered ${counts['answer']}`);
  if (counts['digest']) parts.push(`digest ${counts['digest']}`);
  if (parts.length === 0) return 'nothing to do';
  return parts.join(' · ');
}

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const RUNS_SHOWN = 10;

function ActionRows({ run, first }: { run: SweepRun; first: boolean }): JSX.Element {
  const navigate = useNavigate();
  if (run.error) return <div className="sweep-status-error">{run.error}</div>;
  if (run.actions.length === 0) return <div className="sweep-status-empty">Nothing changed.</div>;
  return (
    <>
      {run.actions.map((a) => (
        <button
          type="button"
          key={a.chatId}
          className="sweep-status-row"
          data-testid={
            first ? `sweep-status-row-${a.chatId}` : `sweep-status-row-${run.runId}-${a.chatId}`
          }
          onClick={() => navigate(`/chats/${a.chatId}`)}
        >
          {a.action} · {a.chatId}
          {a.detail ? <span className="sweep-status-detail-text"> — {a.detail}</span> : null}
        </button>
      ))}
    </>
  );
}

export function SweepStatusLine(): JSX.Element {
  const [runs, setRuns] = useState<SweepRun[] | undefined>(undefined); // undefined = loading
  const [expanded, setExpanded] = useState(false);
  const [checking, setChecking] = useState(false);
  const pushError = useUiStore((s) => s.pushError);

  const load = (): void => {
    void api
      .getSweepRuns(RUNS_SHOWN)
      .then((res) => setRuns(res.runs))
      .catch((e: Error) => pushError(failed('sweep status'), undefined, e.message));
  };

  useEffect(load, []);
  const last = runs === undefined ? undefined : (runs[0] ?? null);

  const checkNow = (): void => {
    setChecking(true);
    void api
      .checkSweepNow()
      .then(() => load())
      .catch((e: Error) => pushError(failed('check now'), undefined, e.message))
      .finally(() => setChecking(false));
  };

  return (
    <div className="sweep-status" data-testid="sweep-status">
      <button
        type="button"
        className="sweep-status-summary"
        data-testid="sweep-status-summary"
        onClick={() => setExpanded((v) => !v)}
        disabled={last === undefined || last === null}
      >
        {last === undefined
          ? 'Sweep —'
          : last === null
            ? 'No sweeps yet'
            : `Last sweep ${hhmm(last.at)} · ${summarize(last)}${last.error ? ' · failed' : ''}`}
      </button>
      <button
        type="button"
        className="sweep-status-check-now"
        data-testid="sweep-check-now"
        onClick={checkNow}
        disabled={checking}
      >
        Check now
      </button>
      {expanded && runs && last ? (
        <div className="sweep-status-detail" data-testid="sweep-status-detail">
          <ActionRows run={last} first />
          {runs.slice(1).map((run) => (
            <div key={run.runId} data-testid={`sweep-status-earlier-${run.runId}`}>
              <div className="sweep-status-earlier">
                {hhmm(run.at)} · {summarize(run)}
                {run.error ? ' · failed' : ''}
              </div>
              <ActionRows run={run} first={false} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
