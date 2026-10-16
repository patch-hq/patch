// Agent browser live view and hand-off (spec/14 § Browser hand-off): the
// panel in the chat that lets the user take over the agent's tab.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { WireEvent } from '@patch/wire';
import { BrowserHandoffPanel } from '../components/BrowserHandoffPanel.js';
import { useBrowserHandoffStore } from '../stores/browserHandoffStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { setActiveWs, type PatchWs } from '../api/ws.js';
import {
  keyForEvent,
  toViewport,
  chatUsedBrowser,
  browsingLabel,
  canStopBrowser,
  clampPreview,
  fitSize,
} from '../lib/browserHandoff.js';

const frame = {
  tabId: 't1',
  data: 'AAAA',
  width: 1000,
  height: 500,
  url: 'https://accounts.example.com/signin',
  title: 'Sign in',
};

function fakeWs() {
  const sent: WireEvent[] = [];
  const push = (e: WireEvent): number => sent.push(e);
  setActiveWs({ send: push, safeSend: push } as unknown as PatchWs);
  return sent;
}

describe('BrowserHandoffPanel', () => {
  beforeEach(() => {
    useBrowserHandoffStore.getState().reset();
    useChatStore.getState()._reset();
  });
  afterEach(() => {
    setActiveWs(null);
    vi.restoreAllMocks();
  });

  it('renders nothing for a chat that never used the browser', () => {
    fakeWs();
    const { container } = render(<BrowserHandoffPanel chatId="c1" />);
    expect(container.firstChild).toBeNull();
  });

  it('offers a read-only view once the agent has used its browser, and asks the host for frames', () => {
    const sent = fakeWs();
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        c1: [{ kind: 'tool_call', tool: 'mcp__patch__patch_browser_open', seq: 1 }] as never,
      },
    }));
    render(<BrowserHandoffPanel chatId="c1" />);
    fireEvent.click(screen.getByTestId('browser-watch'));
    expect(sent).toContainEqual({ type: 'patch.browser_view.watch', chatId: 'c1', watch: true });
    expect(screen.getByTestId('browser-handoff-empty').textContent).toBe('Connecting');

    act(() => useBrowserHandoffStore.getState().applyFrame('c1', frame));
    // A small preview first; expanded, still read-only: a picture and an address, no input.
    expect(screen.getByTestId('browser-handoff-preview')).toBeTruthy();
    fireEvent.click(screen.getByTestId('browser-handoff-expand'));
    expect(screen.getByTestId('browser-handoff-frame')).toBeTruthy();
    expect(screen.queryByTestId('browser-handoff-keys')).toBeNull();
    expect(screen.queryByTestId('browser-handoff-done')).toBeNull();
    fireEvent.click(screen.getByTestId('browser-handoff-frame'));
    expect(sent.filter((e) => e.type === 'patch.browser_handoff.input')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('browser-live-minimise'));

    fireEvent.click(screen.getByTestId('browser-watch-close'));
    expect(sent.at(-1)).toEqual({ type: 'patch.browser_view.watch', chatId: 'c1', watch: false });
  });

  it('shows the hand-off prompt and relays clicks, typing, keys, Done and Cancel to the host', () => {
    const sent = fakeWs();
    useBrowserHandoffStore.getState().applyFrame('c1', frame);
    useBrowserHandoffStore.getState().applyState({
      type: 'patch.browser_handoff.state',
      chatId: 'c1',
      handoffId: 'h1',
      tabId: 't1',
      status: 'waiting',
      reason: 'Sign in to Example',
      startedAt: 1,
    });
    render(<BrowserHandoffPanel chatId="c1" />);
    expect(screen.getByTestId('browser-handoff-title').textContent).toBe('Sign in to Example');
    // Done works from the small preview too.
    fireEvent.click(screen.getByTestId('browser-handoff-done'));
    expect(sent.at(-1)).toMatchObject({ type: 'patch.browser_handoff.control', action: 'done' });

    fireEvent.click(screen.getByTestId('browser-handoff-expand'));
    expect(screen.getByTestId('browser-handoff-keys')).toBe(document.activeElement);
    const img = screen.getByTestId('browser-handoff-frame');
    img.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 500, height: 250, right: 510, bottom: 270 }) as DOMRect;
    fireEvent.click(img, { clientX: 260, clientY: 145 });
    expect(sent.at(-1)).toEqual({
      type: 'patch.browser_handoff.input',
      chatId: 'c1',
      handoffId: 'h1',
      input: { kind: 'pointer', action: 'click', x: 500, y: 250 },
    });

    const keys = screen.getByTestId('browser-handoff-keys') as HTMLInputElement;
    fireEvent.input(keys, { target: { value: 'hunter2' } });
    expect(sent.at(-1)).toMatchObject({ input: { kind: 'text', text: 'hunter2' } });
    expect(keys.value).toBe('');
    fireEvent.keyDown(keys, { key: 'Enter' });
    expect(sent.at(-1)).toMatchObject({ input: { kind: 'key', key: 'Enter' } });

    fireEvent.click(screen.getByTestId('browser-handoff-done'));
    expect(sent.at(-1)).toEqual({
      type: 'patch.browser_handoff.control',
      chatId: 'c1',
      handoffId: 'h1',
      action: 'done',
    });
    fireEvent.click(screen.getByTestId('browser-handoff-cancel'));
    expect(sent.at(-1)).toMatchObject({ action: 'cancel' });
  });

  const statusEvent = (over: Record<string, unknown> = {}) =>
    ({
      type: 'patch.browser_view.status',
      chatId: 'c1',
      active: false,
      tabs: [{ tabId: 't1', url: 'https://www.example.com/a?x=1', handedOff: false }],
      ...over,
    }) as never;

  it('says what the chat is browsing, with Watch and Stop, before the user asks to watch', () => {
    const sent = fakeWs();
    act(() =>
      useBrowserHandoffStore
        .getState()
        .applyStatus(statusEvent({ active: true, action: 'Clicking' })),
    );
    render(<BrowserHandoffPanel chatId="c1" />);
    expect(screen.getByTestId('browser-status').textContent).toBe(
      'Browsing example.com · Clicking',
    );
    fireEvent.click(screen.getByTestId('browser-stop'));
    expect(sent).toEqual([{ type: 'patch.browser_view.stop', chatId: 'c1' }]);
  });

  it('keeps Stop in the watch view, and drops it once the chat has nothing open', () => {
    const sent = fakeWs();
    act(() => useBrowserHandoffStore.getState().applyStatus(statusEvent()));
    render(<BrowserHandoffPanel chatId="c1" />);
    fireEvent.click(screen.getByTestId('browser-watch'));
    expect(screen.getByTestId('browser-handoff-title').textContent).toBe('Browsing example.com');
    fireEvent.click(screen.getByTestId('browser-stop'));
    expect(sent).toContainEqual({ type: 'patch.browser_view.stop', chatId: 'c1' });
    act(() => useBrowserHandoffStore.getState().applyStatus(statusEvent({ tabs: [] })));
    expect(screen.queryByTestId('browser-stop')).toBeNull();
  });

  it('offers no Stop for a chat whose browser is closed, though it used one earlier', () => {
    fakeWs();
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        c1: [{ kind: 'tool_call', tool: 'mcp__patch__patch_browser_open', seq: 1 }] as never,
      },
    }));
    render(<BrowserHandoffPanel chatId="c1" />);
    expect(screen.getByTestId('browser-status').textContent).toBe('Browser');
    expect(screen.queryByTestId('browser-stop')).toBeNull();
  });

  it('goes away when the host reports the hand-off ended', () => {
    fakeWs();
    const { applyState } = useBrowserHandoffStore.getState();
    const base = {
      type: 'patch.browser_handoff.state' as const,
      chatId: 'c1',
      handoffId: 'h1',
      tabId: 't1',
      reason: 'x',
      startedAt: 1,
    };
    applyState({ ...base, status: 'waiting' });
    const { container, rerender } = render(<BrowserHandoffPanel chatId="c1" />);
    expect(screen.getByTestId('browser-handoff')).toBeTruthy();
    act(() => applyState({ ...base, status: 'ended', outcome: 'done' }));
    rerender(<BrowserHandoffPanel chatId="c1" />);
    expect(container.firstChild).toBeNull();
  });
});

describe('BrowserHandoffPanel floating preview', () => {
  afterEach(() => {
    setActiveWs(null);
    localStorage.clear();
  });

  it('moves when dragged and remembers where, and expands when tapped instead', () => {
    fakeWs();
    useBrowserHandoffStore.getState().reset();
    useBrowserHandoffStore.getState().applyFrame('c1', frame);
    useBrowserHandoffStore.getState().applyState({
      type: 'patch.browser_handoff.state',
      chatId: 'c1',
      handoffId: 'h1',
      tabId: 't1',
      status: 'waiting',
      reason: 'Sign in',
      startedAt: 1,
    });
    render(<BrowserHandoffPanel chatId="c1" />);
    const card = screen.getByTestId('browser-handoff');
    const before = { left: card.style.left, top: card.style.top };
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 60, clientY: 40 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 60, clientY: 40 });
    expect(screen.queryByTestId('browser-live')).toBeNull();
    expect({ left: card.style.left, top: card.style.top }).not.toEqual(before);
    expect(localStorage.getItem('patch.browserPreview.position')).not.toBeNull();

    fireEvent.pointerDown(card, { pointerId: 2, button: 0, clientX: 60, clientY: 40 });
    fireEvent.pointerUp(card, { pointerId: 2, clientX: 61, clientY: 41 });
    expect(screen.getByTestId('browser-live')).toBeTruthy();
  });
});

describe('browser hand-off helpers', () => {
  it('fits the page into a box keeping its shape', () => {
    expect(fitSize({ width: 1000, height: 1000 }, { width: 1280, height: 720 })).toEqual({
      width: 1000,
      height: 562,
    });
    expect(fitSize({ width: 0, height: 400 }, { width: 1280, height: 720 })).toEqual({
      width: 0,
      height: 0,
    });
  });

  it('keeps the floating preview inside the window', () => {
    const size = { width: 288, height: 200 };
    const win = { width: 1000, height: 800 };
    expect(clampPreview({ x: -50, y: 9999 }, size, win, 12)).toEqual({ x: 12, y: 588 });
    expect(clampPreview({ x: 300, y: 300 }, size, win, 12)).toEqual({ x: 300, y: 300 });
  });

  it('maps a point on the picture to page pixels, clamped to the page', () => {
    const rect = { left: 0, top: 0, width: 400, height: 200 };
    const vp = { width: 1280, height: 640 };
    expect(toViewport({ clientX: 200, clientY: 100 }, rect, vp)).toEqual({ x: 640, y: 320 });
    expect(toViewport({ clientX: 999, clientY: -5 }, rect, vp)).toEqual({ x: 1279, y: 0 });
  });

  it('maps by the drawn picture when the box is wider than the picture', () => {
    // A 1280x800 page contained in a 1200x400 box is drawn 640x400 at the top left.
    const rect = { left: 100, top: 50, width: 1200, height: 400 };
    const vp = { width: 1280, height: 800 };
    expect(toViewport({ clientX: 420, clientY: 250 }, rect, vp)).toEqual({ x: 640, y: 400 });
  });

  it('sends named keys and chords as keys, and leaves plain characters to the text input', () => {
    const e = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(keyForEvent({ ...e, key: 'a' })).toBeNull();
    expect(keyForEvent({ ...e, key: 'Backspace' })).toBe('Backspace');
    expect(keyForEvent({ ...e, key: 'Tab', shiftKey: true })).toBe('Shift+Tab');
    expect(keyForEvent({ ...e, key: 'a', ctrlKey: true })).toBe('Control+a');
  });

  it('labels what a chat is browsing and when there is something to stop', () => {
    const tabs = [{ url: 'https://www.bbc.co.uk/news' }];
    expect(browsingLabel(undefined)).toBe('Browser');
    expect(browsingLabel({ active: false, tabs })).toBe('Browsing bbc.co.uk');
    expect(browsingLabel({ active: true, action: 'Typing', tabs })).toBe(
      'Browsing bbc.co.uk · Typing',
    );
    expect(browsingLabel({ active: true, action: 'Waiting', tabs: [] })).toBe('Browsing · Waiting');
    expect(canStopBrowser(undefined)).toBe(false);
    expect(canStopBrowser({ active: false, tabs: [] })).toBe(false);
    expect(canStopBrowser({ active: false, tabs })).toBe(true);
    expect(canStopBrowser({ active: true, tabs: [] })).toBe(true);
  });

  it('detects browser use in a transcript', () => {
    expect(chatUsedBrowser([{ kind: 'message' }])).toBe(false);
    expect(chatUsedBrowser([{ kind: 'tool_call', tool: 'mcp__patch__patch_browser_read' }])).toBe(
      true,
    );
  });
});
