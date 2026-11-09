// Call strip (spec/15 § Voice states — Voice call): one strip pinned at the top
// of every screen while a call runs — On call · length · waveform · mute · end.
// Tapping it returns to the call's chat. No Call/Hands-free switch (it lives in
// the call button's menu). Connecting is neutral; a failure shows its reason
// and Retry.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  actSync,
  byLabel,
  byTestId,
  findHost,
  queryHost,
  renderRN as renderRNRaw,
  textOf,
} from './testUtils/render';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useMicLevelStore } from '../src/stores/micLevelStore';
import { routerMock, __resetRouterMock } from './stubs/expo-router';

const { endVoiceCallSpy, retrySpy, setCallMutedSpy } = vi.hoisted(() => ({
  endVoiceCallSpy: vi.fn().mockResolvedValue(undefined),
  retrySpy: vi.fn().mockResolvedValue(undefined),
  setCallMutedSpy: vi.fn(),
}));
vi.mock('../src/lib/voiceCall', () => ({
  endVoiceCall: endVoiceCallSpy,
  retryVoiceCall: retrySpy,
  setCallMuted: setCallMutedSpy,
}));

import { CallStrip } from '../src/components/CallStrip';

const T0 = new Date('2026-09-24T10:00:00Z').getTime();
const mounted: ReturnType<typeof renderRNRaw>[] = [];
function renderRN(el: React.ReactElement): ReturnType<typeof renderRNRaw> {
  const r = renderRNRaw(el);
  mounted.push(r);
  return r;
}

function call(extra: Partial<ReturnType<typeof useVoiceStore.getState>> = {}): void {
  useVoiceStore.setState({
    activeSession: { sessionId: 'sess-1', chatId: 'thread_manager', audioUrl: '/a', startedAt: T0 },
    callMuted: false,
    callError: null,
    callPhase: 'listening',
    callTranscriptPartial: '',
    callMode: 'call',
    callUnaddressed: null,
    callConnectedAt: T0,
    callAddressWord: 'patch',
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.clearAllMocks();
  __resetRouterMock();
  useMicLevelStore.getState().reset();
  useVoiceStore.setState({ activeSession: null, callError: null, callConnectedAt: null });
});

afterEach(() => {
  for (const r of mounted.splice(0)) actSync(() => r.unmount());
  vi.useRealTimers();
});

describe('CallStrip', () => {
  it('renders nothing with no call', () => {
    expect(renderRN(<CallStrip />).toJSON()).toBeNull();
  });

  it('reads On call with the length after it, and a waveform instead of "Listening"', () => {
    call();
    const r = renderRN(<CallStrip />);
    expect(textOf(findHost(r.root, byTestId('call-phase')))).toBe('On call');
    expect(textOf(findHost(r.root, byTestId('call-timer')))).toBe('0:00');
    expect(queryHost(r.root, byTestId('call-wave'))).not.toBeNull();
    actSync(() => {
      vi.advanceTimersByTime(83_000);
    });
    expect(textOf(findHost(r.root, byTestId('call-timer')))).toBe('1:23');
  });

  it('the waveform follows the mic level and goes flat when muted', () => {
    call();
    const r = renderRN(<CallStrip />);
    actSync(() => {
      useMicLevelStore.setState({ level: 1 });
      vi.advanceTimersByTime(200);
    });
    const heights = (): number[] =>
      (
        findHost(r.root, byTestId('call-wave')).children as unknown as Array<{
          props: { style: { height: number } };
        }>
      ).map((c) => c.props.style.height);
    expect(heights().at(-1)).toBe(22);
    actSync(() => useVoiceStore.setState({ callMuted: true }));
    actSync(() => {
      vi.advanceTimersByTime(200);
    });
    expect(heights().at(-1)).toBe(2);
  });

  it('hands-free is named in the head, and shows the address-word hint on a second line', () => {
    call({ callMode: 'hands-free' });
    const r = renderRN(<CallStrip />);
    expect(textOf(findHost(r.root, byTestId('call-phase')))).toBe('Hands-free');
    expect(textOf(findHost(r.root, byTestId('call-hint')))).toBe(
      'Start with “patch” — or reply within 30s of it speaking',
    );
  });

  it('carries no Call/Hands-free switch', () => {
    call();
    const r = renderRN(<CallStrip />);
    expect(queryHost(r.root, byTestId('call-mode-switch'))).toBeNull();
  });

  it('a hand-off running reads Agent working in place of the waveform', () => {
    call({ callPhase: 'thinking' });
    const r = renderRN(<CallStrip />);
    expect(textOf(findHost(r.root, byTestId('call-working')))).toBe('Agent working');
    expect(queryHost(r.root, byTestId('call-wave'))).toBeNull();
  });

  it('connecting is its own state: counting dots, no clock, no waveform', () => {
    call({ callPhase: 'connecting', callConnectedAt: null });
    const r = renderRN(<CallStrip />);
    expect(textOf(findHost(r.root, byTestId('call-connecting')))).toBe('Connecting.');
    expect(queryHost(r.root, byTestId('call-timer'))).toBeNull();
    expect(queryHost(r.root, byTestId('call-wave'))).toBeNull();
  });

  it('shows the live words, then the unaddressed line only when there are none', () => {
    call({ callMode: 'hands-free', callUnaddressed: 'old', callTranscriptPartial: 'patch hi' });
    const r = renderRN(<CallStrip />);
    expect(textOf(findHost(r.root, byTestId('call-partial')))).toBe('You: patch hi');
    expect(queryHost(r.root, byTestId('call-unaddressed'))).toBeNull();
    actSync(() => useVoiceStore.setState({ callTranscriptPartial: '' }));
    expect(textOf(findHost(r.root, byTestId('call-unaddressed')))).toContain('not addressed');
  });

  it('tapping the strip returns to the call’s chat', () => {
    call();
    const r = renderRN(<CallStrip />);
    findHost(r.root, byTestId('call-strip-open')).props['onPress']();
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/thread_manager');
  });

  it('mute and end are wired', () => {
    call();
    const r = renderRN(<CallStrip />);
    findHost(r.root, byLabel('Mute')).props['onPress']();
    expect(setCallMutedSpy).toHaveBeenCalledWith(true);
    findHost(r.root, byLabel('End call')).props['onPress']();
    expect(endVoiceCallSpy).toHaveBeenCalledTimes(1);
  });

  it('a failed call shows the reason and Retry, and End still works', () => {
    call({ callError: 'Call dropped — the audio connection closed', callTranscriptPartial: 'x' });
    const r = renderRN(<CallStrip />);
    expect(textOf(findHost(r.root, byTestId('call-phase')))).toBe('Call problem');
    expect(textOf(findHost(r.root, byTestId('call-error')))).toContain('Call dropped');
    expect(queryHost(r.root, byTestId('call-partial'))).toBeNull();
    findHost(r.root, byLabel('Retry call')).props['onPress']();
    expect(retrySpy).toHaveBeenCalledTimes(1);
    findHost(r.root, byLabel('End call')).props['onPress']();
    expect(endVoiceCallSpy).toHaveBeenCalledTimes(1);
  });
});
