import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ShortcutsPage } from '../routes/settings/ShortcutsPage.js';
import { useShortcuts, type ShortcutHandlers } from '../lib/shortcuts.js';
import { useUiStore } from '../stores/uiStore.js';
import { DEFAULT_DICTATE_CHORD } from '../lib/dictateChord.js';
import type { JSX } from 'react';
import { MemoryRouter } from 'react-router-dom';

function ShortcutsPageInRouter(): JSX.Element {
  return (
    <MemoryRouter>
      <ShortcutsPage />
    </MemoryRouter>
  );
}

function reset(): void {
  localStorage.clear();
  cleanup();
  useUiStore.setState({ shortcutOverrides: {}, dictateChord: DEFAULT_DICTATE_CHORD });
}
beforeEach(reset);

const press = (init: KeyboardEventInit): void => {
  fireEvent.keyDown(window, init);
};

describe('Settings → Shortcuts', () => {
  it('lists every action with its default chord', () => {
    render(<ShortcutsPageInRouter />);
    expect(screen.getByTestId('shortcut-chord-newChat')).toHaveTextContent(/N$/);
    expect(screen.getByTestId('shortcut-chord-dictate')).toBeInTheDocument();
    expect(screen.queryByTestId('shortcut-reset-newChat')).toBeNull();
  });

  it('rebinds an action, persists it and offers Reset', () => {
    render(<ShortcutsPageInRouter />);
    fireEvent.click(screen.getByTestId('shortcut-change-newChat'));
    expect(screen.getByTestId('shortcut-chord-newChat')).toHaveTextContent('Press keys…');
    press({ code: 'KeyY', key: 'y', ctrlKey: true, altKey: true });
    expect(screen.getByTestId('shortcut-chord-newChat')).toHaveTextContent('Ctrl+Alt+Y');
    expect(localStorage.getItem('patch.shortcuts.overrides')).toContain('KeyY');
    fireEvent.click(screen.getByTestId('shortcut-reset-newChat'));
    expect(screen.getByTestId('shortcut-chord-newChat')).toHaveTextContent('Ctrl+N');
    expect(localStorage.getItem('patch.shortcuts.overrides')).toBe('{}');
  });

  it('refuses a chord another action already uses', () => {
    render(<ShortcutsPageInRouter />);
    fireEvent.click(screen.getByTestId('shortcut-change-newChat'));
    press({ code: 'KeyK', key: 'k', ctrlKey: true });
    expect(screen.getByTestId('shortcut-clash')).toHaveTextContent('Already used by Focus search');
    expect(useUiStore.getState().shortcutOverrides.newChat).toBeUndefined();
  });

  it('Esc leaves the old chord', () => {
    render(<ShortcutsPageInRouter />);
    fireEvent.click(screen.getByTestId('shortcut-change-newChat'));
    press({ key: 'Escape', code: 'Escape' });
    expect(screen.getByTestId('shortcut-chord-newChat')).not.toHaveTextContent('Press keys…');
  });

  it('rebinds dictate on the same page', () => {
    render(<ShortcutsPageInRouter />);
    fireEvent.click(screen.getByTestId('shortcut-change-dictate'));
    press({ code: 'KeyM', key: 'm', ctrlKey: true, altKey: true });
    expect(useUiStore.getState().dictateChord).toEqual({ alt: true, shift: false, code: 'KeyM' });
  });
});

describe('a rebound chord drives the real shortcut hook', () => {
  function Harness({ handlers }: { handlers: ShortcutHandlers }): JSX.Element {
    useShortcuts(handlers, { isChatView: true });
    return <div />;
  }
  it('fires on the new chord and not the old one', () => {
    const onNewChat = vi.fn();
    const handlers = new Proxy({ onNewChat } as unknown as ShortcutHandlers, {
      get: (t, k) => (t as unknown as Record<string, unknown>)[k as string] ?? vi.fn(),
    });
    render(<Harness handlers={handlers} />);
    useUiStore.getState().setShortcutChord('newChat', {
      mod: true,
      ctrl: false,
      alt: true,
      shift: false,
      code: 'KeyY',
    });
    press({ key: 'n', ctrlKey: true });
    expect(onNewChat).not.toHaveBeenCalled();
    press({ key: 'y', code: 'KeyY', ctrlKey: true, altKey: true });
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });
});
