// lib/sectionCounts.ts — the Hidden / Archived headers' server totals.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import { actAsync, actSync, renderRN } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { toChatListRow } from '../src/lib/chatListRow';
import type { SectionCounts } from '../src/lib/sectionCounts';

const { chatSectionCounts } = vi.hoisted(() => ({ chatSectionCounts: vi.fn() }));
vi.mock('../src/api/rest', () => ({ api: { chatSectionCounts } }));

import { useSectionCounts } from '../src/lib/sectionCounts';

const entry = (status: 'active' | 'archived') =>
  toChatListRow({
    chatId: 'c1',
    name: 'Chat',
    hostId: 'd1',
    folder: '/f',
    activity: 'idle',
    permissionMode: 'auto',
    status,
    pinned: false,
    pinnedAt: null,
    lastUpdated: 1,
    pendingWake: null,
    snoozedUntil: null,
  });

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

let seen: SectionCounts;
function Probe(): null {
  seen = useSectionCounts();
  return null;
}

const mounted: ReactTestRenderer[] = [];
const mount = (): void => {
  mounted.push(renderRN(<Probe />));
};

afterEach(() => {
  actSync(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

beforeEach(() => {
  chatSectionCounts.mockReset();
  useChatStore.getState()._reset();
  useChatStore.getState().hydrate([entry('active')]);
});

describe('useSectionCounts', () => {
  it('shows the server totals once they arrive', async () => {
    chatSectionCounts.mockResolvedValue({ archived: 2, hidden: 1 });
    mount();
    await actAsync(async () => undefined);
    expect(seen).toEqual({ archived: 2, hidden: 1 });
  });

  it('an older answer that lands after a newer one does not replace it', async () => {
    const first = deferred<SectionCounts>();
    const second = deferred<SectionCounts>();
    chatSectionCounts.mockReturnValueOnce(first.promise);
    chatSectionCounts.mockReturnValueOnce(second.promise);
    mount();

    // A chat is archived: the counts are asked for again.
    await actAsync(async () => {
      useChatStore.getState().hydrate([entry('archived')]);
    });
    expect(chatSectionCounts.mock.calls.length).toBe(2);

    await actAsync(async () => {
      second.resolve({ archived: 1, hidden: 0 });
    });
    await actAsync(async () => {
      first.resolve({ archived: 0, hidden: 0 });
    });
    expect(seen).toEqual({ archived: 1, hidden: 0 });
  });
});
