// SnoozeDivider — the permanent mark in a transcript where a snooze began
// (spec/04 § Snooze → Back, spec/14 § Snooze): "Snoozed 19:42 – 08:00 ·
// finished 03:52". It stays in history after the Back state clears.

import type { JSX } from 'react';
import { Clock } from 'lucide-react';
import type { SnoozeRecord } from '@patch/wire';
import { snoozeDividerText } from '../lib/snoozeBack.js';

export function SnoozeDivider({ record }: { record: SnoozeRecord }): JSX.Element {
  return (
    <div className="snooze-divider" data-testid="snooze-divider" role="separator">
      <span>
        <Clock size={13} aria-hidden />
        {snoozeDividerText(record)}
      </span>
    </div>
  );
}
