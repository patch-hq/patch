import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SnoozeRecord } from '@patch/wire';
import { SnoozeDivider } from '../components/SnoozeDivider.js';

const rec = (outcome: SnoozeRecord['outcome']): SnoozeRecord => ({
  setId: 's',
  startedAt: 1_700_000_000_000,
  startSeq: 1,
  until: 1_700_003_600_000,
  endedAt: 1_700_003_600_000,
  outcome,
  backCleared: false,
});

describe('SnoozeDivider error details', () => {
  it('shows the error message after tapping Details', () => {
    render(
      <SnoozeDivider
        record={rec({
          kind: 'errored',
          at: 1_700_000_100_000,
          error: { code: 'x', message: 'boom' },
        })}
      />,
    );
    expect(screen.queryByTestId('snooze-error-detail')).toBeNull();
    fireEvent.click(screen.getByTestId('snooze-error-toggle'));
    expect(screen.getByTestId('snooze-error-detail').textContent).toContain('boom');
  });
  it('has no Details control without an error', () => {
    render(<SnoozeDivider record={rec({ kind: 'finished', at: 1_700_000_100_000 })} />);
    expect(screen.queryByTestId('snooze-error-toggle')).toBeNull();
  });
});
