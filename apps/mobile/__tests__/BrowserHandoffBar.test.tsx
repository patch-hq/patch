// Agent browser live view and hand-off on the phone (spec/15 § Browser
// hand-off): the bar in the chat that lets the user take over the agent's tab.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderRN, queryHost, byTestId, textOf } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { useBrowserHandoffStore } from '../src/stores/browserHandoffStore';
import { chatUsedBrowser, toViewport, browsingLabel } from '../src/lib/browserHandoff';
import type { WireEvent } from '@patch/wire';

const ws = vi.hoisted(() => ({ safeSend: vi.fn(), send: vi.fn() }));
vi.mock('../src/api/ws', () => ({ getWs: () => ws }));

import { BrowserHandoffBar, KEYS_SENTINEL } from '../src/components/chatBars/BrowserHandoffBar';

const frame = {
  tabId: 't1',
  data: 'AAAA',
  width: 1000,
  height: 500,
  url: 'https://accounts.example.com/signin',
  title: 'Sign in',
};
const waiting = {
  type: 'patch.browser_handoff.state' as const,
  chatId: 'c1',
  handoffId: 'h1',
  tabId: 't1',
  status: 'waiting' as const,
  reason: 'Sign in to Example',
  startedAt: 1,
};
const sentOfType = (type: string): WireEvent[] =>
  ws.safeSend.mock.calls.map((c) => c[0] as WireEvent).filter((e) => e.type === type);

describe('BrowserHandoffBar', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useBrowserHandoffStore.getState().reset();
    ws.safeSend.mockReset();
  });

  it('renders nothing for a chat that never used the browser', () => {
    const r = renderRN(<BrowserHandoffBar chatId="c1" />);
    expect(r.toJSON()).toBeNull();
  });

  it('says what the chat is browsing with Watch and Stop, and Stop tells the host', () => {
    act(() =>
      useBrowserHandoffStore.getState().applyStatus({
        type: 'patch.browser_view.status',
        chatId: 'c1',
        active: true,
        action: 'Clicking',
        tabs: [{ tabId: 't1', url: 'https://www.example.com/a?x=1', handedOff: false }],
      }),
    );
    const r = renderRN(<BrowserHandoffBar chatId="c1" />);
    expect(textOf(queryHost(r.root, byTestId('browser-status'))!)).toBe(
      'Browsing example.com · Clicking',
    );
    act(() => queryHost(r.root, byTestId('browser-stop'))!.props.onPress());
    expect(sentOfType('patch.browser_view.stop')).toEqual([
      { type: 'patch.browser_view.stop', chatId: 'c1' },
    ]);
    act(() =>
      useBrowserHandoffStore.getState().applyStatus({
        type: 'patch.browser_view.status',
        chatId: 'c1',
        active: false,
        tabs: [],
      }),
    );
    expect(r.toJSON()).toBeNull();
  });

  it('labels what a chat is browsing', () => {
    expect(browsingLabel(undefined)).toBe('Browser');
    expect(browsingLabel({ active: false, tabs: [{ url: 'https://www.bbc.co.uk/x' }] })).toBe(
      'Browsing bbc.co.uk',
    );
  });

  it('offers a read-only view once the agent used its browser, with no input controls', () => {
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        c1: [{ kind: 'tool_call', tool: 'mcp__patch__patch_browser_open', seq: 1 }] as never,
      },
    }));
    const r = renderRN(<BrowserHandoffBar chatId="c1" />);
    act(() => queryHost(r.root, byTestId('browser-watch'))!.props.onPress());
    expect(sentOfType('patch.browser_view.watch')).toContainEqual({
      type: 'patch.browser_view.watch',
      chatId: 'c1',
      watch: true,
    });
    act(() => useBrowserHandoffStore.getState().applyFrame('c1', frame));
    expect(queryHost(r.root, byTestId('browser-handoff-frame'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('browser-handoff-keys'))).toBeNull();
    expect(queryHost(r.root, byTestId('browser-handoff-done'))).toBeNull();
    act(() => queryHost(r.root, byTestId('browser-watch-close'))!.props.onPress());
    expect(sentOfType('patch.browser_view.watch').at(-1)).toMatchObject({ watch: false });
  });

  it('shows the prompt and relays taps, typing, keys, Done and Cancel to the host', () => {
    act(() => {
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
      useBrowserHandoffStore.getState().applyState(waiting);
    });
    const r = renderRN(<BrowserHandoffBar chatId="c1" />);
    expect(textOf(queryHost(r.root, byTestId('browser-handoff-title'))!)).toBe(
      'Sign in to Example',
    );

    const img = queryHost(r.root, byTestId('browser-handoff-frame'))!;
    act(() => img.props.onLayout({ nativeEvent: { layout: { width: 500, height: 250 } } }));
    act(() => img.props.onPress({ nativeEvent: { locationX: 250, locationY: 125 } }));
    expect(sentOfType('patch.browser_handoff.input').at(-1)).toEqual({
      type: 'patch.browser_handoff.input',
      chatId: 'c1',
      handoffId: 'h1',
      input: { kind: 'pointer', action: 'click', x: 500, y: 250 },
    });

    const keys = queryHost(r.root, byTestId('browser-handoff-keys'))!;
    act(() => keys.props.onChangeText(`${KEYS_SENTINEL}hunter2`));
    expect(sentOfType('patch.browser_handoff.input').at(-1)).toMatchObject({
      input: { kind: 'text', text: 'hunter2' },
    });
    // Android sends nothing for Backspace on an empty field, so the field holds
    // an invisible character and deleting it is the Backspace.
    expect(keys.props.defaultValue).toBe(KEYS_SENTINEL);
    expect(keys.props.value).toBeUndefined();
    act(() => keys.props.onChangeText(`${KEYS_SENTINEL}hunter2ab`));
    expect(sentOfType('patch.browser_handoff.input').at(-1)).toMatchObject({
      input: { kind: 'text', text: 'ab' },
    });
    act(() => keys.props.onChangeText(''));
    expect(sentOfType('patch.browser_handoff.input').at(-1)).toMatchObject({
      input: { kind: 'key', key: 'Backspace' },
    });
    act(() => keys.props.onSubmitEditing());
    expect(sentOfType('patch.browser_handoff.input').at(-1)).toMatchObject({
      input: { kind: 'key', key: 'Enter' },
    });

    act(() => queryHost(r.root, byTestId('browser-handoff-done'))!.props.onPress());
    expect(sentOfType('patch.browser_handoff.control').at(-1)).toEqual({
      type: 'patch.browser_handoff.control',
      chatId: 'c1',
      handoffId: 'h1',
      action: 'done',
    });
    act(() => queryHost(r.root, byTestId('browser-handoff-cancel'))!.props.onPress());
    expect(sentOfType('patch.browser_handoff.control').at(-1)).toMatchObject({ action: 'cancel' });
  });

  it('scrolls the page when the picture is dragged, without also clicking', () => {
    act(() => {
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
      useBrowserHandoffStore.getState().applyState(waiting);
    });
    const r = renderRN(<BrowserHandoffBar chatId="c1" />);
    const img = queryHost(r.root, byTestId('browser-handoff-frame'))!;
    act(() => img.props.onLayout({ nativeEvent: { layout: { width: 500, height: 250 } } }));
    ws.safeSend.mockClear();
    act(() => img.props.onTouchStart({ nativeEvent: { pageY: 300 } }));
    act(() => img.props.onTouchEnd({ nativeEvent: { pageY: 200 } }));
    act(() => img.props.onPress({ nativeEvent: { locationX: 10, locationY: 10 } }));
    const inputs = sentOfType('patch.browser_handoff.input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ input: { kind: 'scroll', dy: 200 } });
    // A plain tap afterwards still clicks.
    act(() => img.props.onTouchStart({ nativeEvent: { pageY: 300 } }));
    act(() => img.props.onTouchEnd({ nativeEvent: { pageY: 298 } }));
    act(() => img.props.onPress({ nativeEvent: { locationX: 10, locationY: 10 } }));
    expect(sentOfType('patch.browser_handoff.input').at(-1)).toMatchObject({
      input: { kind: 'pointer', action: 'click' },
    });
  });

  // Seen on an Android emulator: a drag arrives as touchStart, touchMove…,
  // press (onPress, at the lift-off point) and only THEN touchEnd — so the click
  // went to the page before the scroll, and dragging across a button pressed it.
  it('does not click the page when a drag releases, whichever of press / touchEnd comes first', () => {
    act(() => {
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
      useBrowserHandoffStore.getState().applyState(waiting);
    });
    const r = renderRN(<BrowserHandoffBar chatId="c1" />);
    const img = queryHost(r.root, byTestId('browser-handoff-frame'))!;
    act(() => img.props.onLayout({ nativeEvent: { layout: { width: 500, height: 250 } } }));
    ws.safeSend.mockClear();
    act(() => img.props.onTouchStart({ nativeEvent: { pageY: 300 } }));
    act(() => img.props.onTouchMove({ nativeEvent: { pageY: 250 } }));
    act(() => img.props.onTouchMove({ nativeEvent: { pageY: 200 } }));
    act(() => img.props.onPress({ nativeEvent: { locationX: 10, locationY: 10 } }));
    act(() => img.props.onTouchEnd({ nativeEvent: { pageY: 200 } }));
    const inputs = sentOfType('patch.browser_handoff.input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ input: { kind: 'scroll', dy: 200 } });
    // …and the next gesture, a plain tap, still clicks.
    act(() => img.props.onTouchStart({ nativeEvent: { pageY: 300 } }));
    act(() => img.props.onPress({ nativeEvent: { locationX: 10, locationY: 10 } }));
    act(() => img.props.onTouchEnd({ nativeEvent: { pageY: 299 } }));
    expect(sentOfType('patch.browser_handoff.input').at(-1)).toMatchObject({
      input: { kind: 'pointer', action: 'click' },
    });
  });

  // Seen on an Android emulator: typing "ab" quickly reached the page as "a"
  // then "ab" ("aab"), because the controlled field's native text is only put
  // back asynchronously and the second keystroke arrived on top of the first.
  it('sends only what was newly typed, however fast the keystrokes arrive', async () => {
    act(() => {
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
      useBrowserHandoffStore.getState().applyState(waiting);
    });
    const { textInputNativeProps } = (await import('react-native')) as unknown as {
      textInputNativeProps: Array<Record<string, unknown>>;
    };
    textInputNativeProps.length = 0;
    const r = renderRN(<BrowserHandoffBar chatId="c1" />);
    const keys = queryHost(r.root, byTestId('browser-handoff-keys'))!;
    act(() => keys.props.onChangeText(`${KEYS_SENTINEL}a`));
    act(() => keys.props.onChangeText(`${KEYS_SENTINEL}ab`));
    const typed = sentOfType('patch.browser_handoff.input').map(
      (e) => (e as never as { input: unknown }).input,
    );
    expect(typed).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);
    // One Backspace per press, the third one deleting the invisible character…
    for (const text of [`${KEYS_SENTINEL}a`, KEYS_SENTINEL, '']) {
      act(() => keys.props.onChangeText(text));
    }
    const backspaces = sentOfType('patch.browser_handoff.input').filter(
      (e) => (e as never as { input: { kind: string } }).input.kind === 'key',
    );
    expect(backspaces).toHaveLength(3);
    // …after which the field gets its invisible character back for the next one.
    expect(textInputNativeProps).toEqual([{ text: KEYS_SENTINEL }]);
  });

  it('keeps every control at least 44dp for a thumb', () => {
    act(() => {
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
      useBrowserHandoffStore.getState().applyState(waiting);
    });
    const r = renderRN(<BrowserHandoffBar chatId="c1" />);
    for (const id of ['up', 'down', 'cancel', 'done']) {
      const style = [queryHost(r.root, byTestId(`browser-handoff-${id}`))!.props.style].flat();
      const merged = Object.assign({}, ...style);
      expect(merged.minHeight).toBeGreaterThanOrEqual(44);
      expect(merged.minWidth).toBeGreaterThanOrEqual(44);
    }
  });

  it('types into a second hand-off without sending Backspaces left over from the first', () => {
    act(() => {
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
      useBrowserHandoffStore.getState().applyState(waiting);
    });
    const r = renderRN(<BrowserHandoffBar chatId="c1" />);
    act(() =>
      queryHost(r.root, byTestId('browser-handoff-keys'))!.props.onChangeText(
        `${KEYS_SENTINEL}abc`,
      ),
    );
    act(() =>
      useBrowserHandoffStore
        .getState()
        .applyState({ ...waiting, status: 'ended', outcome: 'done' }),
    );
    expect(queryHost(r.root, byTestId('browser-handoff-keys'))).toBeNull();
    act(() => useBrowserHandoffStore.getState().applyState({ ...waiting, handoffId: 'h2' }));
    ws.safeSend.mockClear();
    const keys = queryHost(r.root, byTestId('browser-handoff-keys'))!;
    act(() => keys.props.onChangeText(`${KEYS_SENTINEL}x`));
    const inputs = sentOfType('patch.browser_handoff.input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ handoffId: 'h2', input: { kind: 'text', text: 'x' } });
  });

  it('goes away when the host reports the hand-off ended', () => {
    act(() => useBrowserHandoffStore.getState().applyState(waiting));
    const r = renderRN(<BrowserHandoffBar chatId="c1" />);
    expect(queryHost(r.root, byTestId('browser-handoff'))).not.toBeNull();
    act(() =>
      useBrowserHandoffStore
        .getState()
        .applyState({ ...waiting, status: 'ended', outcome: 'done' }),
    );
    expect(r.toJSON()).toBeNull();
  });
});

describe('browser hand-off helpers (mobile)', () => {
  it('maps a tap on the picture to page pixels, clamped to the page', () => {
    const shown = { width: 400, height: 200 };
    const vp = { width: 1280, height: 640 };
    expect(toViewport({ x: 200, y: 100 }, shown, vp)).toEqual({ x: 640, y: 320 });
    expect(toViewport({ x: 999, y: -5 }, shown, vp)).toEqual({ x: 1279, y: 0 });
  });
  it('detects browser use in a transcript', () => {
    expect(chatUsedBrowser([{ kind: 'message' }])).toBe(false);
    expect(chatUsedBrowser([{ kind: 'tool_call', tool: 'patch_browser_read' }])).toBe(true);
  });
});
