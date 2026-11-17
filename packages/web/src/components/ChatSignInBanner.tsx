// ChatSignInBanner — the Sign in action of a chat that is Waiting for sign-in
// (spec/05 § Chat status). The server says the chat is waiting on a signed-out
// account; this is the way out, straight to the sign-in every provider card
// shares (spec/10 § Signing in), which finishes the owed turn the moment the
// account is signed in again.
//
// When no account of the provider is connected at all, the not-signed-in
// banner already says so and carries the same link, so this stays quiet.

import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import type { ChatStatusInfo } from '@patch/wire';
import { providerConnectedForModel, usePreferencesStore } from '../stores/preferencesStore.js';
import { CONNECT_PATH, providerNameForModel } from './ClaudeDisconnectedBanner.js';

export function ChatSignInBanner({
  status,
  model,
}: {
  status: ChatStatusInfo | null | undefined;
  model?: string | undefined;
}): JSX.Element | null {
  const connected = usePreferencesStore((s) => providerConnectedForModel(s.shared, model));
  if (status?.state !== 'waiting_for_sign_in' || connected === false) return null;
  return (
    <div className="claude-disconnected-banner" data-testid="chat-signin-banner" role="alert">
      <span className="dot" aria-hidden />
      <span>
        Signed out of {providerNameForModel(model)}. This chat is waiting.{' '}
        <Link to={CONNECT_PATH} data-testid="chat-signin-action">
          Sign in
        </Link>
      </span>
    </div>
  );
}
