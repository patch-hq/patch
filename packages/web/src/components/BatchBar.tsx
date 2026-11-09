// BatchBar — the batch toggle + timer under New chat (design preview; the
// server-owned schedule lands after the UI is approved). While Batch is on,
// every chat is in the batch and the chat list is held back until the next
// release time; BatchHeld is the placeholder that takes the list's place.

import { useState, type JSX } from 'react';
import { Toggle } from './Toggle.js';
import { useBatchStore, type BatchSchedule } from '../stores/batchStore.js';

const PRESETS = [15, 30, 60, 120];

function presetLabel(m: number): string {
  return m % 60 === 0 ? `${m / 60} h` : `${m} min`;
}

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
      {enabled ? <ScheduleEditor schedule={schedule} onChange={setSchedule} /> : null}
    </div>
  );
}

function ScheduleEditor({
  schedule,
  onChange,
}: {
  schedule: BatchSchedule;
  onChange: (s: BatchSchedule) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const isInterval = schedule.kind === 'interval';

  const addTime = (): void => {
    if (schedule.kind !== 'times' || !draft || schedule.times.includes(draft)) return;
    onChange({ kind: 'times', times: [...schedule.times, draft].sort() });
    setDraft('');
  };

  return (
    <>
      <div
        className="batch-seg"
        role="radiogroup"
        aria-label="Batch timer"
        data-testid="batch-schedule"
      >
        <button
          type="button"
          role="radio"
          aria-checked={isInterval}
          className="batch-seg-opt"
          data-testid="batch-kind-interval"
          onClick={() => onChange(isInterval ? schedule : { kind: 'interval', minutes: 30 })}
        >
          Every
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!isInterval}
          className="batch-seg-opt"
          data-testid="batch-kind-times"
          onClick={() =>
            onChange(isInterval ? { kind: 'times', times: ['09:00', '12:00', '17:00'] } : schedule)
          }
        >
          At times
        </button>
      </div>
      {schedule.kind === 'interval' ? (
        <div className="batch-chips" data-testid="batch-interval">
          {PRESETS.map((m) => (
            <button
              key={m}
              type="button"
              className="batch-chip"
              aria-pressed={schedule.minutes === m}
              data-testid={`batch-interval-${m}`}
              onClick={() => onChange({ kind: 'interval', minutes: m })}
            >
              {presetLabel(m)}
            </button>
          ))}
          <label className="batch-custom">
            <input
              type="number"
              min={1}
              max={1440}
              className="batch-custom-input"
              aria-label="Custom minutes"
              data-testid="batch-interval-custom"
              value={PRESETS.includes(schedule.minutes) ? '' : schedule.minutes}
              placeholder="…"
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (n >= 1 && n <= 1440) onChange({ kind: 'interval', minutes: n });
              }}
            />
            <span>min</span>
          </label>
        </div>
      ) : (
        <div className="batch-chips" data-testid="batch-times">
          {schedule.times.map((t) => (
            <span key={t} className="batch-chip batch-chip-time" data-testid={`batch-time-${t}`}>
              {t}
              <button
                type="button"
                className="batch-chip-x"
                aria-label={`Remove ${t}`}
                onClick={() =>
                  onChange({ kind: 'times', times: schedule.times.filter((x) => x !== t) })
                }
              >
                ×
              </button>
            </span>
          ))}
          <span className="batch-add">
            <input
              type="time"
              className="batch-custom-input batch-time-input"
              aria-label="Add a time"
              data-testid="batch-time-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              type="button"
              className="batch-chip"
              data-testid="batch-time-add"
              disabled={!draft}
              onClick={addTime}
            >
              Add
            </button>
          </span>
        </div>
      )}
    </>
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
