// REST for the shared settings (spec/01 § Endpoints, spec/03 § Settings).
//
// Every write is committed by the server and answered with the committed
// result; none asks a host, so none waits for one or fails because one is
// offline. Hosts learn of it from the snapshot that follows. The exceptions
// are an ACP agent's own sign-in, which runs on the host it is for, and adding
// or re-pointing an Amazon Bedrock account, whose host checks the AWS profile
// first (spec/10 § Signing in).

import type { AcpLogins, AcpLoginView } from './acp-logins.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccountStrategy,
  BACKEND_IDS,
  BedrockRegionPrefix,
  ProviderKeyId,
  providerForBackendId,
  resolveAcpAgents,
  SharedSettingsPatch,
} from '@patch/wire';
import {
  CHATGPT_VERIFICATION_URL,
  ChatGPTSignInError,
  chatgptLoginFromTokens,
  ClaudeSignInError,
  exchangeChatGPTDeviceCode,
  exchangeClaudeSignInCode,
  listenForClaudeSignIn,
  parseClaudeSignInCode,
  pollChatGPTDeviceCode,
  requestChatGPTDeviceCode,
  startClaudeSignIn,
  type ChatGPTDeviceCode,
} from '@patch/auth';
import type { Registry } from './registry.js';
import { requireAuth } from './folder-routes.js';
import { SettingsError, type BackendId, type SharedSettingsService } from './shared-settings.js';

export interface SettingsRoutesDeps {
  registry: Registry;
  shared: SharedSettingsService;
  /** Swaps the claude.ai code for a token; tests stand in for Anthropic. */
  exchangeClaudeCode?: typeof exchangeClaudeSignInCode;
  /** Listens for claude.ai's redirect on this machine; tests stand in for the browser. */
  listenForClaudeSignIn?: typeof listenForClaudeSignIn;
  /** The ChatGPT device-code calls; tests stand in for OpenAI. */
  chatgptDevice?: {
    request: typeof requestChatGPTDeviceCode;
    poll: typeof pollChatGPTDeviceCode;
    exchange: typeof exchangeChatGPTDeviceCode;
  };
  now?: () => number;
  /** ACP agents' own sign-ins on hosts (`acp-logins.ts`). */
  acpLogins?: AcpLogins;
}

/**
 * How long a started Claude sign-in waits for its code. Generous: a password
 * manager, 2FA or a break can take a long time, and when the wait ends the
 * loopback listener closes and the browser lands on a dead page.
 */
export const CLAUDE_SIGNIN_TTL_MS = 2 * 60 * 60_000;
/** How long a ChatGPT device code is good for (OpenAI's own limit). */
export const CHATGPT_SIGNIN_TTL_MS = 15 * 60_000;
/** Started sign-ins kept at once; the oldest goes first. */
const CLAUDE_SIGNIN_MAX = 20;

const Backend = z.enum(BACKEND_IDS);
/** A Claude on Amazon Bedrock account (spec/10 § Signing in): no secret, a host's AWS profile. */
const BedrockFields = {
  hostId: z.string().min(1),
  awsProfile: z.string().trim().min(1),
  awsRegion: z.string().trim().min(1),
  regionPrefix: BedrockRegionPrefix,
  monthlyCapUsd: z.number().positive().finite(),
};
const AddBody = z
  .object({
    token: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    bedrock: z
      .object({ label: z.string().trim().min(1), ...BedrockFields, auto: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();
const PatchBody = z
  .object({
    label: z.string().min(1).optional(),
    token: z.string().min(1).optional(),
    /** In the order or not (spec/10 § Choosing an account); any Claude account. */
    auto: z.boolean().optional(),
    // A Bedrock account's own fields; a new host or profile is checked again.
    hostId: BedrockFields.hostId.optional(),
    awsProfile: BedrockFields.awsProfile.optional(),
    awsRegion: BedrockFields.awsRegion.optional(),
    regionPrefix: BedrockFields.regionPrefix.optional(),
    monthlyCapUsd: BedrockFields.monthlyCapUsd.optional(),
  })
  .strict();
const OrderBody = z.object({ accountIds: z.array(z.string().min(1)).min(1) }).strict();
const StrategyBody = z.object({ strategy: AccountStrategy }).strict();
const AdoptBody = z.object({ hostId: z.string().min(1) }).strict();
const KeyBody = z.object({ value: z.string().min(1) }).strict();
const SignInStartBody = z
  .object({
    label: z.string().min(1).optional(),
    /** Sign an existing row in again rather than adding one. */
    accountId: z.string().min(1).optional(),
  })
  .strict();
const SignInCompleteBody = z
  .object({
    signInId: z.string().min(1),
    code: z.string().min(1),
    label: z.string().min(1).optional(),
    /** Sign an existing row in again rather than adding one. */
    accountId: z.string().min(1).optional(),
  })
  .strict();

export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRoutesDeps): void {
  const { shared } = deps;

  /** Auth, parse, run, answer with the committed state — or the refusal. */
  const handle =
    <B>(
      schema: z.ZodType<B> | undefined,
      run: (req: FastifyRequest, body: B) => Promise<void> | void,
    ) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      let body = undefined as B;
      if (schema) {
        const parsed = schema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
        }
        body = parsed.data;
      }
      try {
        await run(req, body);
      } catch (e) {
        if (e instanceof SettingsError) {
          return reply.code(e.status).send({ error: e.code, message: e.message });
        }
        throw e;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropping `type` from the broadcast event shape, not using it
      const { type: _type, ...state } = shared.changedEvent();
      return reply.code(200).send(state);
    };

  const backendOf = (req: FastifyRequest): BackendId => {
    const parsed = Backend.safeParse((req.params as { backendId?: string }).backendId);
    if (!parsed.success) {
      throw new SettingsError(
        404,
        'unknown_backend',
        `No backend ${(req.params as { backendId?: string }).backendId}`,
      );
    }
    return parsed.data;
  };
  const accountOf = (req: FastifyRequest): string =>
    (req.params as { accountId: string }).accountId;

  app.get(
    '/api/settings/shared',
    handle(undefined, () => undefined),
  );

  app.patch(
    '/api/settings/shared',
    handle(SharedSettingsPatch, (_req, body) => {
      shared.update(body);
    }),
  );

  app.get(
    '/api/accounts/:backendId',
    handle(undefined, (req) => void backendOf(req)),
  );

  app.post(
    '/api/accounts/:backendId',
    handle(AddBody, async (req, body) => {
      const backend = backendOf(req);
      if (backend === 'claude-code' && body.bedrock) {
        if (body.apiKey ?? body.token ?? body.label) {
          throw new SettingsError(
            400,
            'invalid_input',
            'A Bedrock account takes no token, API key or separate label',
          );
        }
        await shared.addBedrock(body.bedrock);
      } else if (backend === 'claude-code') {
        const credential = body.apiKey ?? body.token;
        if (!credential) {
          throw new SettingsError(400, 'invalid_input', 'A token or an API key is required');
        }
        await shared.addClaude(credential, body.label);
      } else {
        if (body.bedrock) {
          throw new SettingsError(400, 'invalid_input', 'Amazon Bedrock runs Claude accounts only');
        }
        if (!body.apiKey) {
          throw new SettingsError(
            400,
            'invalid_input',
            'An OpenAI API key is required; a ChatGPT sign-in runs on a host',
          );
        }
        await shared.addCodexApiKey(body.apiKey, body.label);
      }
    }),
  );

  // ---- Signing in to Claude from a surface (spec/10 § Signing in to Claude) ----
  // The surface opens `url`, the person signs in on claude.ai, and the code the
  // page shows comes back to `complete`. The PKCE verifier stays here.
  type SignInStatus =
    | { status: 'waiting' }
    | { status: 'done' }
    | { status: 'failed'; message: string };
  const signIns = new Map<
    string,
    {
      verifier: string;
      state: string;
      at: number;
      /** Set when claude.ai redirects back to this machine; the code is never pasted. */
      loopback?: { redirectUri: string; close: () => void; outcome: SignInStatus };
    }
  >();
  const now = deps.now ?? Date.now;
  const drop = (id: string): void => {
    signIns.get(id)?.loopback?.close();
    signIns.delete(id);
  };
  const sweep = (): void => {
    for (const [id, s] of signIns) if (now() - s.at > CLAUDE_SIGNIN_TTL_MS) drop(id);
    while (signIns.size >= CLAUDE_SIGNIN_MAX) drop(signIns.keys().next().value as string);
  };

  /** Spend the code on a token and store it exactly as a pasted token is stored. */
  const redeem = async (
    pending: { verifier: string; state: string; loopback?: { redirectUri: string } },
    code: string,
    who: { label?: string | undefined; accountId?: string | undefined },
  ): Promise<void> => {
    let token: string;
    try {
      ({ accessToken: token } = await (deps.exchangeClaudeCode ?? exchangeClaudeSignInCode)({
        code,
        verifier: pending.verifier,
        state: pending.state,
        ...(pending.loopback ? { redirectUri: pending.loopback.redirectUri } : {}),
      }));
    } catch (e) {
      if (e instanceof ClaudeSignInError) {
        throw new SettingsError(
          e.kind === 'rejected' ? 400 : 502,
          e.kind === 'rejected' ? 'credential_rejected' : 'credential_unreachable',
          e.message,
        );
      }
      throw e;
    }
    if (who.accountId) await shared.connectClaude(who.accountId, token);
    else await shared.addClaude(token, who.label);
  };

  /**
   * The browser is on this machine only when the request came over loopback
   * and was not relayed by a proxy or tunnel; otherwise `localhost` in the
   * person's browser would not be this server.
   */
  const browserIsHere = (req: FastifyRequest): boolean => {
    const addr = req.socket.remoteAddress ?? '';
    const loop = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    const h = req.headers;
    return loop && !h['x-forwarded-for'] && !h['forwarded'] && !h['x-forwarded-host'];
  };

  app.post('/api/accounts/claude-code/signin', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const parsedBody = SignInStartBody.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsedBody.error.message });
    }
    const who = parsedBody.data;
    sweep();
    const signInId = randomUUID();
    if (!browserIsHere(req)) {
      const started = startClaudeSignIn();
      signIns.set(signInId, { verifier: started.verifier, state: started.state, at: now() });
      return reply.code(200).send({ signInId, url: started.url, mode: 'code' });
    }
    // Same machine: claude.ai sends the code straight back to a listener here,
    // so there is nothing to paste and a login detour cannot lose it.
    const state = randomBytes(32).toString('base64url');
    const listener = await (deps.listenForClaudeSignIn ?? listenForClaudeSignIn)(state);
    const started = startClaudeSignIn(randomBytes, {
      loopbackRedirect: listener.redirectUri,
      state,
    });
    const loopback = {
      redirectUri: listener.redirectUri,
      close: listener.close,
      outcome: { status: 'waiting' } as SignInStatus,
    };
    signIns.set(signInId, { verifier: started.verifier, state, at: now(), loopback });
    void listener.result.then(async (r) => {
      if ('error' in r) {
        loopback.outcome = { status: 'failed', message: r.error };
        return;
      }
      try {
        await redeem({ verifier: started.verifier, state, loopback }, r.code, who);
        loopback.outcome = { status: 'done' };
      } catch (e) {
        loopback.outcome = { status: 'failed', message: (e as Error).message };
      }
    });
    return reply.code(200).send({ signInId, url: started.url, mode: 'loopback' });
  });

  app.get('/api/accounts/claude-code/signin/:signInId', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const id = (req.params as { signInId: string }).signInId;
    const pending = signIns.get(id);
    if (!pending?.loopback || now() - pending.at > CLAUDE_SIGNIN_TTL_MS) {
      drop(id);
      return reply
        .code(410)
        .send({ error: 'signin_expired', message: 'That sign-in has expired. Start it again.' });
    }
    const out = pending.loopback.outcome;
    if (out.status !== 'waiting') signIns.delete(id);
    return reply.code(200).send(out);
  });

  app.delete('/api/accounts/claude-code/signin/:signInId', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    drop((req.params as { signInId: string }).signInId);
    return reply.code(204).send();
  });

  app.post(
    '/api/accounts/claude-code/signin/complete',
    handle(SignInCompleteBody, async (_req, body) => {
      const pending = signIns.get(body.signInId);
      if (!pending || pending.loopback || now() - pending.at > CLAUDE_SIGNIN_TTL_MS) {
        drop(body.signInId);
        throw new SettingsError(410, 'signin_expired', 'That sign-in has expired. Start it again.');
      }
      const parsed = parseClaudeSignInCode(body.code, pending.state);
      if ('error' in parsed) throw new SettingsError(400, 'invalid_input', parsed.error);
      try {
        await redeem(pending, parsed.code, body);
      } catch (e) {
        // A refused code is spent; an unreachable Claude may answer a retry.
        if (e instanceof SettingsError && e.code === 'credential_rejected') drop(body.signInId);
        throw e;
      }
      drop(body.signInId);
    }),
  );

  // ---- Signing in to ChatGPT from a surface (spec/10 § Signing in) ----
  // The server holds the device code and does the polling on behalf of whoever
  // asks; the surface shows `userCode` and `url` and reads `status`.
  type ChatGPTSignIn = {
    code: ChatGPTDeviceCode;
    at: number;
    lastPoll: number;
    accountId?: string;
    label?: string;
    settled?: { status: 'complete' } | { status: 'failed'; error: string; code: string };
  };
  const chatgpt = new Map<string, ChatGPTSignIn>();
  const device = deps.chatgptDevice ?? {
    request: requestChatGPTDeviceCode,
    poll: pollChatGPTDeviceCode,
    exchange: exchangeChatGPTDeviceCode,
  };
  const authed = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    try {
      await requireAuth(req, deps.registry);
      return true;
    } catch (e) {
      void reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
      return false;
    }
  };
  /** A finished sign-in carries the committed state, so a surface needs no second read. */
  const settledBody = (settled: NonNullable<ChatGPTSignIn['settled']>) => {
    if (settled.status !== 'complete') return settled;
    const { type: _type, ...state } = shared.changedEvent();
    return { status: 'complete' as const, state };
  };
  app.post('/api/accounts/codex/signin', async (req, reply) => {
    if (!(await authed(req, reply))) return reply;
    const body = SignInStartBody.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_input', message: body.error.message });
    }
    for (const [id, s] of chatgpt) if (now() - s.at > CHATGPT_SIGNIN_TTL_MS) chatgpt.delete(id);
    while (chatgpt.size >= CLAUDE_SIGNIN_MAX) chatgpt.delete(chatgpt.keys().next().value as string);
    try {
      const code = await device.request();
      const signInId = randomUUID();
      chatgpt.set(signInId, {
        code,
        at: now(),
        lastPoll: 0,
        ...(body.data.accountId ? { accountId: body.data.accountId } : {}),
        ...(body.data.label ? { label: body.data.label } : {}),
      });
      return reply.code(200).send({
        signInId,
        userCode: code.userCode,
        url: CHATGPT_VERIFICATION_URL,
        intervalSeconds: code.intervalSeconds,
        expiresAt: now() + CHATGPT_SIGNIN_TTL_MS,
      });
    } catch (e) {
      if (e instanceof ChatGPTSignInError) {
        return reply.code(e.kind === 'rejected' ? 400 : 502).send({
          error: e.kind === 'rejected' ? 'credential_rejected' : 'credential_unreachable',
          message: e.message,
        });
      }
      throw e;
    }
  });

  app.get('/api/accounts/codex/signin/:signInId', async (req, reply) => {
    if (!(await authed(req, reply))) return reply;
    const id = (req.params as { signInId: string }).signInId;
    const s = chatgpt.get(id);
    if (!s) {
      return reply
        .code(410)
        .send({ error: 'signin_expired', message: 'That sign-in has expired. Start it again.' });
    }
    if (s.settled) return reply.code(200).send(settledBody(s.settled));
    if (now() - s.at > CHATGPT_SIGNIN_TTL_MS) {
      chatgpt.delete(id);
      return reply
        .code(410)
        .send({ error: 'signin_expired', message: 'That sign-in has expired. Start it again.' });
    }
    // OpenAI asks for a gap between looks; a surface asking faster gets the last answer.
    if (s.lastPoll !== 0 && now() - s.lastPoll < s.code.intervalSeconds * 1000) {
      return reply.code(200).send({ status: 'pending' });
    }
    s.lastPoll = now();
    try {
      const polled = await device.poll(s.code);
      if (polled.status === 'pending') return reply.code(200).send({ status: 'pending' });
      const tokens = await device.exchange(polled);
      const login = chatgptLoginFromTokens(tokens);
      shared.signInChatGPT(login, {
        ...(s.accountId ? { accountId: s.accountId } : {}),
        ...(s.label ? { label: s.label } : {}),
      });
      s.settled = { status: 'complete' };
    } catch (e) {
      if (e instanceof ChatGPTSignInError && e.kind === 'unreachable') {
        // Nothing was spent: the person can still approve and the next look can succeed.
        return reply.code(200).send({ status: 'pending', warning: e.message });
      }
      const failure =
        e instanceof ChatGPTSignInError
          ? { code: 'credential_rejected', error: e.message }
          : e instanceof SettingsError
            ? { code: e.code, error: e.message }
            : null;
      if (!failure) throw e;
      s.settled = { status: 'failed', ...failure };
    }
    return reply.code(200).send(settledBody(s.settled));
  });

  app.delete('/api/accounts/codex/signin/:signInId', async (req, reply) => {
    if (!(await authed(req, reply))) return reply;
    chatgpt.delete((req.params as { signInId: string }).signInId);
    return reply.code(200).send({ ok: true });
  });

  app.patch(
    '/api/accounts/:backendId/:accountId',
    handle(PatchBody, async (req, body) => {
      const backend = backendOf(req);
      const edit = {
        auto: body.auto,
        hostId: body.hostId,
        awsProfile: body.awsProfile,
        awsRegion: body.awsRegion,
        regionPrefix: body.regionPrefix,
        monthlyCapUsd: body.monthlyCapUsd,
      };
      const editing = Object.values(edit).some((v) => v !== undefined);
      if (editing) {
        if (backend !== 'claude-code') {
          throw new SettingsError(
            400,
            'invalid_input',
            'Only a Claude account has auto and Amazon Bedrock settings',
          );
        }
        await shared.editClaude(accountOf(req), edit);
      }
      if (body.token !== undefined) {
        if (backend !== 'claude-code') {
          throw new SettingsError(
            400,
            'invalid_input',
            'Reconnect an OpenAI login by signing in again',
          );
        }
        await shared.connectClaude(accountOf(req), body.token);
      }
      if (body.label !== undefined) shared.relabel(backend, accountOf(req), body.label);
    }),
  );

  app.post(
    '/api/accounts/:backendId/:accountId/disconnect',
    handle(undefined, (req) => shared.disconnect(backendOf(req), accountOf(req))),
  );

  app.delete(
    '/api/accounts/:backendId/:accountId',
    handle(undefined, (req) => shared.remove(backendOf(req), accountOf(req))),
  );

  app.put(
    '/api/accounts/:backendId/order',
    handle(OrderBody, (req, body) => shared.order(backendOf(req), body.accountIds)),
  );

  app.put(
    '/api/accounts/:backendId/strategy',
    handle(StrategyBody, (req, body) => shared.setStrategy(backendOf(req), body.strategy)),
  );

  app.post(
    '/api/accounts/:backendId/adopt',
    handle(AdoptBody, async (req, body) => {
      const backend = backendOf(req);
      await shared.adoptInto(
        body.hostId,
        `${providerForBackendId(backend)}-login` as 'claude-login' | 'codex-login',
      );
    }),
  );

  const keyOf = (req: FastifyRequest) => {
    const parsed = ProviderKeyId.safeParse((req.params as { keyId?: string }).keyId);
    if (!parsed.success) {
      throw new SettingsError(
        404,
        'unknown_key',
        `No provider key ${(req.params as { keyId?: string }).keyId}`,
      );
    }
    return parsed.data;
  };

  app.put(
    '/api/providers/keys/:keyId',
    handle(KeyBody, async (req, body) => {
      const id = keyOf(req);
      shared.setProviderKey(id, body.value);
      // Saved either way; the answer says at once whether the provider accepts it.
      await shared.checkProviderKey(id);
    }),
  );

  app.delete(
    '/api/providers/keys/:keyId',
    handle(undefined, (req) => shared.revokeProviderKey(keyOf(req))),
  );

  // ---- ACP agents' accounts (spec/10 § Signing in) ----
  // An API key, validated by the server and stored encrypted; write-only.
  const AcpAddBody = z
    .object({ apiKey: z.string().min(1), label: z.string().min(1).optional() })
    .strict();
  const AcpKeyBody = z.object({ apiKey: z.string().min(1) }).strict();
  const acpOf = (req: FastifyRequest) => req.params as { agentId: string; accountId: string };
  app.post(
    '/api/accounts/acp/:agentId',
    handle(AcpAddBody, async (req, body) => {
      await shared.addAcpAccount(acpOf(req).agentId, body.apiKey, body.label);
    }),
  );
  // ---- An ACP agent's own sign-in on one host (spec/10 § Signing in) ----
  // Run by the host; the login stays in the agent's own files there. Every
  // surface polls the same answer: the address to open, a code, and whether
  // to paste the address the browser ended on.
  const AcpLoginStartBody = z
    .object({ hostId: z.string().min(1), methodId: z.string().min(1) })
    .strict();
  const AcpLoginCallbackBody = z.object({ url: z.string().min(1) }).strict();
  const loginRoute =
    <B>(
      schema: z.ZodType<B> | undefined,
      run: (p: { agentId: string; loginId: string }, body: B) => AcpLoginView,
    ) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAuth(req, deps.registry);
      } catch (e) {
        return reply
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message });
      }
      let body = undefined as B;
      if (schema) {
        const parsed = schema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
        }
        body = parsed.data;
      }
      try {
        if (!deps.acpLogins) {
          throw new SettingsError(
            503,
            'unavailable',
            'Agent sign-in is not available on this server',
          );
        }
        return reply.code(200).send(run(req.params as { agentId: string; loginId: string }, body));
      } catch (e) {
        if (e instanceof SettingsError) {
          return reply.code(e.status).send({ error: e.code, message: e.message });
        }
        throw e;
      }
    };
  app.post(
    '/api/accounts/acp/:agentId/login',
    loginRoute(AcpLoginStartBody, (p, body) => {
      if (!resolveAcpAgents(shared.current().acpAgents).some((a) => a.id === p.agentId)) {
        throw new SettingsError(404, 'unknown_agent', `No ACP agent ${p.agentId}`);
      }
      return deps.acpLogins!.start(body.hostId, p.agentId, body.methodId);
    }),
  );
  app.get(
    '/api/accounts/acp/:agentId/login/:loginId',
    loginRoute(undefined, (p) => deps.acpLogins!.get(p.loginId, p.agentId)),
  );
  app.post(
    '/api/accounts/acp/:agentId/login/:loginId/callback',
    loginRoute(AcpLoginCallbackBody, (p, body) =>
      deps.acpLogins!.callback(p.loginId, p.agentId, body.url),
    ),
  );
  app.delete(
    '/api/accounts/acp/:agentId/login/:loginId',
    loginRoute(undefined, (p) => deps.acpLogins!.cancel(p.loginId, p.agentId)),
  );

  app.put(
    '/api/accounts/acp/strategy',
    handle(StrategyBody, (_req, body) => shared.setAcpStrategy(body.strategy)),
  );
  app.put(
    '/api/accounts/acp/:agentId/order',
    handle(OrderBody, (req, body) => shared.orderAcp(acpOf(req).agentId, body.accountIds)),
  );
  app.put(
    '/api/accounts/acp/:agentId/:accountId/key',
    handle(AcpKeyBody, async (req, body) => {
      const { agentId, accountId } = acpOf(req);
      await shared.replaceAcpKey(agentId, accountId, body.apiKey);
    }),
  );
  app.delete(
    '/api/accounts/acp/:agentId/:accountId',
    handle(undefined, (req) => {
      const { agentId, accountId } = acpOf(req);
      shared.removeAcpAccount(agentId, accountId);
    }),
  );

  // A model endpoint's key (spec/02 § Provider adapters): write-only, like a provider key.
  const endpointOf = (req: FastifyRequest) => (req.params as { endpointId: string }).endpointId;
  app.put(
    '/api/providers/endpoints/:endpointId/key',
    handle(KeyBody, (req, body) => shared.setEndpointKey(endpointOf(req), body.value)),
  );
  app.delete(
    '/api/providers/endpoints/:endpointId/key',
    handle(undefined, (req) => shared.revokeEndpointKey(endpointOf(req))),
  );
}
