// SnoozeDivider — the permanent mark in a transcript where a snooze began
// (spec/04 § Snooze → Back, spec/14 § Snooze): "Snoozed 19:42 – 08:00 ·
// finished 03:52". It stays in history after the Back state clears.

import { useState, type JSX } from 'react';
import { Clock } from 'lucide-react';
import type { SnoozeRecord } from '@patch/wire';
import { snoozeDividerText } from '../lib/snoozeBack.js';

export function SnoozeDivider({ record }: { record: SnoozeRecord }): JSX.Element {
  const [open, setOpen] = useState(false);
  const error = record.outcome.kind === 'errored' ? record.outcome.error : undefined;
  return (
    <div className="snooze-divider-wrap" data-testid="snooze-divider-wrap">
      <div className="snooze-divider" data-testid="snooze-divider" role="separator">
        <span>
          <Clock size={13} aria-hidden />
          {snoozeDividerText(record)}
          {error ? (
            <button
              type="button"
              className="snooze-divider-details"
              data-testid="snooze-error-toggle"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Hide details' : 'Details'}
            </button>
          ) : null}
        </span>
      </div>
      {error && open ? (
        <pre className="snooze-error-detail" data-testid="snooze-error-detail">
          {error.code}: {error.message}
        </pre>
      ) : null}
    </div>
  );
}
