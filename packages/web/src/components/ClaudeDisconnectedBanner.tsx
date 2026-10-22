// ClaudeDisconnectedBanner — shown when no Claude or ChatGPT account is
// connected for the chat's model.
//
// Without it, disconnecting Claude produced a silent app: Settings said "Not
// connected" if you went looking, but every other surface behaved normally. You
// could open a new chat, type, and send, and the turn just failed. The host
// emits `host.unauthenticated` for exactly this and the SPA dropped it on the
// floor.
//
// Provider accounts belong to the user, not to a machine (spec/10): signing in
// once covers every host. So this reads the server's shared accounts and never
// names a host.
//
// This is the case where text IS the feature — the state is otherwise invisible —
// so it says what's wrong and where to fix it, and nothing else.

import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { providerConnectedForModel, usePreferencesStore } from '../stores/preferencesStore.js';

export function ClaudeDisconnectedBanner({ model }: { model?: string }): JSX.Element | null {
  // The accounts are the server's, shared by every host, so no machine is named.
  // `null` = shared state not loaded yet; guessing would flash a warning on load.
  const connected = usePreferencesStore((s) => providerConnectedForModel(s.shared, model));
  if (connected !== false) return null;
  return (
    <div
      className="claude-disconnected-banner"
      data-testid="claude-disconnected-banner"
      role="alert"
    >
      <span className="dot" aria-hidden />
      <span>
        Not signed in to {model?.startsWith('openai/') ? 'Codex' : 'Claude'}. Chats can’t run.{' '}
        <Link to="/settings/usage">Sign in</Link>
      </span>
    </div>
  );
}
