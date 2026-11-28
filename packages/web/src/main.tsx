// Entry point. Mounts the SPA at /app/.
//
// Boot sequence:
//   1. honour DEV-only `?credential=<jwt>` query param.
//   2. if no credential present, render the PairingScreen — never silently
//      render a stub (NO FALLBACK per portfolio convention).
//   3. otherwise mount AppShell which opens the WS and hydrates from REST.

import { StrictMode, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from './AppShell.js';
import { PairingScreen } from './components/PairingScreen.js';
import {
  acceptHandedCredential,
  loadCredential,
  maybeAcceptDevCredential,
} from './lib/credential.js';
import { initWindowChrome } from './lib/windowChrome.js';
import { warmCallSounds } from './lib/callSound.js';
// NOTE: the self-hosted Monaco bootstrap (`lib/monaco-loader.js`) is
// deliberately NOT imported here. Statically importing it put the entire file
// editor — every monarch tokenizer plus the JSON/CSS/HTML/TS language services
// — in the ENTRY chunk, so every surface paid to download, parse and evaluate
// the editor before the first chat could paint, on every cold start, whether or
// not a file was ever opened (patch/todo.md — "Check app for performance").
// The EditorRail now pulls it in on the same dynamic path as the editor
// components it already `lazy()`-loads. See spec/14 § Startup cost.
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

import { forgetAccountOnDevice } from './lib/forgetAccountOnDevice.js';

function Boot(): JSX.Element {
  const initial = acceptHandedCredential() ?? maybeAcceptDevCredential() ?? loadCredential();
  const [credential, setCredential] = useState<string | null>(initial);
  // Why the credential went away, so the sign-in screen can say so rather than
  // appearing for no reason mid-session.
  const [rejectedReason, setRejectedReason] = useState<string | null>(null);

  // A credential the server REJECTS is worse than no credential: the gate below
  // only asks whether one is present, so a stale one rendered the whole app and
  // then failed every request, blinking the error bar with no way back to
  // sign-in. Drop it the moment the server says no.
  useEffect(() => {
    const onRejected = (e: Event): void => {
      const reason = (e as CustomEvent<string>).detail ?? 'unauthenticated';
      // The credential goes at once; the device's copies finish going in the background.
      void forgetAccountOnDevice();
      setCredential(null);
      setRejectedReason(reason);
    };
    window.addEventListener('patch:credential-rejected', onRejected);
    return () => window.removeEventListener('patch:credential-rejected', onRejected);
  }, []);

  if (!credential) {
    return (
      <PairingScreen
        {...(rejectedReason !== null ? { rejectedReason } : {})}
        onPaired={() => {
          setRejectedReason(null);
          setCredential(loadCredential());
        }}
      />
    );
  }
  return <AppShell />;
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

// spec/05 § Window chrome — before the first render, so a window whose title
// bar the shell hid paints its traffic-light inset immediately instead of
// jumping one frame in. No-op in a browser (no shell, so no chrome to offset).
initWindowChrome();

// Render the call sounds now, so the first press of a call button has one ready
// to start in its own task.
warmCallSounds().catch((e: unknown) =>
  console.error(`call sounds could not be warmed: ${String(e)}`),
);

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/app">
        <Boot />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
