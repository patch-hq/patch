// Render coverage for the mobile job tick bar and header chip (spec/15 § Chat
// detail). Mirrors packages/web/src/__tests__/jobTicks.test.tsx.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { renderRN, queryHost, byTestId, textOf, actAsync } from './testUtils/render';
import { JobTickBar, JobTickChip } from '../src/components/chatBars/JobTickBar';
import { tickSchedule, tickProgress } from '../src/lib/jobTicks';

const apiMocks = vi.hoisted(() => ({ chatJobTicks: vi.fn() }));
vi.mock('../src/api/rest', () => ({ api: apiMocks }));

const NOW = 1_800_000_000_000;
const job = (over = {}) => ({
  jobId: 'j1',
  name: 'Resume Cadence Delivery',
  trigger: 'cron' as const,
  schedule: '*/5 * * * *',
  nextFireAt: NOW + 134_000,
  periodMs: 300_000,
  ...over,
});

describe('JobTickBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    apiMocks.chatJobTicks.mockReset();
  });

  it('shows name, cadence, live countdown and the header chip', async () => {
    apiMocks.chatJobTicks.mockResolvedValue({ jobs: [job()] });
    const r = renderRN(
      <View>
        <JobTickChip chatId="c1" />
        <JobTickBar chatId="c1" />
      </View>,
    );
    await actAsync(async () => {});
    expect(textOf(queryHost(r.root, byTestId('job-tick-name'))!)).toBe('Resume Cadence Delivery');
    expect(textOf(queryHost(r.root, byTestId('job-tick-schedule'))!)).toContain('every 5m');
    expect(textOf(queryHost(r.root, byTestId('job-tick-countdown'))!)).toBe('next 2m 14s');
    expect(textOf(queryHost(r.root, byTestId('job-tick-chip'))!)).toBe('Job · next 2m 14s');
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(textOf(queryHost(r.root, byTestId('job-tick-countdown'))!)).toBe('next 2m 10s');
  });

  it('renders nothing when no job targets the chat', async () => {
    apiMocks.chatJobTicks.mockResolvedValue({ jobs: [] });
    const r = renderRN(<JobTickBar chatId="c2" />);
    await actAsync(async () => {});
    expect(queryHost(r.root, byTestId('job-tick-bar'))).toBeNull();
  });

  it('says so when the jobs cannot be loaded', async () => {
    apiMocks.chatJobTicks.mockRejectedValue(new Error('boom'));
    const r = renderRN(<JobTickBar chatId="c3" />);
    await actAsync(async () => {});
    expect(textOf(queryHost(r.root, byTestId('job-tick-bar-error'))!)).toContain('boom');
  });

  it('words cadences and computes progress', () => {
    expect(tickSchedule(job())).toBe('every 5m');
    expect(tickSchedule(job({ schedule: '0 9 * * 1' }))).toBe('0 9 * * 1');
    expect(tickProgress(job({ nextFireAt: 150_000 }), 0)).toBe(0.5);
  });
});
