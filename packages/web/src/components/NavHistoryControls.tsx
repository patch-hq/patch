// NavHistoryControls — browser-style Back / Forward buttons (plus ⌘←/⌘→) for
// the in-app navigation history (todo: "Back/forward buttons to go through
// history"; later, "cmd left right should go back and forward in pages").
//
// react-router v6 exposes navigate(-1)/navigate(+1) but not whether a
// back/forward step is possible, so we mirror the router's own history: an
// ordered stack of location keys plus a cursor. PUSH truncates forward entries
// and appends, REPLACE overwrites the current entry, POP (Back/Forward here,
// a page's own Back control, the mouse button) moves the cursor to the entry
// with that key. Back/Forward themselves call navigate(-1)/navigate(1), so the
// router's history and this mirror cannot drift apart.

import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { shortcutTitle, useActionGlyphs } from '../lib/shortcuts.js';
import { matchesAction } from '../lib/keymap.js';
import { useUiStore } from '../stores/uiStore.js';

const ICON = 16;

// The stack is module-level, not per-instance: every route renders its own
// NavHistoryControls, so an instance-owned stack was thrown away on each route
// change and Back from Settings had nowhere to go.
// Anywhere ⌘←/⌘→ already mean something to the OS or the widget: text fields,
// rich-text editors and the terminal.
const TEXT_EDITING_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], .xterm';

const navHistory: { stack: string[]; index: number } = { stack: [], index: -1 };

/** Forget all visited locations (tests). */
export function resetNavHistory(): void {
  navHistory.stack = [];
  navHistory.index = -1;
}

export function NavHistoryControls(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const navType = useNavigationType();
  const key = location.key;
  const backGlyphs = useActionGlyphs('historyBack');
  const forwardGlyphs = useActionGlyphs('historyForward');

  // The stack and cursor live in `navHistory` (module-level, mutated in place);
  // a version counter forces the re-render that recomputes the disabled states.
  if (navHistory.stack.length === 0) {
    navHistory.stack = [key];
    navHistory.index = 0;
  }
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  useEffect(() => {
    // Every route mounts its own instance, so each runs this for a location
    // another instance has already recorded.
    if (navHistory.stack[navHistory.index] !== key) {
      if (navType === 'POP') {
        const at = navHistory.stack.indexOf(key);
        if (at >= 0) navHistory.index = at;
        else {
          // A history entry we never saw (reload, deep link): start afresh.
          navHistory.stack = [key];
          navHistory.index = 0;
        }
      } else if (navType === 'REPLACE') {
        navHistory.stack[navHistory.index] = key;
      } else {
        navHistory.stack = navHistory.stack.slice(0, navHistory.index + 1);
        navHistory.stack.push(key);
        navHistory.index = navHistory.stack.length - 1;
      }
    }
    rerender();
  }, [key, navType, rerender]);

  const canBack = navHistory.index > 0;
  const canForward = navHistory.index < navHistory.stack.length - 1;

  const goBack = useCallback(() => {
    // Reachable at index 0 via ⌘← even though the Back button is `disabled`
    // there — a chord has no disabled state to stop it firing.
    if (navHistory.index <= 0) return;
    navigate(-1);
  }, [navigate]);

  const goForward = useCallback(() => {
    // Reachable at the tip via ⌘→ even though the Forward button is
    // `disabled` there — a chord has no disabled state to stop it firing.
    if (navHistory.index >= navHistory.stack.length - 1) return;
    navigate(1);
  }, [navigate]);

  // ⌘←/⌘→ walk the same stack as the buttons (Todoist: "cmd left right should
  // go back and forward in pages"). Skipped while a text field has focus —
  // ⌘← and ⌘→ are the OS's own "start/end of line" chord there, and stealing
  // them would make it impossible to jump within a line of composer text.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const overrides = useUiStore.getState().shortcutOverrides;
      const back = matchesAction(e, 'historyBack', overrides);
      if (!back && !matchesAction(e, 'historyForward', overrides)) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(TEXT_EDITING_SELECTOR)) return;
      e.preventDefault();
      if (back) goBack();
      else goForward();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goBack, goForward]);

  return (
    <div className="nav-history" data-testid="nav-history">
      <button
        type="button"
        className="nav-history-btn"
        data-testid="nav-back"
        aria-label="Back"
        title={shortcutTitle('Back', backGlyphs)}
        disabled={!canBack}
        onClick={goBack}
      >
        <ChevronLeft size={ICON} aria-hidden />
      </button>
      <button
        type="button"
        className="nav-history-btn"
        data-testid="nav-forward"
        aria-label="Forward"
        title={shortcutTitle('Forward', forwardGlyphs)}
        disabled={!canForward}
        onClick={goForward}
      >
        <ChevronRight size={ICON} aria-hidden />
      </button>
    </div>
  );
}
