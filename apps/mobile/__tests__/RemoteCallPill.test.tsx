// Call handoff, phone side (spec/07 § A call can move between devices): a call
// live on another surface shows as a pill with Switch here, and switching
// opens this phone's call with takeOver.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  actSync,
  byTestId,
  findHost,
  queryHost,
  renderRN as renderRNRaw,
  textOf,
} from './testUtils/render';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useChatStore } from '../src/stores/chatStore';

const { startVoiceCallSpy } = vi.hoisted(() => ({ startVoiceCallSpy: vi.fn() }));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: startVoiceCallSpy }));

import { RemoteCallPill } from '../src/components/RemoteCallPill';

const remote = {
  sessionId: 's1',
  surfaceId: 'web-1',
  surfaceKind: 'web',
  chatId: 'c1',
  startedAt: 1,
};
const mounted: ReturnType<typeof renderRNRaw>[] = [];
function renderRN(el: React.ReactElement): ReturnType<typeof renderRNRaw> {
  const r = renderRNRaw(el);
  mounted.push(r);
  return r;
}

beforeEach(() => {
  startVoiceCallSpy.mockClear();
  useChatStore.getState()._reset();
  useVoiceStore.setState({ activeSession: null, remoteCalls: {} });
});
afterEach(() => {
  for (const r of mounted.splice(0)) actSync(() => r.unmount());
});

describe('RemoteCallPill', () => {
  it('renders nothing with no remote call', () => {
    expect(renderRN(<RemoteCallPill />).toJSON()).toBeNull();
  });

  it('names the device and the chat', () => {
    useChatStore.setState({
      chats: { c1: { chatId: 'c1', name: 'Garden plan', folder: '/g' } as never },
    });
    useVoiceStore.setState({ remoteCalls: { s1: remote } });
    const r = renderRN(<RemoteCallPill />);
    expect(textOf(findHost(r.root, byTestId('remote-call-pill')))).toContain(
      'Call on your browser · Garden plan',
    );
  });

  it('is hidden while this phone is on its own call', () => {
    useVoiceStore.setState({
      remoteCalls: { s1: remote },
      activeSession: { sessionId: 'x', chatId: 'c1', audioUrl: '/a', startedAt: 1 },
    });
    const r = renderRN(<RemoteCallPill />);
    expect(queryHost(r.root, byTestId('remote-call-pill'))).toBeNull();
  });

  it('Switch here starts a call on that chat with takeOver', () => {
    useVoiceStore.setState({ remoteCalls: { s1: remote } });
    const r = renderRN(<RemoteCallPill />);
    findHost(r.root, byTestId('remote-call-switch')).props['onPress']();
    expect(startVoiceCallSpy).toHaveBeenCalledWith('c1', 'call', { takeOver: true });
  });

  it('the store drops the call when the host reports it ended', () => {
    useVoiceStore.getState().setRemoteCall(remote, true);
    useVoiceStore.getState().setRemoteCall(remote, false);
    expect(useVoiceStore.getState().remoteCalls).toEqual({});
  });
});
