import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { ChatJobTick } from '@patch/wire/jobs';
import { api } from '../api/rest.js';
import { soonestTick, tickCountdown, tickProgress, tickSchedule } from '../lib/jobTicks.js';
import { JobTickBar, JobTickChip } from '../components/JobTickBar.js';

const job = (over: Partial<ChatJobTick> = {}): ChatJobTick => ({
  jobId: 'j1',
  name: 'Resume Cadence Delivery',
  trigger: 'cron',
  schedule: '*/5 * * * *',
  nextFireAt: 1_000_000 + 134_000,
  periodMs: 300_000,
  ...over,
});

describe('job tick helpers', () => {
  it('formats the countdown without the wake bar framing', () => {
    expect(tickCountdown(134_000, 0)).toBe('2m 14s');
    expect(tickCountdown(0, 5)).toBe('now');
  });
  it('words the common cadences and falls back to the raw schedule', () => {
    expect(tickSchedule(job())).toBe('every 5m');
    expect(tickSchedule(job({ schedule: '0 */2 * * *' }))).toBe('every 2h');
    expect(tickSchedule(job({ schedule: '0 9 * * 1' }))).toBe('0 9 * * 1');
  });
  it('computes progress, clamped, and null without a period', () => {
    expect(tickProgress(job({ nextFireAt: 150_000, periodMs: 300_000 }), 0)).toBe(0.5);
    expect(tickProgress(job({ nextFireAt: 100, periodMs: 300_000 }), 10_000)).toBe(1);
    expect(tickProgress(job({ periodMs: null }), 0)).toBeNull();
  });
  it('picks the soonest job', () => {
    expect(
      soonestTick([job({ jobId: 'a', nextFireAt: 9 }), job({ jobId: 'b', nextFireAt: 3 })])?.jobId,
    ).toBe('b');
    expect(soonestTick([job({ nextFireAt: null })])).toBeNull();
  });
});

describe('JobTickBar', () => {
  beforeEach(() =>
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    }),
  );
  afterEach(() => vi.useRealTimers());

  it('shows the bar and chip, and counts down live', async () => {
    const next = Date.now() + 134_000;
    vi.spyOn(api, 'chatJobTicks').mockResolvedValue({ jobs: [job({ nextFireAt: next })] });
    render(
      <>
        <JobTickChip chatId="c1" />
        <JobTickBar chatId="c1" />
      </>,
    );
    await act(async () => {});
    expect(screen.getByTestId('job-tick-name').textContent).toBe('Resume Cadence Delivery');
    expect(screen.getByTestId('job-tick-schedule').textContent).toBe('every 5m');
    expect(screen.getByTestId('job-tick-countdown').textContent).toBe('next 2m 14s');
    expect(screen.getByTestId('job-tick-chip').textContent).toBe('Job · next 2m 14s');
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByTestId('job-tick-countdown').textContent).toBe('next 2m 10s');
  });

  it('renders nothing for a chat no job targets', async () => {
    vi.spyOn(api, 'chatJobTicks').mockResolvedValue({ jobs: [] });
    render(<JobTickBar chatId="c2" />);
    await act(async () => {});
    expect(screen.queryByTestId('job-tick-bar')).toBeNull();
  });

  it('says so when the jobs cannot be loaded', async () => {
    vi.spyOn(api, 'chatJobTicks').mockRejectedValue(new Error('boom'));
    render(<JobTickBar chatId="c3" />);
    await act(async () => {});
    expect(screen.getByTestId('job-tick-bar-error').textContent).toContain('boom');
  });
});
