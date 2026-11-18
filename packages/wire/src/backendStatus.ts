// How a host's agent backend reads in Settings, on every surface.

/** The part of a shared account this reads. */
export interface SharedBackendRow {
  label: string;
  connected: boolean;
  email?: string | undefined;
}

/**
 * A backend's state in words. Whether it is signed in comes from the shared
 * accounts (spec/10-auth.md: accounts belong to the server, not to a host); the
 * machine's own report only speaks for a fault of the machine — the program
 * missing or broken — and its raw message goes behind Details.
 */
export function backendStatus(
  b: { state: string; label?: string | undefined; error?: string | undefined },
  rows: readonly SharedBackendRow[] | null,
): { text: string; needsSignIn: boolean; details?: string } {
  const signedIn = (rows ?? []).filter((r) => r.connected);
  const needsSignIn = rows !== null && signedIn.length === 0;
  let account: string;
  if (rows === null) account = 'Checking…';
  else if (signedIn.length === 0) account = 'Not signed in';
  else {
    const first = signedIn[0]!;
    const more = signedIn.length > 1 ? ` and ${signedIn.length - 1} more` : '';
    account = `Signed in · ${first.email ?? first.label}${more}`;
  }
  const details = b.error;
  if (b.state === 'absent') {
    // Patch installs a backend on demand once an account is connected for it
    // (useInstallPickedProviders), so absent is only a fault once one is.
    const text = needsSignIn
      ? `Installs when you connect ${b.label ?? 'it'}`
      : rows === null
        ? 'Checking…'
        : 'Installing…';
    return { text, needsSignIn, ...(details ? { details } : {}) };
  }
  if (b.state === 'failed') {
    return { text: 'Not working on this machine', needsSignIn, ...(details ? { details } : {}) };
  }
  if (b.state === 'installing') return { text: 'Installing…', needsSignIn };
  return { text: account, needsSignIn };
}

/** Is this host backend row an ACP agent (`acp:<agent id>`)? */
export function isAcpBackendRow(id: string): boolean {
  return id.startsWith('acp:');
}

/**
 * An ACP agent's row (spec/02 § Provider adapters). Its sign-in is its provider
 * key or the agent's own login on the host, which the host learns by asking
 * the agent, so the row says what the host reported. There is no sign-in
 * button: the key is added under Settings → Providers.
 */
export function acpBackendStatus(b: { state: string; error?: string | undefined }): {
  text: string;
  needsSignIn: boolean;
  details?: string;
} {
  if (b.state === 'logged-out')
    return { text: 'Not signed in · add its key under Settings → Providers', needsSignIn: false };
  if (b.state === 'failed')
    return {
      text: 'Not working on this machine',
      needsSignIn: false,
      ...(b.error ? { details: b.error } : {}),
    };
  if (b.state === 'absent') return { text: 'Not installed on this machine', needsSignIn: false };
  return { text: 'Ready', needsSignIn: false };
}
