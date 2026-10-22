// The agent's browser in the chat (spec/14 § Browser): the bar, the floating
// preview, the large view and what the user's input sends to the host.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { WireEvent } from '@patch/wire';
import { BrowserHandoffPanel } from '../components/BrowserHandoffPanel.js';
import { BrowserView } from '../components/BrowserView.js';
import { useBrowserHandoffStore } from '../stores/browserHandoffStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { setActiveWs, type PatchWs } from '../api/ws.js';
import {
  browsingSummary,
  canStopBrowser,
  clampPreview,
  driveState,
  fitSize,
  formatElapsed,
  keyForEvent,
  siteOf,
  toViewport,
} from '../lib/browserHandoff.js';

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

function fakeWs() {
  const sent: WireEvent[] = [];
  const push = (e: WireEvent): number => sent.push(e);
  setActiveWs({ send: push, safeSend: push } as unknown as PatchWs);
  return sent;
}

const statusEvent = (over: Record<string, unknown> = {}) =>
  ({
    type: 'patch.browser_view.status',
    chatId: 'c1',
    active: false,
    tabs: [{ tabId: 't1', url: 'https://www.gwr.com/tickets?x=1', handedOff: false }],
    ...over,
  }) as never;

const waiting = {
  type: 'patch.browser_handoff.state' as const,
  chatId: 'c1',
  handoffId: 'h1',
  tabId: 't1',
  status: 'waiting' as const,
  reason: 'Sign in to pay',
  startedAt: 1,
};

/** Give the picture a known place on screen: 500x250 at (10, 20), for a 1000x500 page. */
function placeSurface(): HTMLElement {
  const el = screen.getByTestId('browser-surface');
  el.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 500, height: 250, right: 510, bottom: 270 }) as DOMRect;
  return el;
}

const inputs = (sent: WireEvent[]) =>
  sent
    .filter((e) => e.type === 'patch.browser_view.input')
    .map((e) => (e as Extract<WireEvent, { type: 'patch.browser_view.input' }>).input);

describe('the bar', () => {
  beforeEach(() => {
    useBrowserHandoffStore.getState().reset();
    useChatStore.getState()._reset();
  });
  afterEach(() => setActiveWs(null));

  it('renders nothing for a chat with no browser open', () => {
    fakeWs();
    const { container } = render(<BrowserHandoffPanel chatId="c1" />);
    expect(container.firstChild).toBeNull();
  });

  it('says what the agent is using the browser for, where, and for how long, with Watch and Stop', () => {
    vi.useFakeTimers({ now: 100_000 });
    try {
      const sent = fakeWs();
      useChatStore.setState((s) => ({
        timelines: {
          ...s.timelines,
          c1: [
            { kind: 'tool_call', tool: 'mcp__patch__patch_browser_open', callId: 'k1', seq: 1 },
          ] as never,
        },
        toolRunSummaries: {
          ...s.toolRunSummaries,
          c1: { k1: { callIds: ['k1'], summary: 'Comparing Saturday trains…', live: true } },
        },
      }));
      act(() =>
        useBrowserHandoffStore
          .getState()
          .applyStatus(statusEvent({ active: true, action: 'Clicking', since: 100_000 - 102_000 })),
      );
      render(<BrowserHandoffPanel chatId="c1" />);
      expect(screen.getByTestId('browser-status').textContent).toBe(
        'Using browser · Comparing Saturday trains',
      );
      expect(screen.getByTestId('browser-watch-bar').textContent).toContain('gwr.com');
      expect(screen.getByTestId('browser-elapsed').textContent).toBe('1:42');
      fireEvent.click(screen.getByTestId('browser-stop'));
      expect(sent).toContainEqual({ type: 'patch.browser_view.stop', chatId: 'c1' });

      // Watch opens the small preview, which asks the host for pictures at the tab's own size.
      fireEvent.click(screen.getByTestId('browser-watch'));
      expect(screen.getByTestId('browser-handoff')).toBeTruthy();
      const watch = sent.find((e) => e.type === 'patch.browser_view.watch') as Extract<
        WireEvent,
        { type: 'patch.browser_view.watch' }
      >;
      expect(watch).toMatchObject({ chatId: 'c1', tabId: 't1', watch: true });
      expect(watch.viewerId).toBeTruthy();
      expect(watch.viewport).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the agent needs the user, and the preview opens by itself with Done', () => {
    const sent = fakeWs();
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(statusEvent());
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
      useBrowserHandoffStore.getState().applyState(waiting);
    });
    render(<BrowserHandoffPanel chatId="c1" />);
    expect(screen.getByTestId('browser-mini-line').textContent).toBe('Sign in to pay');
    expect(screen.getByTestId('browser-drive-chip').textContent).toBe('Needs you');
    fireEvent.click(screen.getByTestId('browser-handoff-done'));
    expect(sent.at(-1)).toEqual({
      type: 'patch.browser_handoff.control',
      chatId: 'c1',
      handoffId: 'h1',
      action: 'done',
    });
    // Closing the preview leaves the bar, saying so.
    fireEvent.click(screen.getByTestId('browser-watch-close'));
    expect(screen.getByTestId('browser-status').textContent).toBe('Needs you · Sign in to pay');
  });

  it('goes away when the host reports nothing is open any more', () => {
    fakeWs();
    act(() => useBrowserHandoffStore.getState().applyStatus(statusEvent()));
    const { container } = render(<BrowserHandoffPanel chatId="c1" />);
    expect(screen.getByTestId('browser-watch-bar')).toBeTruthy();
    act(() => useBrowserHandoffStore.getState().applyStatus(statusEvent({ tabs: [] })));
    expect(container.firstChild).toBeNull();
  });
});

describe('the preview', () => {
  beforeEach(() => {
    useBrowserHandoffStore.getState().reset();
    useChatStore.getState()._reset();
  });
  afterEach(() => {
    setActiveWs(null);
    localStorage.clear();
  });

  it('moves when dragged and remembers where, and opens the large view beside the chat when tapped', () => {
    fakeWs();
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(statusEvent());
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
      useBrowserHandoffStore.getState().setView('c1', 'mini');
    });
    render(<BrowserHandoffPanel chatId="c1" />);
    const card = screen.getByTestId('browser-handoff');
    const before = { left: card.style.left, top: card.style.top };
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 60, clientY: 40 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 60, clientY: 40 });
    expect({ left: card.style.left, top: card.style.top }).not.toEqual(before);
    expect(localStorage.getItem('patch.browserPreview.position')).not.toBeNull();
    expect(useBrowserHandoffStore.getState().views.c1).toBe('mini');

    const picture = screen.getByTestId('browser-handoff-preview');
    fireEvent.pointerDown(picture, { pointerId: 2, button: 0, clientX: 60, clientY: 40 });
    fireEvent.pointerUp(picture, { pointerId: 2, clientX: 61, clientY: 41 });
    expect(useBrowserHandoffStore.getState().views.c1).toBe('large');
    expect(useLayoutStore.getState().findTab({ kind: 'browser', chatId: 'c1' })).not.toBeNull();
  });

  it('Take over hands the tab to the user and opens it large', () => {
    const sent = fakeWs();
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(statusEvent());
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
      useBrowserHandoffStore.getState().setView('c1', 'mini');
    });
    render(<BrowserHandoffPanel chatId="c1" />);
    fireEvent.click(screen.getByTestId('browser-take-over'));
    expect(sent).toContainEqual({
      type: 'patch.browser_view.drive',
      chatId: 'c1',
      tabId: 't1',
      driver: 'user',
    });
    expect(useBrowserHandoffStore.getState().views.c1).toBe('large');
  });
});

describe('the large view', () => {
  beforeEach(() => {
    useBrowserHandoffStore.getState().reset();
    useChatStore.getState()._reset();
  });
  afterEach(() => setActiveWs(null));

  it('presses and releases at the matching page pixel, so a drag selects', () => {
    const sent = fakeWs();
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(statusEvent());
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
    });
    render(<BrowserView chatId="c1" layout="pane" />);
    const surface = placeSurface();
    fireEvent.pointerDown(surface, {
      pointerId: 1,
      button: 0,
      detail: 1,
      clientX: 60,
      clientY: 45,
    });
    fireEvent.pointerUp(surface, {
      pointerId: 1,
      button: 0,
      detail: 1,
      clientX: 260,
      clientY: 145,
      shiftKey: true,
    });
    expect(inputs(sent)).toEqual([
      { kind: 'pointer', action: 'down', x: 100, y: 50, button: 'left', clickCount: 1 },
      { kind: 'pointer', action: 'move', x: 500, y: 250 },
      {
        kind: 'pointer',
        action: 'up',
        x: 500,
        y: 250,
        button: 'left',
        clickCount: 1,
        modifiers: ['Shift'],
      },
    ]);
  });

  it('types, sends named keys and chords, copies the selection out, and goes back', () => {
    const sent = fakeWs();
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(statusEvent());
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
    });
    render(<BrowserView chatId="c1" layout="pane" />);
    const keys = screen.getByTestId('browser-handoff-keys') as HTMLInputElement;
    expect(keys).toBe(document.activeElement);
    fireEvent.input(keys, { target: { value: 'tom@example.com' } });
    fireEvent.keyDown(keys, { key: 'Enter' });
    fireEvent.keyDown(keys, { key: 'a', metaKey: true });
    fireEvent.keyDown(keys, { key: 'c', metaKey: true });
    fireEvent.paste(keys, { clipboardData: { getData: () => 'pasted' } });
    fireEvent.click(screen.getByTestId('browser-back'));
    expect(inputs(sent)).toEqual([
      { kind: 'text', text: 'tom@example.com' },
      { kind: 'key', key: 'Enter' },
      { kind: 'key', key: 'Meta+a' },
      { kind: 'copy' },
      { kind: 'text', text: 'pasted' },
      { kind: 'nav', action: 'back' },
    ]);
    // Forward is off: the tab has nowhere forward to go.
    expect((screen.getByTestId('browser-forward') as HTMLButtonElement).disabled).toBe(true);
  });

  it('goes to an address the user types', () => {
    const sent = fakeWs();
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(statusEvent());
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
    });
    render(<BrowserView chatId="c1" layout="pane" />);
    expect(screen.getByTestId('browser-handoff-url').textContent).toBe(
      'accounts.example.com/signin',
    );
    fireEvent.click(screen.getByTestId('browser-handoff-url'));
    const field = screen.getByTestId('browser-address-input') as HTMLInputElement;
    expect(field.value).toBe('https://accounts.example.com/signin');
    fireEvent.change(field, { target: { value: 'bbc.co.uk' } });
    fireEvent.submit(field.closest('form')!);
    expect(inputs(sent).at(-1)).toEqual({ kind: 'nav', action: 'goto', url: 'bbc.co.uk' });
  });

  it('shows who has the tab, with the one action that changes it', () => {
    const sent = fakeWs();
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(statusEvent());
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
    });
    render(<BrowserView chatId="c1" layout="pane" />);
    expect(screen.getByTestId('browser-drive-chip').textContent).toBe('Agent driving');
    act(() =>
      useBrowserHandoffStore.getState().applyStatus(
        statusEvent({
          tabs: [{ tabId: 't1', url: 'https://www.gwr.com/', handedOff: false, driver: 'user' }],
        }),
      ),
    );
    expect(screen.getByTestId('browser-drive-chip').textContent).toBe('You’re driving');
    fireEvent.click(screen.getByTestId('browser-hand-back'));
    expect(sent.at(-1)).toEqual({
      type: 'patch.browser_view.drive',
      chatId: 'c1',
      tabId: 't1',
      driver: 'agent',
    });
  });

  it('draws the agent’s cursor where it last pointed, scaled to the picture', () => {
    fakeWs();
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(
        statusEvent({
          tabs: [
            {
              tabId: 't1',
              url: 'https://www.gwr.com/',
              handedOff: false,
              cursor: { x: 400, y: 100, at: Date.now() },
            },
          ],
        }),
      );
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
    });
    render(<BrowserView chatId="c1" layout="pane" />);
    expect(screen.getByTestId('browser-agent-cursor')).toBeTruthy();
  });

  it('falls back to a hand-off’s own input on a host that takes nothing else', () => {
    const sent = fakeWs();
    const old = { ...frame, inputVersion: undefined };
    act(() => {
      useBrowserHandoffStore.getState().applyFrame('c1', old);
      useBrowserHandoffStore.getState().applyState(waiting);
    });
    render(<BrowserView chatId="c1" layout="pane" />);
    const surface = placeSurface();
    fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 260, clientY: 145 });
    fireEvent.pointerUp(surface, { pointerId: 1, button: 0, clientX: 260, clientY: 145 });
    expect(sent.filter((e) => e.type === 'patch.browser_view.input')).toHaveLength(0);
    expect(sent).toContainEqual({
      type: 'patch.browser_handoff.input',
      chatId: 'c1',
      handoffId: 'h1',
      input: { kind: 'pointer', action: 'click', x: 500, y: 250 },
    });
    expect(screen.queryByTestId('browser-take-over')).toBeNull();
  });

  it('on a phone, offers the page’s sign-in form as its own fields', () => {
    const sent = fakeWs();
    act(() => {
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
    render(<BrowserView chatId="c1" layout="screen" />);
    fireEvent.change(screen.getByTestId('browser-signin-email'), {
      target: { value: 'tom@example.com' },
    });
    fireEvent.change(screen.getByTestId('browser-signin-password'), {
      target: { value: 'hunter2' },
    });
    fireEvent.click(screen.getByTestId('browser-signin-submit'));
    expect(inputs(sent).at(-1)).toEqual({
      kind: 'fill',
      formId: 'f1',
      values: [
        { field: 'p0', value: 'tom@example.com' },
        { field: 'p1', value: 'hunter2' },
      ],
      submit: true,
    });
  });
});

describe('browser view helpers', () => {
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

  it('sends named keys and chords as keys, and leaves plain characters to the text input', () => {
    const e = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(keyForEvent({ ...e, key: 'a' })).toBeNull();
    expect(keyForEvent({ ...e, key: 'Backspace' })).toBe('Backspace');
    expect(keyForEvent({ ...e, key: 'Tab', shiftKey: true })).toBe('Shift+Tab');
    expect(keyForEvent({ ...e, key: 'a', ctrlKey: true })).toBe('Control+a');
    expect(keyForEvent({ ...e, key: 'v', ctrlKey: true })).toBeNull();
  });

  it('names sites, times and who has the tab', () => {
    expect(siteOf('https://www.bbc.co.uk/news?x=1')).toBe('bbc.co.uk');
    expect(siteOf('about:blank')).toBe('');
    expect(formatElapsed(42_000)).toBe('0:42');
    expect(formatElapsed(725_000)).toBe('12:05');
    expect(formatElapsed(3_753_000)).toBe('1:02:33');
    const tabs = [{ tabId: 't1', driver: 'user' as const }];
    expect(driveState(undefined, { tabs }, 't1')).toBe('user');
    expect(driveState(undefined, { tabs: [{ tabId: 't1' }] }, 't1')).toBe('agent');
    expect(driveState({ tabId: 't1' }, { tabs }, 't1')).toBe('needs');
    expect(canStopBrowser(undefined)).toBe(false);
    expect(canStopBrowser({ active: false, tabs })).toBe(true);
  });

  it('takes the summary from the newest browser tool run', () => {
    const entries = [
      { kind: 'tool_call', tool: 'mcp__patch__patch_browser_open', callId: 'a' },
      { kind: 'tool_call', tool: 'Bash', callId: 'b' },
    ];
    expect(browsingSummary(entries, undefined)).toBeNull();
    expect(
      browsingSummary(entries, {
        a: { callIds: ['a'], summary: 'Looking up trains…' },
        b: { callIds: ['b'], summary: 'Ran tests' },
      }),
    ).toBe('Looking up trains');
  });
});

describe('the large view in the Patch app', () => {
  beforeEach(() => {
    useBrowserHandoffStore.getState().reset();
    useChatStore.getState()._reset();
  });
  afterEach(() => {
    setActiveWs(null);
    delete (window as unknown as { patch?: unknown }).patch;
  });

  function fakeApp() {
    const calls: { show: unknown[]; hide: string[] } = { show: [], hide: [] };
    let input: ((e: { targetId: string }) => void) | null = null;
    (window as unknown as { patch: unknown }).patch = {
      agentBrowser: {
        owns: async (id: string) => id === 'T1',
        show: (id: string, rect: unknown) => calls.show.push([id, rect]),
        hide: (id: string) => calls.hide.push(id),
        onInput: (cb: (e: { targetId: string }) => void) => {
          input = cb;
          return () => (input = null);
        },
      },
    };
    return { calls, press: (id: string) => input?.({ targetId: id }) };
  }

  it('shows the tab itself over the stage, and the user working it takes it over unless the agent is acting', async () => {
    const sent = fakeWs();
    const app = fakeApp();
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(
        statusEvent({
          tabs: [{ tabId: 't1', url: 'https://www.gwr.com/', handedOff: false, appTarget: 'T1' }],
        }),
      );
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
    });
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 400,
      y: 48,
      width: 800,
      height: 700,
      left: 400,
      top: 48,
      right: 1200,
      bottom: 748,
    } as DOMRect);
    const { unmount } = render(<BrowserView chatId="c1" layout="pane" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(app.calls.show[0]).toEqual(['T1', { x: 400, y: 48, width: 800, height: 700 }]);
    rect.mockRestore();
    // No picture and no keyboard field of ours: the tab takes input itself.
    expect(screen.queryByTestId('browser-handoff-frame')).toBeNull();
    expect(screen.queryByTestId('browser-handoff-keys')).toBeNull();
    // The host is not asked to lay the page out for a view it is not drawing.
    const watches = sent.filter((e) => e.type === 'patch.browser_view.watch') as Array<
      Extract<WireEvent, { type: 'patch.browser_view.watch' }>
    >;
    expect(watches.every((w) => w.viewport === undefined)).toBe(true);

    // The agent acting: its own clicks are not the user's.
    act(() =>
      useBrowserHandoffStore.getState().applyStatus(
        statusEvent({
          active: true,
          tabs: [{ tabId: 't1', url: 'https://www.gwr.com/', handedOff: false, appTarget: 'T1' }],
        }),
      ),
    );
    act(() => app.press('T1'));
    expect(sent.filter((e) => e.type === 'patch.browser_view.drive')).toHaveLength(0);
    act(() =>
      useBrowserHandoffStore.getState().applyStatus(
        statusEvent({
          active: false,
          tabs: [{ tabId: 't1', url: 'https://www.gwr.com/', handedOff: false, appTarget: 'T1' }],
        }),
      ),
    );
    act(() => app.press('T1'));
    expect(sent.filter((e) => e.type === 'patch.browser_view.drive')).toEqual([
      { type: 'patch.browser_view.drive', chatId: 'c1', tabId: 't1', driver: 'user' },
    ]);

    unmount();
    expect(app.calls.hide).toContain('T1');
  });

  it('shows a picture of a tab that lives elsewhere', async () => {
    fakeWs();
    fakeApp();
    act(() => {
      useBrowserHandoffStore.getState().applyStatus(
        statusEvent({
          tabs: [
            { tabId: 't1', url: 'https://www.gwr.com/', handedOff: false, appTarget: 'OTHER' },
          ],
        }),
      );
      useBrowserHandoffStore.getState().applyFrame('c1', frame);
    });
    render(<BrowserView chatId="c1" layout="pane" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('browser-handoff-frame')).toBeTruthy();
  });
});
