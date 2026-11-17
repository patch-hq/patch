// Signing in to ChatGPT without a terminal (spec/10-auth.md § Signing in).
//
// The same device-code authorisation `codex login --device-auth` performs, run
// by the server so that no host has to be online and no secret reaches a
// surface. The server asks OpenAI for a code, a surface shows the code and an
// address, the person approves on any device, and the server collects the
// tokens and writes them as the `auth.json` Codex reads.

export const CHATGPT_ISSUER = 'https://auth.openai.com';
/** Codex's own public OAuth client. */
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** Where the person enters the code. */
export const CHATGPT_VERIFICATION_URL = `${CHATGPT_ISSUER}/codex/device`;

export class ChatGPTSignInError extends Error {
  constructor(
    readonly kind: 'rejected' | 'unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'ChatGPTSignInError';
  }
}

export interface ChatGPTDeviceCode {
  deviceAuthId: string;
  userCode: string;
  /** Seconds OpenAI asks between polls. */
  intervalSeconds: number;
}

export interface ChatGPTFetchOptions {
  fetchImpl?: typeof fetch;
  issuer?: string;
}

async function post(
  url: string,
  init: { body: string; contentType: string },
  fetchImpl: typeof fetch,
): Promise<{ status: number; text: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': init.contentType },
      body: init.body,
    });
  } catch (e) {
    throw new ChatGPTSignInError('unreachable', `Could not reach OpenAI: ${(e as Error).message}`);
  }
  return { status: res.status, text: await res.text().catch(() => '') };
}

const json = (text: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object') return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ChatGPTSignInError(
    'unreachable',
    'OpenAI answered the sign-in with something unreadable.',
  );
};

/** Ask OpenAI for a code the person approves on any device. */
export async function requestChatGPTDeviceCode(
  opts: ChatGPTFetchOptions = {},
): Promise<ChatGPTDeviceCode> {
  const { status, text } = await post(
    `${opts.issuer ?? CHATGPT_ISSUER}/api/accounts/deviceauth/usercode`,
    { body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }), contentType: 'application/json' },
    opts.fetchImpl ?? fetch,
  );
  if (status === 404) {
    throw new ChatGPTSignInError(
      'rejected',
      'OpenAI does not offer device sign-in for this client. Sign in with an API key instead.',
    );
  }
  if (status < 200 || status >= 300) {
    throw new ChatGPTSignInError(
      'unreachable',
      `OpenAI refused to start a sign-in (HTTP ${status}).`,
    );
  }
  const body = json(text);
  const userCode = body['user_code'] ?? body['usercode'];
  const deviceAuthId = body['device_auth_id'];
  if (typeof userCode !== 'string' || typeof deviceAuthId !== 'string') {
    throw new ChatGPTSignInError('unreachable', 'OpenAI sent no sign-in code.');
  }
  const interval = Number(body['interval']);
  return {
    deviceAuthId,
    userCode,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : 5,
  };
}

export type ChatGPTDevicePoll =
  | { status: 'pending' }
  | { status: 'approved'; authorizationCode: string; codeVerifier: string };

/** One look at whether the person has approved yet. */
export async function pollChatGPTDeviceCode(
  code: Pick<ChatGPTDeviceCode, 'deviceAuthId' | 'userCode'>,
  opts: ChatGPTFetchOptions = {},
): Promise<ChatGPTDevicePoll> {
  const { status, text } = await post(
    `${opts.issuer ?? CHATGPT_ISSUER}/api/accounts/deviceauth/token`,
    {
      body: JSON.stringify({ device_auth_id: code.deviceAuthId, user_code: code.userCode }),
      contentType: 'application/json',
    },
    opts.fetchImpl ?? fetch,
  );
  // 403 and 404 are how OpenAI says "not approved yet".
  if (status === 403 || status === 404) return { status: 'pending' };
  if (status < 200 || status >= 300) {
    throw new ChatGPTSignInError(
      'unreachable',
      `OpenAI could not check the sign-in (HTTP ${status}).`,
    );
  }
  const body = json(text);
  const authorizationCode = body['authorization_code'];
  const codeVerifier = body['code_verifier'];
  if (typeof authorizationCode !== 'string' || typeof codeVerifier !== 'string') {
    throw new ChatGPTSignInError('unreachable', 'OpenAI approved the sign-in but sent no code.');
  }
  return { status: 'approved', authorizationCode, codeVerifier };
}

export interface ChatGPTTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

/** Swap the approved code for tokens. */
export async function exchangeChatGPTDeviceCode(
  args: { authorizationCode: string; codeVerifier: string },
  opts: ChatGPTFetchOptions = {},
): Promise<ChatGPTTokens> {
  const issuer = opts.issuer ?? CHATGPT_ISSUER;
  const { status, text } = await post(
    `${issuer}/oauth/token`,
    {
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: args.authorizationCode,
        redirect_uri: `${issuer}/deviceauth/callback`,
        client_id: CHATGPT_CLIENT_ID,
        code_verifier: args.codeVerifier,
      }).toString(),
    },
    opts.fetchImpl ?? fetch,
  );
  if (status < 200 || status >= 300) {
    let reason = text;
    try {
      const b = JSON.parse(text) as { error_description?: string; error?: string };
      reason = b.error_description ?? b.error ?? text;
    } catch {
      // raw text is the reason
    }
    throw new ChatGPTSignInError(
      status === 400 || status === 401 || status === 403 ? 'rejected' : 'unreachable',
      `OpenAI refused the sign-in (HTTP ${status}${reason ? `: ${reason}` : ''}). Sign in again.`,
    );
  }
  const body = json(text);
  const idToken = body['id_token'];
  const accessToken = body['access_token'];
  const refreshToken = body['refresh_token'];
  if (
    typeof idToken !== 'string' ||
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string'
  ) {
    throw new ChatGPTSignInError('unreachable', 'OpenAI accepted the sign-in but sent no tokens.');
  }
  return { idToken, accessToken, refreshToken };
}

export interface ChatGPTLogin {
  /** Codex's own `auth.json` for this login. */
  authJson: string;
  /** The pool of credit behind the login (ChatGPT account id). */
  identity: string;
  email?: string;
}

function claimsOf(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Codex's `auth.json` for the tokens. A login whose ChatGPT account cannot be
 * read from the id token is refused: Codex would send no account header and
 * every turn would fail.
 */
export function chatgptLoginFromTokens(
  tokens: ChatGPTTokens,
  now: () => Date = () => new Date(),
): ChatGPTLogin {
  const claims = claimsOf(tokens.idToken);
  const auth = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const accountId = auth['chatgpt_account_id'];
  if (typeof accountId !== 'string' || accountId === '') {
    throw new ChatGPTSignInError('rejected', 'That login has no ChatGPT account. Sign in again.');
  }
  const email = typeof claims['email'] === 'string' ? claims['email'] : undefined;
  return {
    identity: accountId,
    ...(email ? { email } : {}),
    authJson: JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: tokens.idToken,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        account_id: accountId,
      },
      last_refresh: now().toISOString(),
    }),
  };
}
