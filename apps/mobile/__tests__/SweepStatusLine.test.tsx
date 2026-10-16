// The Manager Chats tab's sweep status line (spec/06 § Sweep, spec/15 § Voice tab).
import React from 'react';
import { act } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  hasText,
  actAsync,
  flush,
} from './testUtils/render';
import { api, type SweepRun } from '../src/api/rest';
import { useUiStore } from '../src/stores/uiStore';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { SweepStatusLine } from '../src/components/SweepStatusLine';
import { hhmm, summarizeSweep } from '../src/lib/sweepSummary';

vi.mock('../src/api/rest', () => ({ api: { getSweepRuns: vi.fn(), checkSweepNow: vi.fn() } }));

const run = (over: Partial<SweepRun> = {}): SweepRun => ({
  at: new Date(2026, 9, 10, 14, 30).getTime(),
  runId: 'r1',
  candidateCount: 3,
  actions: [
    { chatId: 'c1', action: 'nudge' },
    { chatId: 'c2', action: 'nudge' },
    { chatId: 'c3', action: 'flag' },
  ],
  tokensUsed: 1,
  ...over,
});

type R = ReturnType<typeof renderRN>;
const mounted: R[] = [];
const mount = async (): Promise<R> => {
  const r = renderRN(<SweepStatusLine />);
  mounted.push(r);
  await flush();
  return r;
};
const get = (r: R, id: string) => findHost(r.root, byTestId(id));

beforeEach(() => {
  __resetRouterMock();
  useUiStore.setState({ errors: [] });
  vi.mocked(api.getSweepRuns)
    .mockReset()
    .mockResolvedValue({ runs: [run()] });
  vi.mocked(api.checkSweepNow).mockReset().mockResolvedValue({ fired: true });
});
afterEach(() => {
  for (const r of mounted.splice(0)) {
    try {
      act(() => r.unmount());
    } catch {
      // already unmounted
    }
  }
});

describe('SweepStatusLine', () => {
  it('summarises the last sweep and expands to what it did, each row opening the chat', async () => {
    const r = await mount();
    expect(hasText(get(r, 'sweep-status-summary'), 'Last sweep 14:30 · nudged 2 · flagged 1')).toBe(
      true,
    );
    expect(queryHost(r.root, byTestId('sweep-status-detail'))).toBeNull();
    await actAsync(() => get(r, 'sweep-status-summary').props['onPress']());
    await actAsync(() => get(r, 'sweep-status-row-c3').props['onPress']());
    expect(routerMock.push).toHaveBeenCalledWith('/chats/c3');
  });

  it('says No sweeps yet, and cannot expand', async () => {
    vi.mocked(api.getSweepRuns).mockResolvedValue({ runs: [] });
    const r = await mount();
    expect(hasText(get(r, 'sweep-status-summary'), 'No sweeps yet')).toBe(true);
    expect(get(r, 'sweep-status-summary').props['disabled']).toBe(true);
  });

  it('a failed sweep shows its error when expanded; an empty one says nothing changed', async () => {
    vi.mocked(api.getSweepRuns).mockResolvedValue({ runs: [run({ error: 'model down' })] });
    const r = await mount();
    expect(hasText(get(r, 'sweep-status-summary'), '· failed')).toBe(true);
    await actAsync(() => get(r, 'sweep-status-summary').props['onPress']());
    expect(hasText(get(r, 'sweep-status-detail'), 'model down')).toBe(true);

    vi.mocked(api.getSweepRuns).mockResolvedValue({ runs: [run({ actions: [] })] });
    const r2 = await mount();
    expect(hasText(get(r2, 'sweep-status-summary'), 'nothing to do')).toBe(true);
    await actAsync(() => get(r2, 'sweep-status-summary').props['onPress']());
    expect(hasText(get(r2, 'sweep-status-detail'), 'Nothing changed.')).toBe(true);
  });

  it('Check now fires a sweep and re-reads; a failure is said', async () => {
    const r = await mount();
    await actAsync(() => get(r, 'sweep-check-now').props['onPress']());
    await flush();
    expect(api.checkSweepNow).toHaveBeenCalledTimes(1);
    expect(api.getSweepRuns).toHaveBeenCalledTimes(2);

    vi.mocked(api.checkSweepNow).mockRejectedValueOnce(new Error('busy'));
    await actAsync(() => get(r, 'sweep-check-now').props['onPress']());
    await flush();
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('check now failed: busy')),
    ).toBe(true);
  });

  it('a failed read is said', async () => {
    vi.mocked(api.getSweepRuns).mockRejectedValue(new Error('down'));
    const r = await mount();
    expect(hasText(get(r, 'sweep-status-summary'), 'Sweep —')).toBe(true);
    expect(
      useUiStore.getState().errors.some((e) => e.message.includes('sweep status failed: down')),
    ).toBe(true);
  });

  it('helpers: counts nudge, wake, flag and pads the time', () => {
    expect(summarizeSweep(run({ actions: [{ chatId: 'a', action: 'wake' }] }))).toBe('woke 1');
    expect(summarizeSweep(run({ actions: [{ chatId: 'a', action: 'leave' }] }))).toBe(
      'nothing to do',
    );
    expect(hhmm(new Date(2026, 0, 1, 7, 5).getTime())).toBe('07:05');
  });
});
