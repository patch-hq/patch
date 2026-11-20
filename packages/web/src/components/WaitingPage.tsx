// WaitingPage — what agents are waiting on right now (spec/14 § Waiting view).
// One row per wait: the chat, what it is waiting for (a time, or a trigger
// firing) and what it will do then. Click a row to open the chat.

import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Job } from '@patch/wire/jobs';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { deriveChatTitle } from '../lib/chatTitle.js';
import { deriveWaiting, type WaitingRow } from '../lib/waiting.js';
import { relativeTime } from '../lib/relativeTime.js';
import { formatWakeCountdown } from './WakeBar.js';
import { NavHistoryControls } from './NavHistoryControls.js';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function Row({ row, name, now }: { row: WaitingRow; name: string; now: number }): JSX.Element {
  const showChat = useLayoutStore((s) => s.showChat);
  const when =
    row.kind === 'time'
      ? row.held
        ? 'after the current turn'
        : formatWakeCountdown(row.fireAt - now)
      : `since ${relativeTime(row.createdAt, { now })}`;
  return (
    <li>
      <button
        type="button"
        className="waiting-row"
        data-testid={`waiting-row-${row.key}`}
        data-kind={row.kind}
        onClick={() => showChat(row.chatId)}
      >
        <span className="waiting-chat">{name}</span>
        <span className="waiting-what">
          {row.kind === 'time' ? row.message : `${row.trigger} · ${row.jobName}`}
        </span>
        <span className="waiting-chip">
          {row.kind === 'time' ? (row.every !== undefined ? 'Loop' : 'Timer') : 'Event'}
        </span>
        <span className="waiting-when">{when}</span>
      </button>
    </li>
  );
}

export function WaitingPage(): JSX.Element {
  const chats = useChatStore((s) => s.chats);
  const now = useNow(1000);
  const { data, error, isPending } = useQuery({
    queryKey: ['jobs'],
    queryFn: async () => (await api.listJobs()) as { jobs: Job[] },
  });
  const rows = useMemo(() => deriveWaiting(chats, data?.jobs ?? []), [chats, data]);

  return (
    <main className="waiting-route pads-route" data-testid="waiting-route">
      <header className="route-head">
        <div className="route-head-title">
          <NavHistoryControls />
        </div>
      </header>
      {error ? (
        <div className="route-error" data-testid="waiting-error">
          Failed to load jobs: {error instanceof Error ? error.message : String(error)}
        </div>
      ) : null}
      {isPending ? null : rows.length === 0 && !error ? (
        <p className="waiting-empty" data-testid="waiting-empty">
          Nothing is waiting.
        </p>
      ) : (
        <ul className="waiting-list">
          {rows.map((r) => (
            <Row
              key={r.key}
              row={r}
              now={now}
              name={deriveChatTitle(chats[r.chatId]?.name ?? null)}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
