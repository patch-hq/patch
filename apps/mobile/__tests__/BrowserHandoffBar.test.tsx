// The agent's browser on the phone (spec/15 § Browser): the bar at the top of
// the chat, the live card above the composer, the browser open over the whole
// screen, and the sign-in card.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderRN, queryHost, byTestId, textOf } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { useBrowserHandoffStore } from '../src/stores/browserHandoffStore';
import {
  browsingSummary,
  driveState,
  formatElapsed,
  siteOf,
  toViewport,
} from '../src/lib/browserHandoff';
import { KEYS_SENTINEL, keysEvents } from '../src/lib/browserKeys';
import type { WireEvent } from '@patch/wire';

const ws = vi.hoisted(() => ({ safeSend: vi.fn(), send: vi.fn() }));
vi.mock('../src/api/ws', () => ({ getWs: () => ws }));

import { BrowserHandoffBar } from '../src/components/chatBars/BrowserHandoffBar';
import { BrowserLiveCard } from '../src/components/browser/BrowserLiveCard';

const frame = {
  tabId: 't1',
  data: 'AAAA',
  width: 1000,
  height: 500,
  url: 'https://accounts.example.com/signin',
  title: 'Sign in',
  inputVersion: 2,
  canGoBack: true,
  canGoForward: false,
};
const status = (over: Record<string, unknown> = {}) =>
  ({
    type: 'patch.browser_view.status',
    chatId: 'c1',
    active: true,
    action: 'Clicking',
    tabs: [{ tabId: 't1', url: 'https://www.gwr.com/a?x=1', handedOff: false }],
    ...over,
  }) as never;
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
const inputs = () =>
  sentOfType('patch.browser_view.input').map(
    (e) => (e as Extract<WireEvent, { type: 'patch.browser_view.input' }>).input,
  );

/** The open view, laid out: the stage 500x800 dp, so a 1000x500 page is drawn 500x250. */
function openView() {
  act(() => useBrowserHandoffStore.getState().setView('c1', 'open'));
  const r = renderRN(<BrowserLiveCard chatId="c1" />);
  const stage = queryHost(r.root, byTestId('browser-stage'))!;
  act(() => stage.props.onLayout({ nativeEvent: { layout: { width: 500, height: 800 } } }));
  return r;
}

beforeEach(() => {
  useChatStore.getState()._reset();
  useBrowserHandoffStore.getState().reset();
  ws.safeSend.mockReset();
});

describe('the bar', () => {
  it('renders nothing for a chat with no browser open', () => {
    const r = renderRN(<BrowserHandoffBar chatId="c1" />);
    expect(r.toJSON()).toBeNull();
  });

  it('says what the agent is using the browser for and for how long, and Stop tells the host', () => {
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        c1: [
          { kind: 'tool_call', tool: 'mcp__patch__patch_browser_open', callId: 'k', seq: 1 },
        ] as never,
      },
      toolRunSummaries: {
        ...s.toolRunSummaries,
        c1: { k: { callIds: ['k'], summary: 'Comparing Saturday trains…', live: true } },
      },
    }));
    act(() =>
      useBrowserHandoffStore.getState().applyStatus(status({ since: Date.now() - 61_000 })),
    );
    const r = renderRN(<BrowserHandoffBar chatId="c1" />);
    expect(textOf(queryHost(r.root, byTestId('browser-status'))!)).toBe(
      'Comparing Saturday trains',
    );
    expect(textOf(queryHost(r.root, byTestId('browser-elapsed'))!)).toBe('1:01');
    act(() => queryHost(r.root, byTestId('browser-stop'))!.props.onPress());
    expect(sentOfType('patch.browser_view.stop')).toEqual([
      { type: 'patch.browser_view.stop', chatId: 'c1' },
    ]);
    // A tap brings the card up, and the bar steps aside for it.
    act(() => queryHost(r.root, byTestId('browser-status'))!.props.onPress());
    expect(useBrowserHandoffStore.getState().views.c1).toBe('card');
    expect(r.toJSON()).toBeNull();
  });

  it('goes when nothing is open any more', () => {
    act(() => useBrowserHandoffStore.getState().applyStatus(status()));
    const r = renderRN(<BrowserHandoffBar chatId="c1" />);
    expect(queryHost(r.root, byTestId('browser-watch-bar'))).not.toBeNull();
    act(() => useBrowserHandoffStore.getState().applyStatus(status({ active: false, tabs: [] })));
    expect(r.toJSON()).toBeNull();
  });
});

describe('the live card', () => {
  it('comes up by itself when the agent asks, with Done', () => {
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(status());
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
      useBrowserHandoffStore.getState().applyState(waiting);
    });
    const r = renderRN(<BrowserLiveCard chatId="c1" />);
    expect(textOf(queryHost(r.root, byTestId('browser-handoff-title'))!)).toBe(
      'Sign in to Example',
    );
    expect(sentOfType('patch.browser_view.watch')[0]).toMatchObject({ watch: true, tabId: 't1' });
    act(() => queryHost(r.root, byTestId('browser-handoff-done'))!.props.onPress());
    expect(sentOfType('patch.browser_handoff.control').at(-1)).toEqual({
      type: 'patch.browser_handoff.control',
      chatId: 'c1',
      handoffId: 'h1',
      action: 'done',
    });
  });

  it('Take over hands the tab to the user and opens it', () => {
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(status());
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
      useBrowserHandoffStore.getState().setView('c1', 'card');
    });
    const r = renderRN(<BrowserLiveCard chatId="c1" />);
    act(() => queryHost(r.root, byTestId('browser-take-over'))!.props.onPress());
    expect(sentOfType('patch.browser_view.drive')).toEqual([
      { type: 'patch.browser_view.drive', chatId: 'c1', tabId: 't1', driver: 'user' },
    ]);
    expect(useBrowserHandoffStore.getState().views.c1).toBe('open');
  });

  it('is the page’s sign-in form as the phone’s own fields, filled without the agent seeing them', () => {
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(status());
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
      useBrowserHandoffStore.getState().applyState(waiting);
      useBrowserHandoffStore.getState().applyForm({
        type: 'patch.browser_view.form',
        chatId: 'c1',
        tabId: 't1',
        formId: 'f1',
        site: 'gwr.com',
        fields: [
          { field: 'p0', label: 'Email', kind: 'email' },
          { field: 'p1', label: 'Password', kind: 'password' },
        ],
      });
    });
    const r = renderRN(<BrowserLiveCard chatId="c1" />);
    const pw = queryHost(r.root, byTestId('browser-signin-password'))!;
    expect(pw.props.secureTextEntry).toBe(true);
    act(() =>
      queryHost(r.root, byTestId('browser-signin-email'))!.props.onChangeText('tom@example.com'),
    );
    act(() =>
      queryHost(r.root, byTestId('browser-signin-password'))!.props.onChangeText('hunter2'),
    );
    act(() => queryHost(r.root, byTestId('browser-signin-submit'))!.props.onPress());
    expect(inputs().at(-1)).toEqual({
      kind: 'fill',
      formId: 'f1',
      values: [
        { field: 'p0', value: 'tom@example.com' },
        { field: 'p1', value: 'hunter2' },
      ],
      submit: true,
    });
    // The page itself is still there for a form the card cannot fill.
    act(() => queryHost(r.root, byTestId('browser-signin-page'))!.props.onPress());
    expect(queryHost(r.root, byTestId('browser-signin'))).toBeNull();
    expect(queryHost(r.root, byTestId('browser-handoff'))).not.toBeNull();
  });
});

describe('the open browser', () => {
  it('lays the page out at the phone’s size and pixel ratio', async () => {
    vi.useFakeTimers();
    try {
      act(() => {
        useBrowserHandoffStore.getState().applyStatus(status());
        useBrowserHandoffStore.getState().applyFrame('c1', frame);
      });
      openView();
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      expect(sentOfType('patch.browser_view.watch').at(-1)).toMatchObject({
        watch: true,
        viewport: { width: 500, height: 800, scale: 2 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clicks where a tap lands and scrolls as a finger drags, never both', () => {
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(status());
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
    });
    const r = openView();
    const pic = queryHost(r.root, byTestId('browser-handoff-frame'))!;
    act(() => pic.props.onPress({ nativeEvent: { locationX: 250, locationY: 125 } }));
    expect(inputs().at(-1)).toEqual({ kind: 'pointer', action: 'click', x: 500, y: 250 });
    ws.safeSend.mockClear();
    // Android sends the drag's press before its touchEnd.
    act(() => pic.props.onTouchStart({ nativeEvent: { pageX: 100, pageY: 300 } }));
    act(() => pic.props.onTouchMove({ nativeEvent: { pageX: 100, pageY: 250 } }));
    act(() => pic.props.onTouchMove({ nativeEvent: { pageX: 100, pageY: 200 } }));
    act(() => pic.props.onPress({ nativeEvent: { locationX: 10, locationY: 10 } }));
    act(() => pic.props.onTouchEnd({ nativeEvent: { pageX: 100, pageY: 200 } }));
    expect(inputs()).toEqual([
      { kind: 'scroll', x: 500, y: 250, dx: 0, dy: 100 },
      { kind: 'scroll', x: 500, y: 250, dx: 0, dy: 100 },
    ]);
  });

  it('types through the hidden field, Backspace included, and goes back', () => {
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(status());
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
    });
    const r = openView();
    const keys = queryHost(r.root, byTestId('browser-handoff-keys'))!;
    expect(keys.props.defaultValue).toBe(KEYS_SENTINEL);
    act(() => keys.props.onChangeText(`${KEYS_SENTINEL}ab`));
    act(() => keys.props.onChangeText(KEYS_SENTINEL));
    act(() => keys.props.onSubmitEditing());
    act(() => queryHost(r.root, byTestId('browser-back'))!.props.onPress());
    expect(inputs()).toEqual([
      { kind: 'text', text: 'ab' },
      { kind: 'key', key: 'Backspace' },
      { kind: 'key', key: 'Backspace' },
      { kind: 'key', key: 'Enter' },
      { kind: 'nav', action: 'back' },
    ]);
    act(() => queryHost(r.root, byTestId('browser-live-minimise'))!.props.onPress());
    expect(useBrowserHandoffStore.getState().views.c1).toBe('card');
  });

  it('on a host that takes nothing else, uses a hand-off’s own input', () => {
    act(() => {
      useBrowserHandoffStore.getState().applyFrame('c1', { ...frame, inputVersion: undefined });
      useBrowserHandoffStore.getState().applyState(waiting);
    });
    const r = openView();
    const pic = queryHost(r.root, byTestId('browser-handoff-frame'))!;
    act(() => pic.props.onPress({ nativeEvent: { locationX: 250, locationY: 125 } }));
    expect(sentOfType('patch.browser_view.input')).toHaveLength(0);
    expect(sentOfType('patch.browser_handoff.input').at(-1)).toEqual({
      type: 'patch.browser_handoff.input',
      chatId: 'c1',
      handoffId: 'h1',
      input: { kind: 'pointer', action: 'click', x: 500, y: 250 },
    });
    expect(queryHost(r.root, byTestId('browser-take-over'))).toBeNull();
  });

  it('keeps every control at least 44dp for a thumb', () => {
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(status());
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
    });
    const r = openView();
    for (const id of [
      'browser-live-minimise',
      'browser-back',
      'browser-reload',
      'browser-take-over',
    ]) {
      const merged = Object.assign({}, ...[queryHost(r.root, byTestId(id))!.props.style].flat());
      expect(merged.minHeight).toBeGreaterThanOrEqual(44);
      expect(merged.minWidth).toBeGreaterThanOrEqual(44);
    }
  });
});

describe('browser helpers (mobile)', () => {
  it('maps a tap on the picture to page pixels, clamped to the page', () => {
    const shown = { width: 400, height: 200 };
    const vp = { width: 1280, height: 640 };
    expect(toViewport({ x: 200, y: 100 }, shown, vp)).toEqual({ x: 640, y: 320 });
    expect(toViewport({ x: 999, y: -5 }, shown, vp)).toEqual({ x: 1279, y: 0 });
  });

  it('sends only what was newly typed, however fast, and one Backspace per deletion', () => {
    const held = { current: KEYS_SENTINEL };
    expect(keysEvents(held, `${KEYS_SENTINEL}a`)).toEqual([{ kind: 'text', text: 'a' }]);
    expect(keysEvents(held, `${KEYS_SENTINEL}ab`)).toEqual([{ kind: 'text', text: 'b' }]);
    expect(keysEvents(held, '')).toEqual([
      { kind: 'key', key: 'Backspace' },
      { kind: 'key', key: 'Backspace' },
      { kind: 'key', key: 'Backspace' },
    ]);
  });

  it('names sites, times, who has the tab and what it is for', () => {
    expect(siteOf('https://www.bbc.co.uk/x')).toBe('bbc.co.uk');
    expect(formatElapsed(725_000)).toBe('12:05');
    expect(driveState({ tabId: 't1' }, undefined, 't1')).toBe('needs');
    expect(driveState(undefined, { tabs: [{ tabId: 't1', driver: 'user' }] }, 't1')).toBe('user');
    expect(
      browsingSummary([{ kind: 'tool_call', tool: 'patch_browser_read', callId: 'a' }], {
        a: { callIds: ['a'], summary: 'Reading the page…' },
      }),
    ).toBe('Reading the page');
  });
});
