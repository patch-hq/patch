// Settings → Usage on mobile: the allowance burndown and chats ranked by tokens.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { UsageHistorySection } from '../src/components/settings/UsageHistorySection';
import { renderRN, findHost, queryHost, byTestId, textOf, flush } from './testUtils/render';
import { api } from '../src/api/rest';

vi.mock('../src/api/rest', () => ({ api: { usageReport: vi.fn() } }));

const now = Date.now();
const REPORT = {
  samples: [
    { ts: now - 3_600_000 * 3, accountId: 'a', label: 'Work', hostId: 'h', week: 0.2 },
    { ts: now - 3_600_000, accountId: 'a', label: 'Work', hostId: 'h', week: 0.6 },
  ],
  chats: [
    { chatId: 'big', name: 'Big refactor', tokens: 2_400_000, costUsd: 3, turns: 9, hostId: 'h' },
    { chatId: 'small', tokens: 4_000, costUsd: 0.1, turns: 1, hostId: 'h' },
  ],
};

const mounted: ReactTestRenderer[] = [];
async function render(): Promise<ReactTestRenderer> {
  const r = renderRN(<UsageHistorySection />);
  mounted.push(r);
  await flush();
  return r;
}
const get = (r: ReactTestRenderer, id: string) => findHost(r.root, byTestId(id));
const query = (r: ReactTestRenderer, id: string) => queryHost(r.root, byTestId(id));

beforeEach(() => {
  vi.mocked(api.usageReport).mockReset();
});
afterEach(() => {
  act(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

describe('mobile Settings → Usage — history', () => {
  it('draws one burndown line per account and ranks chats by tokens', async () => {
    vi.mocked(api.usageReport).mockResolvedValue(REPORT);
    const r = await render();
    expect(query(r, 'usage-burndown')).not.toBeNull();
    expect(textOf(get(r, 'usage-legend'))).toContain('Work');
    expect(textOf(get(r, 'usage-chat-tokens-big'))).toBe('2.4M');
    expect(textOf(get(r, 'usage-chat-small'))).toContain('small');
    const call = vi.mocked(api.usageReport).mock.calls[0]![0];
    expect(call.until - call.since).toBe(7 * 86_400_000);
  });

  it('re-queries a day-wide window when Day is chosen', async () => {
    vi.mocked(api.usageReport).mockResolvedValue(REPORT);
    const r = await render();
    await act(async () => get(r, 'usage-period-day').props.onPress());
    await flush();
    const last = vi.mocked(api.usageReport).mock.calls.at(-1)![0];
    expect(last.until - last.since).toBe(86_400_000);
  });

  it('custom asks for dates before querying', async () => {
    vi.mocked(api.usageReport).mockResolvedValue(REPORT);
    const r = await render();
    const before = vi.mocked(api.usageReport).mock.calls.length;
    await act(async () => get(r, 'usage-period-custom').props.onPress());
    await flush();
    expect(query(r, 'usage-pick-range')).not.toBeNull();
    expect(vi.mocked(api.usageReport).mock.calls.length).toBe(before);
    await act(async () => get(r, 'usage-from').props.onChangeText('2026-10-01'));
    await act(async () => get(r, 'usage-to').props.onChangeText('2026-10-02'));
    await flush();
    expect(vi.mocked(api.usageReport).mock.calls.length).toBe(before + 1);
  });

  it('says so when empty, and shows a failure with Retry rather than an empty chart', async () => {
    vi.mocked(api.usageReport).mockResolvedValue({ samples: [], chats: [] });
    const r1 = await render();
    expect(query(r1, 'usage-history-empty')).not.toBeNull();
    expect(query(r1, 'usage-chats-empty')).not.toBeNull();
    vi.mocked(api.usageReport).mockRejectedValue(new Error('host offline'));
    const r2 = await render();
    expect(textOf(get(r2, 'usage-history-error'))).toContain('host offline');
    expect(query(r2, 'usage-burndown')).toBeNull();
  });
});
