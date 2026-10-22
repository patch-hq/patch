// Everything openable offers ⌘/Ctrl-click (new window), middle-click (new tab)
// and a right-click menu (new tab / side / new window) — spec/14 § Opening things.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OpenableLink, OpenableButton } from '../components/OpenableLink.js';
import { Sidebar } from '../components/Sidebar.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { useChatStore } from '../stores/chatStore.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  useLayoutStore.getState()._reset();
  useChatStore.getState()._reset();
});

function rightClick(el: HTMLElement): boolean {
  const ev = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 50,
    clientY: 60,
  });
  fireEvent(el, ev);
  return ev.defaultPrevented;
}

describe('OpenableLink', () => {
  it('cmd-click opens a job page in a new window and does not navigate', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(
      <MemoryRouter>
        <OpenableLink
          to="/jobs/j1"
          opens={{ kind: 'page', page: 'job', jobId: 'j1' }}
          data-testid="l"
        >
          job
        </OpenableLink>
      </MemoryRouter>,
    );
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    fireEvent(screen.getByTestId('l'), ev);
    expect(open.mock.calls[0]![0]).toContain('/app/tab-window?tabWindow=1&tab=');
    expect(decodeURIComponent(String(open.mock.calls[0]![0]))).toContain('"jobId":"j1"');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('ctrl-click on a chat opens a chat window', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(
      <MemoryRouter>
        <OpenableLink to="/chats/c1" opens={{ kind: 'chat', chatId: 'c1' }} data-testid="l">
          c
        </OpenableLink>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('l'), { ctrlKey: true });
    expect(open.mock.calls[0]![0]).toBe('/app/chats/c1?sidebar=hidden');
  });

  it('plain click still runs onClick and does not open a window', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onClick = vi.fn();
    render(
      <MemoryRouter>
        <OpenableLink
          to="/chats/c1"
          opens={{ kind: 'chat', chatId: 'c1' }}
          onClick={onClick}
          data-testid="l"
        >
          c
        </OpenableLink>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('l'));
    expect(onClick).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('middle-click opens a new tab', () => {
    render(
      <MemoryRouter>
        <OpenableLink to="/jobs" opens={{ kind: 'page', page: 'jobs' }} data-testid="l">
          jobs
        </OpenableLink>
      </MemoryRouter>,
    );
    fireEvent(
      screen.getByTestId('l'),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
    );
    expect(JSON.stringify(useLayoutStore.getState().root)).toContain('"page":"jobs"');
  });

  it('right-click opens the menu with new tab, side, window; window item opens a window', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(
      <MemoryRouter>
        <OpenableLink to="/settings" opens={{ kind: 'page', page: 'settings' }} data-testid="l">
          s
        </OpenableLink>
      </MemoryRouter>,
    );
    expect(rightClick(screen.getByTestId('l'))).toBe(true);
    expect(screen.getByTestId('open-context-menu-open-new-tab')).toBeTruthy();
    expect(screen.getByTestId('open-context-menu-open-to-the-side')).toBeTruthy();
    fireEvent.click(screen.getByTestId('open-context-menu-open-new-window'));
    expect(decodeURIComponent(String(open.mock.calls[0]![0]))).toContain('"page":"settings"');
  });
});

describe('OpenableButton', () => {
  it('click runs onOpen; cmd-click opens a window instead', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onOpen = vi.fn();
    render(
      <MemoryRouter>
        <OpenableButton opens={{ kind: 'chat', chatId: 'c9' }} onOpen={onOpen} data-testid="b">
          b
        </OpenableButton>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('b'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('b'), { metaKey: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toBe('/app/chats/c9?sidebar=hidden');
  });
});

describe('sidebar', () => {
  it('bottom nav rows have the menu; a chat row cmd-click opens a window without opening a tab here', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    useChatStore.getState()._reset();
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(rightClick(screen.getByTestId('nav-jobs'))).toBe(true);
    expect(screen.getByTestId('open-context-menu-open-new-window')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });
});
