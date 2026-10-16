// The Snooze sheet and the Back state on the phone (spec/04 § Snooze, spec/15
// § Snooze sheet): the bottom sheet's sections and copy, applying a snooze as
// one set with a toast and Undo, the project's snoozed line and back pill on
// the Chats tab, the returned rows' second lines, and the transcript divider.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  renderRN,
  findHost,
  findAllHost,
  byTestId,
  hasText,
  textOf,
  actSync,
} from './testUtils/render';
import type { SnoozeRecord } from '@patch/wire';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { SnoozeSheet, useSnoozeSheetStore, showSnoozeSheet } from '../src/components/SnoozeSheet';
import { SnoozeDivider } from '../src/components/SnoozeDivider';
import { ErrorToasts } from '../src/components/ErrorToasts';
import ChatsScreen from '../app/(tabs)/chats';
import { insertSnoozeDividers, groupToolRuns } from '../src/lib/toolSummary';
import { __resetRouterMock } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';

vi.mock('../src/lib/voiceNote', () => ({
  startVoiceNote: vi.fn(),
  releaseVoiceNoteIfHeld: vi.fn(),
}));
const { snoozeChatSpy } = vi.hoisted(() => ({
  snoozeChatSpy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    snoozeChat: snoozeChatSpy,
    chatSectionCounts: vi
      .fn()
      .mockResolvedValue({ archived: 0, snoozed: 0, hidden: 0, deleted: 0, automations: 0 }),
    listArchivedChats: vi.fn().mockResolvedValue({ chats: [] }),
    listHiddenChats: vi.fn().mockResolvedValue({ chats: [] }),
  },
}));

type HydrateRow = Parameters<ReturnType<typeof useChatStore.getState>['hydrate']>[0][number];
const NOW = new Date(2026, 9, 15, 16, 5).getTime();
const FOLDER = '/home/tom/projects/work';

function row(chatId: string, over: Partial<HydrateRow> = {}): HydrateRow {
  return {
    chatId,
    name: chatId,
    folder: FOLDER,
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 1,
    snoozedUntil: null,
    ...over,
  };
}

const rec = (over: Partial<SnoozeRecord> = {}): SnoozeRecord => ({
  setId: 's1',
  startedAt: NOW - 12 * 3_600_000,
  startSeq: 3,
  until: NOW - 60_000,
  endedAt: NOW - 60_000,
  outcome: { kind: 'none' },
  backCleared: false,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __clearAllMmkv();
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  useSnoozeSheetStore.getState().close();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  __resetRouterMock();
  snoozeChatSpy.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

function seedThree(): void {
  useChatStore
    .getState()
    .hydrate([
      row('a', { name: 'Migrate billing', activity: 'running' }),
      row('b', { name: 'Fix checkout', activity: 'running' }),
      row('c', { name: 'Timesheet' }),
    ]);
  useChatStore.getState().applyEvent({
    type: 'chat.state',
    chatId: 'a',
    activity: 'running',
    permissionMode: 'auto',
    lastUpdated: 1,
    status: 'active',
    statusSummary: 'Shadow run, pass 1 of ~4',
    runningSince: NOW - 130 * 60_000,
  } as never);
}

const press = (r: ReturnType<typeof renderRN>, id: string): void =>
  actSync(() => findHost(r.root, byTestId(id)).props['onPress']());

describe('the Snooze sheet', () => {
  it('a chat: title, name, presets with wake times, run box for a running chat, rule, disabled Snooze', () => {
    seedThree();
    const r = renderRN(<SnoozeSheet />);
    actSync(() => showSnoozeSheet({ kind: 'chat', chatId: 'a' }));
    expect(textOf(findHost(r.root, byTestId('snooze-sheet-title')))).toBe('Snooze');
    expect(textOf(findHost(r.root, byTestId('snooze-sheet-subtitle')))).toBe('Migrate billing');
    for (const l of ['2 minutes', '1 hour', '5pm', 'Tomorrow 8am', 'Next Monday', 'Custom…']) {
      expect(hasText(r.root, l)).toBe(true);
    }
    expect(hasText(findHost(r.root, byTestId('snooze-sheet-preset-1-hour')), '17:05')).toBe(true);
    expect(
      hasText(findHost(r.root, byTestId('snooze-sheet-preset-tomorrow-8am')), 'Fri 08:00'),
    ).toBe(true);
    const run = findHost(r.root, byTestId('snooze-sheet-run'));
    expect(hasText(run, 'Run in background')).toBe(true);
    expect(hasText(run, 'This chat')).toBe(true);
    expect(hasText(run, 'Shadow run, pass 1 of ~4')).toBe(true);
    expect(hasText(run, '2h 10m')).toBe(true);
    expect(hasText(r.root, 'Snoozed chats keep running and reappear when scheduled')).toBe(true);
    const confirm = findHost(r.root, byTestId('snooze-sheet-confirm'));
    expect(confirm.props['disabled']).toBe(true);
    expect(textOf(confirm)).toBe('Snooze');
  });

  it('no run box when the chat is not running', () => {
    seedThree();
    const r = renderRN(<SnoozeSheet />);
    actSync(() => showSnoozeSheet({ kind: 'chat', chatId: 'c' }));
    expect(findAllHost(r.root, byTestId('snooze-sheet-run'))).toHaveLength(0);
  });

  it('a project: counts its chats, lists the running ones, counts the rest, and says how many it snoozes', () => {
    seedThree();
    const r = renderRN(<SnoozeSheet />);
    actSync(() => showSnoozeSheet({ kind: 'project', folder: FOLDER, name: 'work' }));
    expect(textOf(findHost(r.root, byTestId('snooze-sheet-title')))).toBe('Snooze work');
    expect(textOf(findHost(r.root, byTestId('snooze-sheet-subtitle')))).toBe('3 chats');
    const run = findHost(r.root, byTestId('snooze-sheet-run'));
    expect(findAllHost(run, byTestId('snooze-sheet-run-item'))).toHaveLength(2);
    expect(hasText(run, 'Migrate billing')).toBe(true);
    expect(hasText(run, '+ 1 not running')).toBe(true);
    press(r, 'snooze-sheet-preset-tomorrow-8am');
    expect(textOf(findHost(r.root, byTestId('snooze-sheet-confirm')))).toBe(
      'Snooze 3 until Fri 08:00',
    );
  });

  it('choosing a preset only selects it; confirming applies one set, flips every chat and toasts with Undo', () => {
    seedThree();
    const r = renderRN(<SnoozeSheet />);
    actSync(() => showSnoozeSheet({ kind: 'project', folder: FOLDER, name: 'work' }));
    press(r, 'snooze-sheet-preset-1-day');
    expect(snoozeChatSpy).not.toHaveBeenCalled();
    press(r, 'snooze-sheet-confirm');
    const until = NOW + 24 * 3_600_000;
    expect(snoozeChatSpy).toHaveBeenCalledTimes(3);
    const setIds = new Set(snoozeChatSpy.mock.calls.map((c) => c[2]));
    expect(setIds.size).toBe(1);
    for (const id of ['a', 'b', 'c']) {
      expect(useChatStore.getState().chats[id]?.snoozedUntil).toBe(until);
    }
    expect(useSnoozeSheetStore.getState().target).toBeNull();

    const toast = useUiStore.getState().errors.find((e) => e.snooze);
    expect(toast?.message).toBe('work snoozed until Fri 16:05');
    expect(toast?.snooze?.subline).toBe('2 chats running in background');

    // Undo puts each chat's previous wake time back.
    const t = renderRN(<ErrorToasts />);
    snoozeChatSpy.mockClear();
    press(t, 'snooze-toast-undo');
    for (const id of ['a', 'b', 'c']) {
      expect(useChatStore.getState().chats[id]?.snoozedUntil).toBeNull();
    }
    expect(snoozeChatSpy).toHaveBeenCalledWith('a', null);
  });

  it('a single running chat says "Running in background"; an idle one says nothing', () => {
    seedThree();
    const r = renderRN(<SnoozeSheet />);
    actSync(() => showSnoozeSheet({ kind: 'chat', chatId: 'a' }));
    press(r, 'snooze-sheet-preset-5-minutes');
    press(r, 'snooze-sheet-confirm');
    expect(useUiStore.getState().errors.find((e) => e.snooze)?.snooze?.subline).toBe(
      'Running in background',
    );

    useUiStore.setState({ errors: [] });
    actSync(() => showSnoozeSheet({ kind: 'chat', chatId: 'c' }));
    press(r, 'snooze-sheet-preset-5-minutes');
    press(r, 'snooze-sheet-confirm');
    expect(useUiStore.getState().errors.find((e) => e.snooze)?.snooze?.subline).toBeNull();
  });

  it('a failed snooze reverts and says so', async () => {
    snoozeChatSpy.mockRejectedValueOnce(new Error('offline'));
    seedThree();
    const r = renderRN(<SnoozeSheet />);
    actSync(() => showSnoozeSheet({ kind: 'chat', chatId: 'c' }));
    press(r, 'snooze-sheet-preset-1-hour');
    press(r, 'snooze-sheet-confirm');
    await vi.waitFor(() => expect(useChatStore.getState().chats['c']?.snoozedUntil).toBeNull());
    expect(useUiStore.getState().errors.some((e) => e.message.includes('snooze failed'))).toBe(
      true,
    );
  });

  it('Custom… takes a typed time, refuses a past one, and Cancel snoozes nothing', () => {
    seedThree();
    const r = renderRN(<SnoozeSheet />);
    actSync(() => showSnoozeSheet({ kind: 'chat', chatId: 'c' }));
    press(r, 'snooze-sheet-preset-custom');
    actSync(() =>
      findHost(r.root, byTestId('snooze-sheet-custom-input')).props['onChangeText'](
        '2001-01-01 09:00',
      ),
    );
    press(r, 'snooze-sheet-confirm');
    expect(snoozeChatSpy).not.toHaveBeenCalled();
    expect(useUiStore.getState().errors.some((e) => /future/.test(e.message))).toBe(true);
    actSync(() =>
      findHost(r.root, byTestId('snooze-sheet-custom-input')).props['onChangeText'](
        '2099-01-02 09:30',
      ),
    );
    expect(textOf(findHost(r.root, byTestId('snooze-sheet-confirm')))).toBe(
      'Snooze until Fri 2 Jan',
    );
    press(r, 'snooze-sheet-cancel');
    expect(useSnoozeSheetStore.getState().target).toBeNull();
    expect(snoozeChatSpy).not.toHaveBeenCalled();
  });
});

describe('the Chats tab', () => {
  it('folds snoozed chats into one line inside their project; a snoozed-only project keeps its header', () => {
    useChatStore
      .getState()
      .hydrate([
        row('a'),
        row('b', { snoozedUntil: NOW + 3_600_000 }),
        row('z', { folder: '/home/tom/projects/other', snoozedUntil: NOW + 7_200_000 }),
      ]);
    const r = renderRN(<ChatsScreen />);
    const line = findHost(r.root, byTestId(`folder-snoozed-${FOLDER}`));
    expect(hasText(line, '1 snoozed')).toBe(true);
    expect(hasText(line, 'back 17:05')).toBe(true);
    const other = findHost(r.root, byTestId('folder-snoozed-/home/tom/projects/other'));
    expect(hasText(other, 'back 18:05')).toBe(true);
    expect(hasText(r.root, '/home/tom/projects/other')).toBe(true);
  });

  it('the project header carries a clock that opens the project sheet', () => {
    useChatStore.getState().hydrate([row('a')]);
    const r = renderRN(<ChatsScreen />);
    press(r, `folder-snooze-${FOLDER}`);
    expect(useSnoozeSheetStore.getState().target).toEqual({
      kind: 'project',
      folder: FOLDER,
      name: 'work',
    });
  });

  it('a project that is back shows its pill, and each returned row says what happened', () => {
    useChatStore.getState().hydrate([row('a'), row('b'), row('c')]);
    const at = (h: number, m: number): number => new Date(2026, 9, 15, h, m).getTime();
    const give = (chatId: string, r: SnoozeRecord): void =>
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        chatId,
        activity: 'idle',
        permissionMode: 'auto',
        lastUpdated: 1,
        status: 'active',
        snoozeRecords: [r],
      } as never);
    give('a', rec({ outcome: { kind: 'finished', at: at(3, 52) } }));
    give('b', rec({ outcome: { kind: 'waiting', at: at(21, 14) } }));
    give('c', rec());
    const r = renderRN(<ChatsScreen />);
    expect(hasText(findHost(r.root, byTestId(`folder-back-${FOLDER}`)), 'back · snoozed 12h')).toBe(
      true,
    );
    expect(textOf(findHost(r.root, byTestId('snooze-back-line-a')))).toBe('finished 03:52');
    expect(textOf(findHost(r.root, byTestId('snooze-back-line-b')))).toBe(
      'waiting on you since 21:14',
    );
    expect(findAllHost(r.root, byTestId('snooze-back-line-c'))).toHaveLength(0);

    // Cleared by the host for the whole set: the pill and the lines go.
    for (const id of ['a', 'b', 'c']) give(id, rec({ backCleared: true }));
    renderRN(<ChatsScreen />);
    const again = renderRN(<ChatsScreen />);
    expect(findAllHost(again.root, byTestId(`folder-back-${FOLDER}`))).toHaveLength(0);
    expect(findAllHost(again.root, byTestId('snooze-back-line-a'))).toHaveLength(0);
  });
});

describe('transcript divider', () => {
  it('draws the span and outcome', () => {
    const r = renderRN(
      <SnoozeDivider
        record={rec({
          startedAt: new Date(2026, 9, 14, 19, 42).getTime(),
          endedAt: new Date(2026, 9, 15, 8, 0).getTime(),
          outcome: { kind: 'finished', at: new Date(2026, 9, 15, 3, 52).getTime() },
        })}
      />,
    );
    expect(textOf(findHost(r.root, byTestId('snooze-divider')))).toContain(
      'Snoozed Wed 19:42 – 08:00 · finished 03:52',
    );
  });

  it('sits before the first row after where the snooze began, and at the end when nothing followed', () => {
    const entry = (seq: number) => ({
      seq,
      kind: 'message' as const,
      role: 'user' as const,
      content: `m${seq}`,
    });
    const rows = groupToolRuns([entry(1), entry(2), entry(5)] as never);
    const placed = insertSnoozeDividers(rows, [rec({ startSeq: 2 })]);
    expect(placed.map((x) => x.kind)).toEqual(['entry', 'entry', 'snooze', 'entry']);
    const atEnd = insertSnoozeDividers(rows, [rec({ startSeq: 9 })]);
    expect(atEnd[atEnd.length - 1]!.kind).toBe('snooze');
    expect(insertSnoozeDividers(rows, [])).toBe(rows);
  });
});
