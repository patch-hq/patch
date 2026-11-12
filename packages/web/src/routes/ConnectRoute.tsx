// Connect an AI, from anywhere a chat can't run (spec/14 § Signing in). Every
// "Sign in" in the app — the not-signed-in banner, the new-chat notice, the
// composer, a turn that failed for want of a login — comes here, so the first
// thing on screen is the sign-in itself rather than a settings page with the
// button below usage meters. The cards are the welcome step's own.

import type { JSX } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ProviderCards, useConnectedCount } from './WelcomeRoute.js';

export function ConnectRoute(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const connected = useConnectedCount();
  // Back to wherever "Sign in" was pressed; a window opened straight here (the
  // router's first entry, keyed `default`) has nowhere to go back to, so it
  // goes to the app.
  const close = (): void => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/', { replace: true });
  };
  return (
    <div className="welcome" data-testid="connect">
      <div className="welcome-drag" />
      <main className="welcome-card">
        <section className="welcome-step">
          <h1>Connect an AI</h1>
          <ProviderCards />
          <div className="welcome-footer">
            {connected > 0 ? (
              <button
                type="button"
                className="welcome-primary"
                data-testid="connect-close"
                onClick={close}
              >
                Done
              </button>
            ) : (
              <button
                type="button"
                className="welcome-skip"
                data-testid="connect-close"
                onClick={close}
              >
                Not now
              </button>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
