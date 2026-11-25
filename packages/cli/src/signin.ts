// Sign this terminal in by approval from an already-signed-in surface — the
// same flow a new browser uses (spec/10 § Surface linking). Needs no bearer, so
// it works when the CLI credential has expired.

export interface SignInRest {
  post<T>(path: string, body?: unknown): Promise<T>;
  get<T>(path: string): Promise<T>;
}

export interface SignInDeps {
  rest: SignInRest;
  label: string;
  /** Called once the request exists, so the caller can tell the person to approve. */
  onRequested: (r: { id: string; expiresAt: number }) => void;
  /** Called when a signed-in surface has approved; returns the six-digit code the person types. */
  readCode: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs?: number;
}

export async function signInByApproval(
  deps: SignInDeps,
): Promise<{ credential: string; surfaceId: string }> {
  const { rest } = deps;
  const req = await rest.post<{ id: string; secret: string; expiresAt: number }>(
    '/api/auth/signin/request',
    { clientType: 'surface-cli', label: deps.label },
  );
  deps.onRequested({ id: req.id, expiresAt: req.expiresAt });
  const base = `/api/auth/signin/${encodeURIComponent(req.id)}`;
  for (;;) {
    if (deps.now() >= req.expiresAt)
      throw new Error('sign-in request expired before it was approved');
    const { state } = await rest.get<{ state: string }>(
      `${base}/state?secret=${encodeURIComponent(req.secret)}`,
    );
    if (state === 'approved') break;
    if (state !== 'pending') throw new Error(`sign-in request ${state}`);
    await deps.sleep(deps.pollMs ?? 2000);
  }
  const code = (await deps.readCode()).trim();
  const out = await rest.post<{ credential: string; surfaceId: string }>(`${base}/redeem`, {
    secret: req.secret,
    code,
  });
  return out;
}
