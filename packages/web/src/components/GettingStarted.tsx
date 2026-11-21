// GettingStarted — the modal behind the sidebar's "Getting started" row and the
// first-run intro's link. Stays reachable after the intro is dismissed.

import type { JSX } from 'react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { GUIDE_ITEMS, GUIDE_PURPOSE, guideItemText, isGuideItemDone } from '../lib/guide.js';
import { useGuideProgress } from '../lib/useGuideProgress.js';
import { useUiStore } from '../stores/uiStore.js';
import { CloseIcon } from './icons.js';

export function GettingStarted(): JSX.Element | null {
  const open = useUiStore((s) => s.guideOpen);
  const setOpen = useUiStore((s) => s.setGuideOpen);
  const navigate = useNavigate();
  const progress = useGuideProgress();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <div className="cheat-sheet-overlay" data-testid="getting-started" role="dialog" aria-modal>
      <div className="cheat-sheet-backdrop" onClick={() => setOpen(false)} aria-hidden />
      <div className="cheat-sheet-card">
        <header className="cheat-sheet-head">
          <h2>Getting started</h2>
          <button
            type="button"
            className="cheat-sheet-close"
            aria-label="close"
            onClick={() => setOpen(false)}
          >
            <CloseIcon />
          </button>
        </header>
        <p className="guide-purpose">{GUIDE_PURPOSE}</p>
        <ul className="guide-list">
          {GUIDE_ITEMS.map((item) => {
            const done = isGuideItemDone(item.id, progress) && item.done !== undefined;
            const text = done && item.done ? item.done : guideItemText(item, progress);
            return (
              <li
                key={item.id}
                className="guide-item"
                data-testid={`guide-${item.id}`}
                data-done={done ? 'true' : undefined}
              >
                <div>
                  <div className="guide-title">
                    {done ? (
                      <span className="guide-tick" aria-hidden>
                        ✓{' '}
                      </span>
                    ) : null}
                    {text.title}
                  </div>
                  <div className="muted">{text.line}</div>
                </div>
                {item.to && !done ? (
                  <button
                    type="button"
                    className="guide-go"
                    data-testid={`guide-go-${item.id}`}
                    onClick={() => {
                      setOpen(false);
                      navigate(item.to as string);
                    }}
                  >
                    {item.id === 'connect' && progress.connected ? 'Add account' : item.action}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
