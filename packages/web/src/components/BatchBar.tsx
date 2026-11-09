// BatchBar — the batch toggle + timer under New chat (design preview; the
// server-owned schedule lands after the UI is approved). While Batch is on,
// every chat is in the batch and the chat list is held back until the next
// release time; BatchHeld is the placeholder that takes the list's place.

import type { JSX } from 'react';
import { Toggle } from './Toggle.js';
import { useBatchStore, type BatchSchedule } from '../stores/batchStore.js';

const SCHEDULES: { value: BatchSchedule; label: string }[] = [
  { value: 'every-30', label: 'Every 30 min' },
  { value: 'half-hour', label: 'On the hour and half hour' },
];

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function BatchBar(): JSX.Element {
  const enabled = useBatchStore((s) => s.enabled);
  const schedule = useBatchStore((s) => s.schedule);
  const nextReleaseAt = useBatchStore((s) => s.nextReleaseAt);
  const setEnabled = useBatchStore((s) => s.setEnabled);
  const setSchedule = useBatchStore((s) => s.setSchedule);

  return (
    <div className="batch-bar" data-testid="batch-bar">
      <div className="batch-bar-row">
        <Toggle checked={enabled} onChange={setEnabled} label="Batch" testid="batch-toggle" />
        {enabled && nextReleaseAt !== null ? (
          <span className="batch-bar-next" data-testid="batch-next">
            Next {formatTime(nextReleaseAt)}
          </span>
        ) : null}
      </div>
      {enabled ? (
        <select
          className="batch-bar-schedule"
          data-testid="batch-schedule"
          aria-label="Batch timer"
          value={schedule}
          onChange={(e) => setSchedule(e.target.value as BatchSchedule)}
        >
          {SCHEDULES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

export function BatchHeld({ count }: { count: number }): JSX.Element {
  const nextReleaseAt = useBatchStore((s) => s.nextReleaseAt);
  const releaseNow = useBatchStore((s) => s.releaseNow);
  return (
    <section className="batch-held" data-testid="batch-held">
      <div className="batch-held-title">
        {count} {count === 1 ? 'chat' : 'chats'} batched
      </div>
      {nextReleaseAt !== null ? (
        <div className="batch-held-sub">Back at {formatTime(nextReleaseAt)}</div>
      ) : null}
      <button
        type="button"
        className="batch-checkin-now-btn"
        data-testid="batch-release-now"
        onClick={releaseNow}
      >
        Release now
      </button>
    </section>
  );
}
