// The reach switch (spec/09 § Reaching the user), shown in the Manager view's
// header beside its settings button (spec/14 § Manager view).
//
// It lives here rather than in Settings because it is changed for a couple of
// hours at a time — before a drive, before an afternoon of plastering — not
// configured once. It is account-wide, so every surface shows the same value.

import type { JSX } from 'react';
import { Bell, Volume2 } from 'lucide-react';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { failed } from '../lib/errorCopy.js';
import { ensureVoiceReady } from '../lib/voiceReadiness.js';

export function ReachSwitch(): JSX.Element {
  const reach = usePreferencesStore((s) => s.preferences.reach);
  const loaded = usePreferencesStore((s) => s.loaded);
  const update = usePreferencesStore((s) => s.update);
  const pushError = useUiStore((s) => s.pushError);
  const auto = reach === 'auto-notify';

  return (
    <button
      type="button"
      className={`reach-switch ${auto ? 'auto' : ''}`}
      data-testid="reach-switch"
      disabled={!loaded}
      aria-pressed={auto}
      /* No tooltip: the switch carries a visible text label, and spec/14 §
         Copy — no helper text reserves tooltips for icon-only controls. The
         old one was two sentences explaining the mode. */
      onClick={() => {
        // Spoken alerts are checked the moment they are asked for, not when the first one plays.
        if (!auto && !ensureVoiceReady({ feature: 'spoken-alert' })) return;
        void update({ reach: auto ? 'notify' : 'auto-notify' }).catch((e: Error) =>
          pushError(failed('settings'), undefined, e.message),
        );
      }}
    >
      {auto ? <Volume2 size={14} aria-hidden /> : <Bell size={14} aria-hidden />}
      {auto ? 'Auto-notify' : 'Notify'}
    </button>
  );
}
