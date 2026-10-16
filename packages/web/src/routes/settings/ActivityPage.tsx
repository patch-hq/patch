// Settings → Activity — "things agents did": every cross-chat tool call
// (patch_send_to, patch_peek, patch_spawn, …) across every machine, read
// through each one's own bounded tool-calls.jsonl (GET /api/tool-log,
// mirroring patch_activity's /api/activity).

import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/rest.js';
import { useChatStore } from '../../stores/chatStore.js';
import { Group, Note, Row, SettingsPage } from './ui.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;
// The server's own cap (TOOL_LOG_MAX_PAGE_SIZE) — a day's worth of tool calls
// on a personal machine is never close to this, so "Load older" paging by day
// (below) only ever needs the truncated note as a backstop, not real paging.
const PAGE_SIZE = 500;

function problemText(err: unknown): string {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const message = (err.body as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** A chat's name if the mirror still knows it, else its bare id. */
function useChatLabel(): (chatId: string | undefined) => string | undefined {
  const chats = useChatStore((s) => s.chats);
  return (chatId) => {
    if (chatId === undefined) return undefined;
    const chat = chats[chatId];
    return chat?.name ?? chat?.folder ?? chatId;
  };
}

export function ActivityPage(): JSX.Element {
  const label = useChatLabel();
  // "Load older" pages a day at a time by sliding the whole window back —
  // simpler than resuming the API's own cursor, which pages FORWARD (for a
  // live-tailing caller catching up), the opposite direction from here.
  const [until] = useState(() => Date.now());
  const [since, setSince] = useState(() => until - WINDOW_MS);

  const { data, error, isLoading } = useQuery({
    queryKey: ['tool-log', since, until],
    queryFn: () => api.toolLog({ since, until, limit: PAGE_SIZE }),
  });

  const entries = data?.entries ?? [];

  return (
    <SettingsPage title="Activity" testid="settings-activity">
      <Group label="Things agents did" testid="settings-activity-list">
        {error ? (
          <Note testid="activity-error">Could not read activity: {problemText(error)}</Note>
        ) : isLoading ? (
          <Note>Loading…</Note>
        ) : entries.length === 0 ? (
          <Note testid="activity-empty">No tool calls in this window</Note>
        ) : null}
        {data?.truncated ? (
          <Note testid="activity-truncated">
            More than {PAGE_SIZE} calls in this window — some are not shown.
          </Note>
        ) : null}
        {[...entries].reverse().map((e, i) => (
          <Row
            // ts isn't unique (several calls can share a millisecond); the
            // position in this already-deduped page is.
            key={`${e.hostId}-${e.ts}-${i}`}
            testid={`activity-row-${i}`}
            title={`${e.tool}${e.ok ? '' : ` — ${e.err ?? 'failed'}`}`}
            sub={[
              new Date(e.ts).toLocaleString(),
              e.hostId,
              label(e.callerChatId) !== undefined ? `from ${label(e.callerChatId)}` : null,
              label(e.targetChatId) !== undefined ? `to ${label(e.targetChatId)}` : null,
            ]
              .filter((p) => p !== null)
              .join(' · ')}
            className={e.ok ? undefined : 'danger'}
          />
        ))}
      </Group>
      {entries.length > 0 ? (
        <div className="set-add-bar start">
          <button
            type="button"
            className="set-btn"
            data-testid="activity-load-older"
            onClick={() => setSince((s) => s - WINDOW_MS)}
          >
            Load older
          </button>
        </div>
      ) : null}
    </SettingsPage>
  );
}
