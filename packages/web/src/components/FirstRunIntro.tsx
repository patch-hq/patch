// FirstRunIntro — the short welcome under "New chat" until it is dismissed.
// Remembered per account (shared setting `introDismissed`), so it follows the
// user across desktop, web and phone. A failed save is shown, not swallowed.

import type { JSX } from 'react';
import { useState } from 'react';
import { GUIDE_ITEMS, GUIDE_PURPOSE, isGuideItemDone } from '../lib/guide.js';
import { useGuideProgress } from '../lib/useGuideProgress.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useUiStore } from '../stores/uiStore.js';

const SHOWN = GUIDE_ITEMS.slice(0, 4);

export function FirstRunIntro(): JSX.Element | null {
  const loaded = usePreferencesStore((s) => s.loaded);
  const dismissed = usePreferencesStore((s) => s.preferences.introDismissed);
  const update = usePreferencesStore((s) => s.update);
  const setGuideOpen = useUiStore((s) => s.setGuideOpen);
  const progress = useGuideProgress();
  const [error, setError] = useState<string | null>(null);

  if (!loaded || dismissed) return null;
  return (
    <div className="first-run-intro" data-testid="first-run-intro">
      <p>{GUIDE_PURPOSE}</p>
      <ul>
        {SHOWN.map((i) => {
          const done = isGuideItemDone(i.id, progress) && i.done !== undefined;
          return (
            <li key={i.id} data-done={done ? 'true' : undefined}>
              {done && i.done ? `✓ ${i.done.title}` : i.title}
            </li>
          );
        })}
      </ul>
      <div className="first-run-actions">
        <button
          type="button"
          className="guide-go"
          data-testid="first-run-more"
          onClick={() => setGuideOpen(true)}
        >
          Getting started
        </button>
        <button
          type="button"
          className="guide-go"
          data-testid="first-run-dismiss"
          onClick={() => {
            setError(null);
            update({ introDismissed: true }).catch((e: unknown) =>
              setError(e instanceof Error ? e.message : String(e)),
            );
          }}
        >
          Dismiss
        </button>
      </div>
      {error ? (
        <p className="muted" role="alert" data-testid="first-run-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
