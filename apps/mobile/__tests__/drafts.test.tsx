// Drafts screen (spec/14 § New chat drafts, spec/15 § New chat flow) — the
// phone's full Drafts list, parity with desktop's sidebar section. Pins:
//   - lists every draft with text, most-recent first; blank drafts never show
//   - each row shows the text and the folder basename
//   - tapping a row opens the new-chat screen on that draft
//   - the × discards a draft everywhere, leaving the others untouched

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderRN, findHost, findAllHost, byTestId, hasText } from './testUtils/render';
import Drafts from '../app/drafts';
import { useNewChatDraftStore } from '../src/stores/newChatDraftStore';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';

beforeEach(() => {
  __clearAllMmkv();
  __resetRouterMock();
  useNewChatDraftStore.getState()._reset();
});

describe('Drafts screen', () => {
  it('lists only drafts with real text, most-recently-touched first', () => {
    const a = useNewChatDraftStore.getState().create('/home/tom/projects/garden');
    useNewChatDraftStore.getState().update(a, { text: 'wildflower meadow plan' });
    const blank = useNewChatDraftStore.getState().create('/home/tom/projects/blank');
    const b = useNewChatDraftStore.getState().create('/home/tom/projects/bus');
    useNewChatDraftStore.getState().update(b, { text: 'check the bus thresholds' });

    const r = renderRN(<Drafts />);
    const rows = findAllHost(r.root, (i) => String(i.props.testID ?? '').startsWith('draft-row-'));
    expect(rows.map((row) => row.props.testID)).toEqual([`draft-row-${b}`, `draft-row-${a}`]);
    expect(findAllHost(r.root, byTestId(`draft-row-${blank}`))).toHaveLength(0);
    expect(hasText(findHost(r.root, byTestId(`draft-row-${a}`)), 'wildflower meadow plan')).toBe(
      true,
    );
    expect(hasText(findHost(r.root, byTestId(`draft-row-${a}`)), 'garden')).toBe(true);
  });

  it('tapping a row opens the new-chat screen on that draft', () => {
    const a = useNewChatDraftStore.getState().create('/f');
    useNewChatDraftStore.getState().update(a, { text: 'hello' });
    const r = renderRN(<Drafts />);
    findHost(r.root, byTestId(`draft-row-${a}`)).props.onPress();
    expect(routerMock.replace).toHaveBeenCalledWith(`/new-chat?draftId=${a}`);
  });

  it('the × discards a draft, leaving the others untouched', () => {
    const a = useNewChatDraftStore.getState().create('/f');
    useNewChatDraftStore.getState().update(a, { text: 'keep me' });
    const b = useNewChatDraftStore.getState().create('/g');
    useNewChatDraftStore.getState().update(b, { text: 'discard me' });

    const r = renderRN(<Drafts />);
    findHost(r.root, byTestId(`draft-discard-${b}`)).props.onPress();
    expect(useNewChatDraftStore.getState().drafts[b]).toBeUndefined();
    expect(useNewChatDraftStore.getState().drafts[a]?.text).toBe('keep me');
  });

  it('renders an empty list with no drafts', () => {
    const r = renderRN(<Drafts />);
    expect(
      findAllHost(r.root, (i) => String(i.props.testID ?? '').startsWith('draft-row-')),
    ).toEqual([]);
  });
});
