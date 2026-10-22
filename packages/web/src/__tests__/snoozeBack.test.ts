// The Back state copy and lookups (spec/04 § Snooze → Back).

import { describe, it, expect } from 'vitest';
import type { SnoozeRecord } from '@patch/wire';
import { folderBackPill, outcomeLine, rowBack, snoozeDividerText } from '../lib/snoozeBack.js';
import { groupChats } from '../lib/chatGroups.js';
import { useChatStore } from '../stores/chatStore.js';
import type { ChatRow } from '../stores/types.js';

const at = (d: number, h: number, m: number): number => new Date(2026, 9, d, h, m).getTime();

const rec = (over: Partial<SnoozeRecord> = {}): SnoozeRecord => ({
  setId: 's1',
  startedAt: at(14, 19, 42),
  startSeq: 3,
  until: at(15, 8, 0),
  endedAt: at(15, 8, 0),
  outcome: { kind: 'none' },
  backCleared: false,
  ...over,
});

describe('outcomeLine', () => {
  it('says each outcome in its own words and tone', () => {
    expect(outcomeLine({ kind: 'finished', at: at(15, 3, 52) })).toEqual({
      text: 'finished 03:52',
      tone: 'ok',
    });
    expect(outcomeLine({ kind: 'waiting', at: at(14, 21, 14) })).toEqual({
      text: 'waiting on you since 21:14',
      tone: 'ask',
    });
    expect(outcomeLine({ kind: 'errored', at: at(14, 23, 5) })).toEqual({
      text: 'error at 23:05',
      tone: 'error',
    });
    expect(outcomeLine({ kind: 'running' })).toEqual({ text: 'still running', tone: 'running' });
  });
  it('says nothing when the chat did nothing', () => {
    expect(outcomeLine({ kind: 'none' })).toBeNull();
  });
});

describe('folderBackPill', () => {
  it('names how long the most recent set was snoozed', () => {
    const rows = [
      { snoozeRecords: [rec({ setId: 'old', startedAt: at(14, 7, 0), endedAt: at(14, 7, 45) })] },
      { snoozeRecords: [rec({ setId: 'new' })] },
    ];
    expect(folderBackPill(rows)).toBe('back · snoozed 12h');
  });
  it('is absent when nothing is back or it was cleared', () => {
    expect(folderBackPill([{ snoozeRecords: [] }, { snoozeRecords: undefined }])).toBeNull();
    expect(folderBackPill([{ snoozeRecords: [rec({ backCleared: true })] }])).toBeNull();
    expect(folderBackPill([{ snoozeRecords: [rec({ endedAt: null })] }])).toBeNull();
  });
});

describe('rowBack', () => {
  it('carries the line for a returned row and nothing for a cleared one', () => {
    expect(rowBack({ snoozeRecords: [rec({ outcome: { kind: 'running' } })] })?.line?.text).toBe(
      'still running',
    );
    expect(rowBack({ snoozeRecords: [rec({ backCleared: true })] })).toBeNull();
  });
});

describe('snoozeDividerText', () => {
  it('shows the span and outcome, with a weekday on a time not on the wake day', () => {
    expect(snoozeDividerText(rec({ outcome: { kind: 'finished', at: at(15, 3, 52) } }))).toBe(
      'Snoozed Wed 19:42 – 08:00 · finished 03:52',
    );
  });
  it('has no outcome suffix for none, and no weekday when same-day', () => {
    expect(snoozeDividerText(rec({ startedAt: at(15, 1, 0) }))).toBe('Snoozed 01:00 – 08:00');
  });
  it('still reads while the snooze is running', () => {
    expect(snoozeDividerText(rec({ endedAt: null }))).toBe('Snoozed Wed 19:42 – 08:00');
  });
});

describe('groupChats: snoozed chats stay in their project', () => {
  function row(id: string, folder: string, over: Partial<ChatRow> = {}): ChatRow {
    useChatStore.getState()._reset();
    useChatStore.getState().hydrate([
      {
        chatId: id,
        hostId: 'd1',
        permissionMode: 'auto',
        name: id,
        folder,
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    return { ...useChatStore.getState().chats[id]!, ...over };
  }

  it('leaves snoozed chats and snoozed-only projects out of the project list', () => {
    const future = Date.now() + 3_600_000;
    const a = row('a', '/p/work');
    const b = row('b', '/p/work', { snoozedUntil: future });
    const c = row('c', '/p/home', { snoozedUntil: future });
    const g = groupChats([a, b, c]);
    expect(g.folders.map((f) => f.folder)).toEqual(['/p/work']);
    expect(g.folders[0]!.rows.map((r) => r.chatId)).toEqual(['a']);
    // Still in the Snoozed view.
    expect(g.snoozed.map((r) => r.chatId).sort()).toEqual(['b', 'c']);
    // And not offered as a "recent folder" either.
    expect(g.recentFolders.map((f) => f.folder)).not.toContain('/p/home');
  });
});

describe('chat.state carries the records to every surface', () => {
  it('stores them, keeps them when a later frame omits them, and replaces them when sent', () => {
    useChatStore.getState()._reset();
    const apply = (extra: object): void =>
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        chatId: 'c1',
        activity: 'idle',
        permissionMode: 'auto',
        lastUpdated: 1,
        status: 'active',
        folder: '/p',
        ...extra,
      } as never);
    apply({ snoozeRecords: [rec()] });
    expect(useChatStore.getState().chats['c1']?.snoozeRecords).toEqual([rec()]);
    apply({});
    expect(useChatStore.getState().chats['c1']?.snoozeRecords).toEqual([rec()]);
    apply({ snoozeRecords: [rec({ backCleared: true })] });
    expect(rowBack(useChatStore.getState().chats['c1']!)).toBeNull();
  });
});
