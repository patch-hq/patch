// REST for the shared settings (spec/01 § Endpoints, spec/03 § Settings).
//
// Every write is committed by the server and answered with the committed
// result; none asks a host, so none waits for one or fails because one is
// offline. Hosts learn of it from the snapshot that follows.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccountStrategy,
  BACKEND_IDS,
  ProviderKeyId,
  providerForBackendId,
  SharedSettingsPatch,
} from '@patch/wire';
import {
  ClaudeSignInError,
  exchangeClaudeSignInCode,
  parseClaudeSignInCode,
  startClaudeSignIn,
} from '@patch/auth';
import type { Registry } from './registry.js';
import { requireAuth } from './folder-routes.js';
import { SettingsError, type BackendId, type SharedSettingsService } from './shared-settings.js';

export interface SettingsRoutesDeps {
  registry: Registry;
  shared: SharedSettingsService;
  /** Swaps the claude.ai code for a token; tests stand in for Anthropic. */
  exchangeClaudeCode?: typeof exchangeClaudeSignInCode;
  now?: () => number;
}

/** How long a started Claude sign-in waits for its code. */
export const CLAUDE_SIGNIN_TTL_MS = 15 * 60_000;
/** Started sign-ins kept at once; the oldest goes first. */
const CLAUDE_SIGNIN_MAX = 20;

const Backend = z.enum(BACKEND_IDS);
const AddBody = z
  .object({
    token: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
  })
  .strict();
const PatchBody = z
  .object({ label: z.string().min(1).optional(), token: z.string().min(1).optional() })
  .strict();
const OrderBody = z.object({ accountIds: z.array(z.string().min(1)).min(1) }).strict();
const StrategyBody = z.object({ strategy: AccountStrategy }).strict();
const AdoptBody = z.object({ hostId: z.string().min(1) }).strict();
const KeyBody = z.object({ value: z.string().min(1) }).strict();
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
      if (backend === 'claude-code') {
        if (!body.token) throw new SettingsError(400, 'invalid_input', 'A token is required');
        await shared.addClaude(body.token, body.label);
      } else {
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
  const signIns = new Map<string, { verifier: string; state: string; at: number }>();
  const now = deps.now ?? Date.now;
  const sweep = (): void => {
    for (const [id, s] of signIns) if (now() - s.at > CLAUDE_SIGNIN_TTL_MS) signIns.delete(id);
    while (signIns.size >= CLAUDE_SIGNIN_MAX) signIns.delete(signIns.keys().next().value as string);
  };

  app.post('/api/accounts/claude-code/signin', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    sweep();
    const started = startClaudeSignIn();
    const signInId = randomUUID();
    signIns.set(signInId, { verifier: started.verifier, state: started.state, at: now() });
    return reply.code(200).send({ signInId, url: started.url });
  });

  app.post(
    '/api/accounts/claude-code/signin/complete',
    handle(SignInCompleteBody, async (_req, body) => {
      const pending = signIns.get(body.signInId);
      if (!pending || now() - pending.at > CLAUDE_SIGNIN_TTL_MS) {
        signIns.delete(body.signInId);
        throw new SettingsError(410, 'signin_expired', 'That sign-in has expired. Start it again.');
      }
      const parsed = parseClaudeSignInCode(body.code, pending.state);
      if ('error' in parsed) throw new SettingsError(400, 'invalid_input', parsed.error);
      let token: string;
      try {
        ({ accessToken: token } = await (deps.exchangeClaudeCode ?? exchangeClaudeSignInCode)({
          code: parsed.code,
          verifier: pending.verifier,
          state: pending.state,
        }));
      } catch (e) {
        if (e instanceof ClaudeSignInError) {
          // A refused code is spent; an unreachable Claude may answer a retry.
          if (e.kind === 'rejected') signIns.delete(body.signInId);
          throw new SettingsError(
            e.kind === 'rejected' ? 400 : 502,
            e.kind === 'rejected' ? 'credential_rejected' : 'credential_unreachable',
            e.message,
          );
        }
        throw e;
      }
      signIns.delete(body.signInId);
      if (body.accountId) await shared.connectClaude(body.accountId, token);
      else await shared.addClaude(token, body.label);
    }),
  );

  app.patch(
    '/api/accounts/:backendId/:accountId',
    handle(PatchBody, async (req, body) => {
      const backend = backendOf(req);
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
}
