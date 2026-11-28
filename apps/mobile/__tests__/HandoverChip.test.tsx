// "Continue from …" (spec/05 § Handover — Missed move): names the surface,
// tap goes there, it runs out after 5 s and is then gone for good.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderRN, actSync, hasText, queryHost } from './testUtils/render';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';
import { HandoverChip, OFFER_MS } from '../src/components/HandoverChip';
import { useViewPositionStore } from '../src/stores/viewPositionStore';
import { readLog } from '../src/lib/handover';

const offer = {
  page: 'chat' as const,
  id: 'c9',
  surfaceId: 'desk',
  surfaceKind: 'desktop',
  updatedAt: 100,
  snapshot: true,
};

describe('HandoverChip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __clearAllMmkv();
    __resetRouterMock();
    useViewPositionStore.setState({ offer: null });
  });
  afterEach(() => vi.useRealTimers());

  it('shows nothing without an offer', () => {
    const view = renderRN(<HandoverChip />);
    expect(queryHost(view.root, (n) => n.props.testID === 'handover-chip')).toBeNull();
  });

  it('names the surface the user moved on, and a tap goes there', () => {
    useViewPositionStore.setState({ offer });
    const view = renderRN(<HandoverChip />);
    expect(hasText(view.root, 'Continue from your computer')).toBe(true);
    const button = queryHost(view.root, (n) => n.props.accessibilityRole === 'button');
    actSync(() => button!.props.onPress());
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c9');
    expect(useViewPositionStore.getState().offer).toBeNull();
  });

  it('runs out after 5 s', () => {
    useViewPositionStore.setState({ offer });
    renderRN(<HandoverChip />);
    actSync(() => vi.advanceTimersByTime(OFFER_MS - 1));
    expect(useViewPositionStore.getState().offer).not.toBeNull();
    actSync(() => vi.advanceTimersByTime(1));
    expect(useViewPositionStore.getState().offer).toBeNull();
    expect(readLog()[0]).toMatchObject({ outcome: 'dropped', why: 'ran out' });
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });
});
