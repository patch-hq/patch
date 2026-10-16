// DocToolsPanel (spec/14 § Document editor, step 2 of 3): the mode picker and
// the Suggestions, Comments and History panels. Purely presentational: every
// press hands ONE exact DocAction to `dispatch`.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import type { DocView } from '@patch/wire';
import {
  renderRN,
  findHost,
  findAllHost,
  queryHost,
  byTestId,
  hasText,
  actSync,
} from './testUtils/render';
import {
  CommentsPanel,
  DocModePicker,
  HistoryPanel,
  SuggestionsPanel,
} from '../src/components/DocToolsPanel';

const sug = (id: string, status: 'pending' | 'accepted' | 'rejected', replace = 'new') => ({
  id,
  find: `find-${id}`,
  replace,
  status,
  createdAt: 1,
});
const thread = (id: string, resolved: boolean) => ({
  id,
  anchor: `anchor-${id}`,
  resolved,
  comments: [
    { id: `${id}-1`, author: 'agent' as const, text: `agent says ${id}`, createdAt: 1 },
    { id: `${id}-2`, author: 'user' as const, text: `user says ${id}`, createdAt: 2 },
  ],
});
const ver = (id: string, extra: object = {}) => ({
  id,
  content: `content ${id}`,
  savedBy: 'user' as const,
  createdAt: 1_700_000_000_000,
  ...extra,
});
const view = (over: Partial<DocView> = {}): DocView => ({
  mode: 'change',
  suggestions: [],
  threads: [],
  versions: [],
  ...over,
});

const mounted: ReactTestRenderer[] = [];
let dispatch: ReturnType<typeof vi.fn>;
function mount(el: React.ReactElement): ReactTestRenderer {
  const r = renderRN(el);
  mounted.push(r);
  return r;
}
const press = (r: ReactTestRenderer, id: string): void =>
  actSync(() => {
    (findHost(r.root, byTestId(id)).props['onPress'] as () => void)();
  });

beforeEach(() => {
  dispatch = vi.fn();
});
afterEach(() => {
  actSync(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

describe('DocModePicker', () => {
  it('names the current mode and picks another', () => {
    const onChange = vi.fn();
    const r = mount(<DocModePicker mode="propose" onChange={onChange} />);
    expect(hasText(r.root, 'Propose')).toBe(true);
    press(r, 'doc-mode-select');
    press(r, 'doc-mode-select-option-comment');
    expect(onChange).toHaveBeenCalledWith('comment');
  });

  it('offers all three modes', () => {
    const r = mount(<DocModePicker mode="change" onChange={vi.fn()} />);
    press(r, 'doc-mode-select');
    for (const m of ['change', 'propose', 'comment']) {
      expect(findHost(r.root, byTestId(`doc-mode-select-option-${m}`))).toBeTruthy();
    }
  });
});

describe('SuggestionsPanel', () => {
  const v = view({
    suggestions: [
      sug('a', 'accepted'),
      sug('b', 'pending'),
      sug('c', 'pending', ''),
      sug('d', 'rejected'),
    ],
  });

  it('lists pending first with a count, and shows resolved ones by status', () => {
    const r = mount(<SuggestionsPanel view={v} dispatch={dispatch} />);
    expect(hasText(r.root, '2 pending')).toBe(true);
    const ids = findAllHost(
      r.root,
      (i) =>
        String(i.props['testID']).startsWith('doc-suggestion-') &&
        /^doc-suggestion-[a-d]$/.test(String(i.props['testID'])),
    ).map((i) => i.props['testID']);
    expect(ids).toEqual([
      'doc-suggestion-b',
      'doc-suggestion-c',
      'doc-suggestion-a',
      'doc-suggestion-d',
    ]);
    expect(hasText(r.root, 'accepted')).toBe(true);
    expect(hasText(r.root, 'rejected')).toBe(true);
    expect(hasText(r.root, '(deleted)')).toBe(true);
    // A resolved suggestion has no buttons.
    expect(queryHost(r.root, byTestId('doc-suggestion-accept-a'))).toBeNull();
  });

  it('dispatches accept and reject for one suggestion', () => {
    const r = mount(<SuggestionsPanel view={v} dispatch={dispatch} />);
    press(r, 'doc-suggestion-accept-b');
    expect(dispatch).toHaveBeenLastCalledWith({ op: 'accept_suggestion', id: 'b' });
    press(r, 'doc-suggestion-reject-c');
    expect(dispatch).toHaveBeenLastCalledWith({ op: 'reject_suggestion', id: 'c' });
  });

  it('dispatches accept all and reject all', () => {
    const r = mount(<SuggestionsPanel view={v} dispatch={dispatch} />);
    press(r, 'doc-suggestions-accept-all');
    expect(dispatch).toHaveBeenLastCalledWith({ op: 'accept_all' });
    press(r, 'doc-suggestions-reject-all');
    expect(dispatch).toHaveBeenLastCalledWith({ op: 'reject_all' });
  });

  it('drops the batch buttons when nothing is pending, and says so when empty', () => {
    const r = mount(
      <SuggestionsPanel view={view({ suggestions: [sug('a', 'accepted')] })} dispatch={dispatch} />,
    );
    expect(queryHost(r.root, byTestId('doc-suggestions-accept-all'))).toBeNull();
    expect(hasText(r.root, '0 pending')).toBe(true);
    const e = mount(<SuggestionsPanel view={view()} dispatch={dispatch} />);
    expect(hasText(e.root, 'No suggestions')).toBe(true);
  });

  it('says "1 pending" for one', () => {
    const r = mount(
      <SuggestionsPanel view={view({ suggestions: [sug('a', 'pending')] })} dispatch={dispatch} />,
    );
    expect(hasText(r.root, '1 pending')).toBe(true);
  });
});

describe('CommentsPanel', () => {
  const v = view({ threads: [thread('t1', true), thread('t2', false)] });

  it('lists open threads before resolved, with anchor and both authors', () => {
    const r = mount(<CommentsPanel view={v} dispatch={dispatch} />);
    const ids = findAllHost(r.root, (i) => /^doc-thread-t\d$/.test(String(i.props['testID']))).map(
      (i) => i.props['testID'],
    );
    expect(ids).toEqual(['doc-thread-t2', 'doc-thread-t1']);
    expect(hasText(r.root, 'anchor-t2')).toBe(true);
    expect(hasText(r.root, 'Agent')).toBe(true);
    expect(hasText(r.root, 'You')).toBe(true);
    expect(hasText(r.root, 'agent says t2')).toBe(true);
  });

  it('replies to an open thread and clears the field; empty replies are not sent', () => {
    const r = mount(<CommentsPanel view={v} dispatch={dispatch} />);
    press(r, 'doc-thread-reply-submit-t2');
    expect(dispatch).not.toHaveBeenCalled();
    actSync(() => {
      (
        findHost(r.root, byTestId('doc-thread-reply-input-t2')).props['onChangeText'] as (
          t: string,
        ) => void
      )('  ');
    });
    press(r, 'doc-thread-reply-submit-t2');
    expect(dispatch).not.toHaveBeenCalled();
    actSync(() => {
      (
        findHost(r.root, byTestId('doc-thread-reply-input-t2')).props['onChangeText'] as (
          t: string,
        ) => void
      )('thanks');
    });
    press(r, 'doc-thread-reply-submit-t2');
    expect(dispatch).toHaveBeenCalledWith({ op: 'reply_comment', threadId: 't2', text: 'thanks' });
    expect(findHost(r.root, byTestId('doc-thread-reply-input-t2')).props['value']).toBe('');
  });

  it('resolves an open thread and reopens a resolved one', () => {
    const r = mount(<CommentsPanel view={v} dispatch={dispatch} />);
    press(r, 'doc-thread-resolve-t2');
    expect(dispatch).toHaveBeenLastCalledWith({
      op: 'resolve_comment',
      threadId: 't2',
      resolved: true,
    });
    press(r, 'doc-thread-resolve-t1');
    expect(dispatch).toHaveBeenLastCalledWith({
      op: 'resolve_comment',
      threadId: 't1',
      resolved: false,
    });
    expect(hasText(r.root, 'Reopen')).toBe(true);
    expect(hasText(r.root, 'Resolve')).toBe(true);
  });

  it('has no reply field on a resolved thread', () => {
    const r = mount(<CommentsPanel view={v} dispatch={dispatch} />);
    expect(queryHost(r.root, byTestId('doc-thread-reply-input-t1'))).toBeNull();
  });

  it('says so when there are none', () => {
    const r = mount(<CommentsPanel view={view()} dispatch={dispatch} />);
    expect(hasText(r.root, 'No comments')).toBe(true);
  });
});

describe('HistoryPanel', () => {
  const v = view({
    versions: [ver('1'), ver('2', { savedBy: 'agent' }), ver('3', { restoredFrom: '1' })],
  });

  it('lists versions newest first, naming who and whether restored', () => {
    const r = mount(<HistoryPanel view={v} dispatch={dispatch} />);
    const ids = findAllHost(r.root, (i) =>
      /^doc-history-row-\d$/.test(String(i.props['testID'])),
    ).map((i) => i.props['testID']);
    expect(ids).toEqual(['doc-history-row-3', 'doc-history-row-2', 'doc-history-row-1']);
    expect(hasText(r.root, 'Agent')).toBe(true);
    expect(hasText(r.root, 'restored')).toBe(true);
  });

  it('previews a version on selection and restores exactly that one', () => {
    const r = mount(<HistoryPanel view={v} dispatch={dispatch} />);
    expect(queryHost(r.root, byTestId('doc-history-content'))).toBeNull();
    press(r, 'doc-history-row-2');
    expect(findHost(r.root, byTestId('doc-history-content')).props['children']).toBe('content 2');
    press(r, 'doc-history-restore');
    expect(dispatch).toHaveBeenCalledWith({ op: 'restore_version', versionId: '2' });
  });

  it('says so when there is no history', () => {
    const r = mount(<HistoryPanel view={view()} dispatch={dispatch} />);
    expect(hasText(r.root, 'No history')).toBe(true);
  });
});
