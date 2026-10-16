// Auth + presence REST endpoints.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  completePairing,
  createPairingNonce,
  generateUserKeypair,
  mintSurfaceCredential,
  mintDaemonKey,
  InMemoryPairingNonceStore,
  verifySurfaceCredential,
  CredentialBindingError,
  CredentialVerificationError,
  CredentialMissingExpError,
  CredentialFutureIatError,
  PairingNonceExpiredError,
  PairingNonceUnknownError,
  type PairingNonceStore,
  type SurfaceKind,
} from '@patch/auth';
import { AccountConflictError, type Registry } from './registry.js';
import type { PresenceTracker } from './presence.js';
import {
  encodePairingUri,
  SharedSettingsPatch,
  type PairingRelay,
  type WireEvent,
} from '@patch/wire';
import { SignInRequestStore, TooManySignInRequestsError } from './signin-requests.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { SettingsError, type SharedSettingsService } from './shared-settings.js';

/** Validate that `s` decodes from base64url to exactly 32 bytes (Ed25519 pub key). */
function isValidEd25519PublicKey(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0 || s.length > 100) return false;
  // base64url alphabet: A-Z a-z 0-9 - _ (no padding)
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return false;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(s, 'base64url');
    // Node's Buffer.from(s, 'base64url') never throws regardless of input —
    // it decodes leniently. The catch is defensive-only and unreachable.
    /* v8 ignore next 3 */
  } catch {
    return false;
  }
  return bytes.length === 32;
}

/**
 * True iff `e` is a *known bad-input* error from the pairing/credential path
 * (tampered/expired/unknown nonce, mismatched binding, malformed credential).
 * Used to map only these to a 400 — every other error rethrows so misconfig or
 * internal bugs surface as a real 500 rather than being masked as "bad request"
 * (NO FALLBACKS — spec/principles.md).
 */
function isClientPairingError(e: unknown): boolean {
  return (
    e instanceof CredentialBindingError ||
    e instanceof CredentialVerificationError ||
    e instanceof CredentialMissingExpError ||
    e instanceof CredentialFutureIatError ||
    e instanceof PairingNonceExpiredError ||
    e instanceof PairingNonceUnknownError
  );
}

/**
 * Surface client types the pairing/enrolment routes accept, mapped to the
 * registry's `SurfaceKind`. The server is the credential authority and stamps
 * the kind into the minted credential — the client only declares what it IS.
 */
const CLIENT_TYPE_TO_SURFACE_KIND: Record<string, SurfaceKind> = {
  'surface-mobile': 'mobile',
  'surface-web': 'web',
  'surface-desktop': 'desktop',
  'surface-terminal': 'terminal',
  'surface-cli': 'terminal',
  'surface-voice-device': 'voice-device',
};

const ClientTypeSchema = z.enum([
  'surface-mobile',
  'surface-web',
  'surface-desktop',
  'surface-terminal',
  'surface-cli',
  'surface-voice-device',
]);

const AccountBootstrapBody = z
  .object({
    clientType: ClientTypeSchema,
    devicePublicKey: z.string().min(1),
    label: z.string().min(1).optional(),
  })
  .strict();

const PairCompleteBody = z
  .object({
    nonce: z.string().min(1),
    devicePublicKey: z.string().min(1),
    clientType: ClientTypeSchema,
    label: z.string().min(1).optional(),
  })
  .strict();

const SignInRequestBody = z
  .object({
    clientType: ClientTypeSchema,
    label: z.string().min(1).max(80).optional(),
  })
  .strict();

const SignInRedeemBody = z
  .object({
    secret: z.string().min(1),
    code: z.string().min(1).max(12),
  })
  .strict();

const RevokeBody = z
  .object({
    id: z.string().min(1),
  })
  .strict();

const HostRegisterCompleteBody = z
  .object({
    nonce: z.string().min(1),
    hostId: z.string().min(1),
    label: z.string().min(1),
    /**
     * The machine's own Ed25519 public key, base64url (spec/10 § Host
     * registration — "the host submits the nonce and its public key"). Minted
     * once on the machine and kept in `~/.patch/daemon-identity.json`, so the
     * registry records WHICH machine took this registration slot.
     */
    publicKey: z.string().min(1),
  })
  .strict();

/**
 * TTL for a daemon-registration nonce. Reuses the surface pairing-nonce TTL
 * (5 min) so the QR-scan window matches the surface linking flow.
 */
const HOST_REGISTER_NONCE_TTL_MS = 5 * 60 * 1000;
/** How long a slot is kept past its expiry, so a late attempt hears "expired" or "used", not "unknown". */
const HOST_REGISTER_SLOT_KEEP_MS = 60 * 60 * 1000;

/** Awaiter for a `register/await` long-poll, resolved when complete posts. */
interface HostRegisterAwaiter {
  resolve: (daemonKey: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * In-memory store for in-flight host registrations. Keyed by nonce. A slot is
 * ONLY ever created by the authenticated `daemon/pair/start` route (spec/10 §
 * Host registration — the window is opened from a linked surface). The
 * scanning host claims its own id at `register/complete`; the store relays
 * the minted `daemonKey` from `complete` to the long-polling `await`.
 */
interface HostRegisterEntry {
  /**
   * The hostId bound to this nonce. `null` until the scanning host claims
   * its own id at `register/complete`.
   */
  hostId: string | null;
  expiresAt: number;
  daemonKey?: string;
  awaiters: HostRegisterAwaiter[];
}

class HostRegisterStore {
  private readonly entries = new Map<string, HostRegisterEntry>();

  /**
   * Reserve a surface-initiated registration slot with no hostId yet — the
   * scanning host supplies its id at `register/complete`. This is the ONLY
   * way to open a registration window, and it is reachable only behind
   * `requireAuth` on `daemon/pair/start` (H1: an unauthenticated caller can no
   * longer self-issue a registration nonce).
   */
  putPending(nonce: string, expiresAt: number, nowMs: number): void {
    this.sweep(nowMs);
    this.entries.set(nonce, { hostId: null, expiresAt, awaiters: [] });
  }

  get(nonce: string, nowMs: number): HostRegisterEntry | undefined {
    this.sweep(nowMs);
    return this.entries.get(nonce);
  }

  /** Forget slots that expired over an hour ago. */
  private sweep(nowMs: number): void {
    for (const [nonce, entry] of this.entries) {
      if (entry.expiresAt + HOST_REGISTER_SLOT_KEEP_MS <= nowMs) this.entries.delete(nonce);
    }
  }

  /**
   * Atomically return-and-remove the slot for `nonce` in ONE synchronous step
   * (M3 TOCTOU: closes the double-spend window before the async mint at
   * `register/complete`). Returns the slot if present (and removes it); the
   * caller must `restore` it if the subsequent mint fails so a transient mint
   * error doesn't burn a legitimate registration window.
   */
  take(nonce: string): HostRegisterEntry | undefined {
    const entry = this.entries.get(nonce);
    // The route's only call site always `get()`s (peek) the same nonce
    // immediately before `take()`-ing it, synchronously with no intervening
    // await — so this can't observe an entry vanishing in between.
    /* v8 ignore next */
    if (entry === undefined) return undefined;
    this.entries.delete(nonce);
    return entry;
  }

  /** Re-insert a previously taken slot (failed mint — DoS resistance). */
  restore(nonce: string, entry: HostRegisterEntry): void {
    this.entries.set(nonce, entry);
  }

  /** Stash the relayed credential, collectable for one TTL from now, and wake any waiters. */
  complete(nonce: string, entry: HostRegisterEntry, daemonKey: string, nowMs: number): void {
    entry.daemonKey = daemonKey;
    entry.expiresAt = nowMs + HOST_REGISTER_NONCE_TTL_MS;
    // The taken slot was removed by `take`; re-insert it so the long-polling
    // `await` (and any already-parked awaiters) can pick up the credential.
    this.entries.set(nonce, entry);
    for (const a of entry.awaiters.splice(0, entry.awaiters.length)) {
      clearTimeout(a.timer);
      a.resolve(daemonKey);
    }
  }

  addAwaiter(nonce: string, awaiter: HostRegisterAwaiter): void {
    this.entries.get(nonce)?.awaiters.push(awaiter);
  }
}

export interface AuthRoutesDeps {
  logger: Logger;
  registry: Registry;
  presence: PresenceTracker;
  /**
   * spec/10 ## Revocation — used to terminate a revoked surface's live WS.
   * Optional only so unit tests can exercise the registry side in isolation;
   * production always wires the real hub.
   */
  terminateSurface?: (surfaceId: string) => boolean;
  /**
   * spec/10 ## Revocation — sever the live host WS when the host is
   * revoked. Production wires `InboundHostLink.terminateHostSocket`.
   */
  terminateHost?: (hostId: string) => boolean;
  /**
   * The voice-session HMAC secret every host signs with (spec/13). Handed to
   * a new machine along with its `daemonKey` when it collects the credential,
   * so adding a host takes a pairing code and nothing else — the installer
   * used to demand this secret on its command line, where nobody could see it.
   */
  internalToken?: string;
  /**
   * This server's reachability through a relay (`relay-service.ts`), when it has
   * one. With no public URL, a pairing code names the relay instead.
   */
  relay?: { info(): PairingRelay };
  /**
   * Tell every signed-in surface about a sign-in request (and its answer).
   * Production wires `WsHub.sendToAll`; without it requests are still stored,
   * but nothing shows the prompt.
   */
  broadcast?: (event: WireEvent) => number;
  /**
   * Wake the phone for a sign-in request, which a surface that is not open
   * cannot otherwise hear. Production wires the notification router.
   */
  pushSignInRequest?: (req: { id: string; label: string }) => Promise<void>;
  /** Override clock — tests inject deterministic time. */
  nowMs?: () => number;
  /** Optional pre-existing nonce store (tests). */
  nonceStore?: PairingNonceStore;
  /**
   * Host link — read for the Settings "host status + last heartbeat"
   * section (`GET /api/settings`). Optional only so unit tests can exercise
   * the registry side in isolation; production always wires the real link.
   */
  hostLink?: { status(): 'online' | 'offline'; lastConnectedAt(): number | null };
  /**
   * The account-wide preferences store (spec/01 § Responsibilities — Account
   * settings). Read into `GET /api/settings` and written by `PATCH`. Optional
   * only so unit tests can exercise the registry side in isolation; production
   * always wires it.
   */
  accountSettings?: SharedSettingsService;
}

export interface AuthRoutesHandle {
  nonceStore: PairingNonceStore;
}

/**
 * Authenticate a REST request via the same EdDSA-JWT used on /ws.
 * Looks for `Authorization: Bearer <jwt>`.
 */
async function requireAuth(
  req: FastifyRequest,
  registry: Registry,
): Promise<{
  accountId: string;
  surfaceId: string;
  surfaceKind: SurfaceKind;
  label: string;
  issuedAt: number;
}> {
  const generic = (): Error & { statusCode?: number } => {
    const e = new Error('unauthenticated') as Error & { statusCode?: number };
    e.statusCode = 401;
    return e;
  };
  const account = registry.getAccount();
  if (!account) throw generic();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) throw generic();
  const jwt = authHeader.slice('Bearer '.length).trim();
  let claims;
  try {
    claims = await verifySurfaceCredential(jwt, { userPublicKey: account.userPublicKey });
  } catch {
    throw generic();
  }
  if (registry.isRevoked(claims.surface_id)) throw generic();
  return {
    accountId: account.accountId,
    surfaceId: claims.surface_id,
    surfaceKind: claims.surface_kind,
    label: claims.label,
    issuedAt: claims.iat,
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): AuthRoutesHandle {
  const nonceStore = deps.nonceStore ?? new InMemoryPairingNonceStore();
  const hostRegisterStore = new HostRegisterStore();
  const now = (): number => (deps.nowMs ? deps.nowMs() : Date.now());

  // ---- POST /api/auth/account ----
  // First-surface enrolment (spec/10 § User identity). The SERVER is the
  // credential authority: it generates the account Ed25519 keypair itself
  // (never taking a public key from the client) and MINTS the caller its first
  // surface credential with the account private key. The private key is
  // persisted server-side and NEVER returned.
  app.post(
    '/api/auth/account',
    { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = AccountBootstrapBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
      }
      if (!isValidEd25519PublicKey(parsed.data.devicePublicKey)) {
        return reply.code(400).send({ error: 'invalid devicePublicKey' });
      }
      const surfaceKind = CLIENT_TYPE_TO_SURFACE_KIND[parsed.data.clientType];
      // ClientTypeSchema's enum is exactly CLIENT_TYPE_TO_SURFACE_KIND's key
      // set, so a parsed clientType always maps — unreachable via the public
      // API; defensive-only against the two falling out of sync.
      /* v8 ignore next 3 */
      if (!surfaceKind) {
        return reply.code(400).send({ error: `unsupported clientType: ${parsed.data.clientType}` });
      }
      if (deps.registry.getAccount() !== null) {
        return reply.code(409).send({ error: 'account already bootstrapped' });
      }
      let account;
      try {
        account = deps.registry.bootstrapAccount({ keypair: generateUserKeypair(), nowMs: now() });
      } catch (e) {
        if (e instanceof AccountConflictError) {
          return reply.code(409).send({ error: 'account already bootstrapped' });
        }
        throw e;
      }
      const accountPrivateKey = deps.registry.getAccountPrivateKey();
      if (!accountPrivateKey) {
        // Just bootstrapped — the private key must be present. Absence is an
        // internal bug, not a client error (NO FALLBACK).
        throw new Error('bootstrapAccount succeeded but no account private key is available');
      }
      const surfaceId = ulid();
      const label = parsed.data.label ?? surfaceKind;
      const credential = await mintSurfaceCredential({
        userPrivateKey: accountPrivateKey,
        surfaceId,
        surfaceKind,
        label,
        now: Math.floor(now() / 1000),
      });
      deps.registry.upsertSurface({
        surfaceId,
        surfaceKind,
        label,
        issuedAt: Math.floor(now() / 1000),
      });
      deps.logger.info(
        { accountId: account.accountId, surfaceId, surfaceKind },
        'account bootstrapped + first surface enrolled',
      );
      return reply.code(200).send({ account, credential, surfaceId });
    },
  );

  // ---- POST /api/auth/pair/start ----
  // Open a pairing window (spec/10 § Surface linking). Authenticated with the
  // opener's own surface credential — ANY linked surface may link another. The
  // opener does NOT know the new surface's public key, so the nonce binds only
  // to itself + a 5-min expiry; the device key is bound at /pair/complete.
  app.post(
    '/api/auth/pair/start',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      try {
        await requireAuth(req, deps.registry);
      } catch (e) {
        return (
          reply
            // requireAuth's only throw site always sets statusCode=401.
            /* v8 ignore next */
            .code((e as Error & { statusCode?: number }).statusCode ?? 401)
            .send({ error: (e as Error).message })
        );
      }
      const created = createPairingNonce({ nowMs: now() });
      nonceStore.put({ nonce: created.nonce, expiresAt: created.expiresAt });
      deps.logger.info({ nonce: created.nonce.slice(0, 8) + '…' }, 'pairing nonce issued');
      // The whole `patch-pair://` code, when the server knows how a new device
      // should reach it: its public address, else its relay. A surface that
      // draws the QR uses this instead of working an address out for itself.
      const publicUrl = (
        process.env['PATCH_PUBLIC_URL'] ??
        process.env['PATCH_SERVER_URL'] ??
        ''
      ).replace(/\/+$/, '');
      const uri = publicUrl
        ? encodePairingUri({ nonce: created.nonce, server: publicUrl })
        : deps.relay
          ? encodePairingUri({ nonce: created.nonce, relay: deps.relay.info() })
          : undefined;
      return reply
        .code(200)
        .send({ nonce: created.nonce, expiresAt: created.expiresAt, ...(uri ? { uri } : {}) });
    },
  );

  // ---- POST /api/auth/pair/complete ----
  // The new surface submits { nonce, devicePublicKey, clientType }. The SERVER
  // mints its credential with the account private key, binding the nonce + the
  // device public key, then single-use consumes the nonce. NO bearer required —
  // the unlinked surface has no credential yet; the nonce is the capability.
  app.post(
    '/api/auth/pair/complete',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const account = deps.registry.getAccount();
      if (!account) {
        return reply.code(400).send({ error: 'no account bootstrapped' });
      }
      const parsed = PairCompleteBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
      }
      if (!isValidEd25519PublicKey(parsed.data.devicePublicKey)) {
        return reply.code(400).send({ error: 'invalid devicePublicKey' });
      }
      const surfaceKind = CLIENT_TYPE_TO_SURFACE_KIND[parsed.data.clientType];
      // ClientTypeSchema's enum is exactly CLIENT_TYPE_TO_SURFACE_KIND's key
      // set, so a parsed clientType always maps — unreachable via the public
      // API; defensive-only against the two falling out of sync.
      /* v8 ignore next 3 */
      if (!surfaceKind) {
        return reply.code(400).send({ error: `unsupported clientType: ${parsed.data.clientType}` });
      }
      const accountPrivateKey = deps.registry.getAccountPrivateKey();
      if (!accountPrivateKey) {
        throw new Error('account exists but no account private key is available');
      }
      const surfaceId = ulid();
      const label = parsed.data.label ?? surfaceKind;
      // Bad client input (expired/unknown nonce, malformed device key) → 400.
      // Anything else (I/O failure, internal bug) is NOT a bad request: rethrow
      // so it surfaces as a real 500 via the app error handler rather than being
      // mislabelled as client error (NO FALLBACKS — spec/principles.md).
      let result: { credential: string; surfaceId: string };
      try {
        result = await completePairing({
          nonce: parsed.data.nonce,
          devicePublicKey: parsed.data.devicePublicKey,
          surface: { kind: surfaceKind, label, surfaceId },
          accountPrivateKey,
          nonceStore,
          nowMs: now(),
        });
      } catch (e) {
        if (isClientPairingError(e)) {
          return reply.code(400).send({ error: (e as Error).message });
        }
        throw e;
      }
      deps.registry.upsertSurface({
        surfaceId: result.surfaceId,
        surfaceKind,
        label,
        issuedAt: Math.floor(now() / 1000),
      });
      deps.logger.info({ surfaceId: result.surfaceId, surfaceKind }, 'surface paired');
      return reply.code(200).send({
        credential: result.credential,
        accountId: account.accountId,
        surfaceId: result.surfaceId,
      });
    },
  );

  // ---- Sign-in by approval from another device (spec/10 § Surface linking) ----
  // The new device asks, a signed-in one allows and shows a six-digit code, the
  // person types it in, and the new device collects its credential.
  const signInStore = new SignInRequestStore();
  const SIGNIN_LOG_FIELDS = (id: string): { request: string } => ({
    request: id.slice(0, 6) + '…',
  });

  // POST /api/auth/signin/request — no bearer: the asking device has none.
  app.post(
    '/api/auth/signin/request',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!deps.registry.getAccount()) {
        return reply.code(400).send({ error: 'no account bootstrapped' });
      }
      const parsed = SignInRequestBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
      }
      const label = parsed.data.label ?? parsed.data.clientType.replace('surface-', '');
      let created;
      try {
        created = signInStore.create(label, now());
      } catch (e) {
        if (e instanceof TooManySignInRequestsError) {
          return reply.code(429).send({ error: e.message });
        }
        throw e;
      }
      deps.logger.info(SIGNIN_LOG_FIELDS(created.id), 'sign-in requested');
      deps.broadcast?.({
        type: 'signin.requested',
        id: created.id,
        label: created.label,
        expiresAt: created.expiresAt,
      });
      if (deps.pushSignInRequest) {
        deps.pushSignInRequest({ id: created.id, label: created.label }).catch((err: unknown) => {
          deps.logger.warn({ err: (err as Error).message }, 'sign-in request: push failed');
        });
      }
      return reply.code(200).send({
        id: created.id,
        secret: created.secret,
        expiresAt: created.expiresAt,
      });
    },
  );

  // GET /api/auth/signin/:id?secret= — the asking device polls for the answer.
  app.get(
    '/api/auth/signin/:id/state',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const secret = (req.query as { secret?: string }).secret ?? '';
      const state = signInStore.stateFor(id, secret, now());
      if (state === undefined) return reply.code(404).send({ error: 'unknown sign-in request' });
      return reply.code(200).send({ state });
    },
  );

  // POST /api/auth/signin/:id/redeem — the typed code for a credential.
  app.post(
    '/api/auth/signin/:id/redeem',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = SignInRedeemBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
      }
      const label = signInStore.get(id, now())?.label;
      const result = signInStore.redeem(id, parsed.data.secret, parsed.data.code, now());
      if (!result.ok) {
        if (result.reason === 'locked') {
          deps.broadcast?.({ type: 'signin.resolved', id });
        }
        const status =
          result.reason === 'unknown' ? 404 : result.reason === 'wrong_code' ? 403 : 409;
        return reply.code(status).send({ error: result.reason });
      }
      const account = deps.registry.getAccount();
      const accountPrivateKey = deps.registry.getAccountPrivateKey();
      if (!account || !accountPrivateKey) {
        throw new Error('sign-in redeemed but the account has no private key');
      }
      const surfaceId = ulid();
      const surfaceLabel = label ?? 'web';
      const credential = await mintSurfaceCredential({
        userPrivateKey: accountPrivateKey,
        surfaceId,
        surfaceKind: 'web',
        label: surfaceLabel,
        now: Math.floor(now() / 1000),
      });
      deps.registry.upsertSurface({
        surfaceId,
        surfaceKind: 'web',
        label: surfaceLabel,
        issuedAt: Math.floor(now() / 1000),
      });
      deps.broadcast?.({ type: 'signin.resolved', id });
      deps.logger.info({ surfaceId, ...SIGNIN_LOG_FIELDS(id) }, 'surface signed in by approval');
      return reply.code(200).send({ credential, accountId: account.accountId, surfaceId });
    },
  );

  // GET /api/auth/signin/pending — a signed-in surface asks what is waiting
  // (it may have connected after the live event, or come from a push).
  app.get('/api/auth/signin/pending', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply.code(401).send({ error: (e as Error).message });
    }
    return reply.code(200).send({
      requests: signInStore
        .pending(now())
        .map((r) => ({ id: r.id, label: r.label, expiresAt: r.expiresAt })),
    });
  });

  // POST /api/auth/signin/:id/approve — returns the code to type on the new device.
  app.post('/api/auth/signin/:id/approve', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply.code(401).send({ error: (e as Error).message });
    }
    const { id } = req.params as { id: string };
    const approved = signInStore.approve(id, now());
    if (!approved) return reply.code(404).send({ error: 'no such pending sign-in request' });
    deps.logger.info({ approvedBy: auth.surfaceId, ...SIGNIN_LOG_FIELDS(id) }, 'sign-in approved');
    deps.broadcast?.({ type: 'signin.resolved', id });
    return reply.code(200).send({ code: approved.code, label: approved.label });
  });

  // POST /api/auth/signin/:id/deny
  app.post('/api/auth/signin/:id/deny', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply.code(401).send({ error: (e as Error).message });
    }
    const { id } = req.params as { id: string };
    if (!signInStore.deny(id, now())) {
      return reply.code(404).send({ error: 'no such pending sign-in request' });
    }
    deps.logger.info({ deniedBy: auth.surfaceId, ...SIGNIN_LOG_FIELDS(id) }, 'sign-in denied');
    deps.broadcast?.({ type: 'signin.resolved', id });
    return reply.code(200).send({ ok: true });
  });

  // ---- POST /api/auth/revoke ----
  app.post('/api/auth/revoke', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // requireAuth's only throw site always sets statusCode=401.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    const parsed = RevokeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    }
    try {
      deps.registry.revoke(parsed.data.id);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
    // spec/10: invalidate the JWT (registry.revoke, above) AND terminate the
    // corresponding live WebSocket so the revoked client stops relaying
    // immediately rather than at its next reconnect. The id may be a surface
    // OR the host — revoking the host decommissions the install.
    const daemon = deps.registry.getDaemonKey(parsed.data.id);
    let terminated: boolean;
    if (daemon) {
      terminated = deps.terminateHost ? deps.terminateHost(daemon.hostId) : false;
    } else {
      terminated = deps.terminateSurface ? deps.terminateSurface(parsed.data.id) : false;
    }
    deps.logger.info(
      { revokedBy: auth.surfaceId, target: parsed.data.id, terminated },
      'surface/daemon revoked',
    );
    return reply.code(200).send({ ok: true });
  });

  // ---- GET /api/auth/me ----
  app.get('/api/auth/me', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // requireAuth's only throw site always sets statusCode=401.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    // Prefer the registry record (carries revoked/issuedAt), but fall back to
    // the surface identity from the AUTHENTICATED credential's own claims. The
    // caller IS this surface — it cannot have authenticated otherwise — so "this
    // surface" must never render blank just because the in-memory registry
    // hasn't reloaded a freshly-paired surface yet (NO FALLBACK to "—").
    const surface = deps.registry.getSurface(auth.surfaceId) ?? {
      surfaceId: auth.surfaceId,
      surfaceKind: auth.surfaceKind,
      label: auth.label,
      issuedAt: auth.issuedAt,
    };
    return reply.code(200).send({
      account: deps.registry.getAccount(),
      surface,
    });
  });

  // ---- GET /api/settings ----
  // Aggregates the read-only state the Settings page renders (spec/14 ##
  // Routes + design/web-lo-fi-settings.html): account, linked devices (with
  // live presence), push-token count, and host liveness + last-heartbeat.
  // NO FALLBACK — every field is real server-held state. Same surface-JWT
  // gate as /api/auth/me.
  app.get('/api/settings', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // requireAuth's only throw site always sets statusCode=401.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    const account = deps.registry.getAccount();
    // Linked devices: non-revoked surfaces joined with their live presence.
    const presenceById = new Map(deps.presence.snapshot().map((p) => [p.surfaceId, p] as const));
    const devices = deps.registry
      .listSurfaces()
      .filter((s) => s.revoked !== true)
      .map((s) => {
        const p = presenceById.get(s.surfaceId);
        return {
          surfaceId: s.surfaceId,
          surfaceKind: s.surfaceKind,
          label: s.label,
          issuedAt: s.issuedAt,
          status: p?.status ?? 'offline',
          lastHeartbeat: p?.lastHeartbeat ?? null,
          isCurrent: s.surfaceId === auth.surfaceId,
          // spec/09 § Presence heuristic — only a computer has input presence.
          ...(s.surfaceKind === 'web' || s.surfaceKind === 'desktop'
            ? { presence: deps.presence.computerOf(auth.accountId, s.surfaceId, s.surfaceKind) }
            : {}),
        };
      });
    // requireAuth already throws (401) when no account exists and there is
    // no await in between, so `account` is guaranteed non-null below — the
    // `: 0` / `: undefined` fallback arms are unreachable via the public API.
    /* v8 ignore next 2 */
    const pushTokens = account ? deps.registry.listPushTokens(account.accountId).length : 0;
    const hostRegistered = deps.registry.registeredHostIds().length > 0;
    const hostStatus = deps.hostLink ? deps.hostLink.status() : 'offline';
    const hostLastConnectedAt = deps.hostLink ? deps.hostLink.lastConnectedAt() : null;

    return reply.code(200).send({
      account,
      devices,
      push: { tokenCount: pushTokens },
      daemon: {
        registered: hostRegistered,
        status: hostStatus,
        lastConnectedAt: hostLastConnectedAt,
      },
      // Configurable project-launch folders (Settings → Project folders; offered
      // first by the new-chat folder picker — spec/04 § Folders).
      // `account` is guaranteed non-null here (see the pushTokens comment
      // above) — the `: []` fallback is unreachable via the public API.
      /* v8 ignore next */
      projectFolders: account ? deps.registry.getProjectFolders(account.accountId) : [],
      // Account-wide preferences (spec/14 § `/settings` details — Manager).
      preferences: deps.accountSettings?.current() ?? DEFAULT_SETTINGS,
      // The rest of the shared settings a surface may see (spec/01 § Settings):
      // secrets as source and last four only, and each host's applied version.
      ...(deps.accountSettings
        ? (({ type: _type, settings: _settings, ...shared }) => ({ shared }))(
            deps.accountSettings.changedEvent(),
          )
        : {}),
    });
  });

  // ---- PATCH /api/settings ----
  // Write the account-wide preferences. A partial body: only the named keys
  // change. Same surface-JWT gate as the GET. NO FALLBACK — a body that does
  // not parse is a 400 naming the problem, never a silently-ignored write.
  app.patch('/api/settings', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    if (!deps.accountSettings) {
      return reply.code(503).send({ error: 'account settings are not configured' });
    }
    const parsed = SharedSettingsPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_input', message: parsed.error.message });
    }
    // Committed here and pushed to every host as a snapshot (spec/01 § Settings).
    try {
      const preferences = deps.accountSettings.update(parsed.data);
      return reply.code(200).send({ preferences });
    } catch (e) {
      if (e instanceof SettingsError) {
        return reply.code(e.status).send({ error: e.code, message: e.message });
      }
      throw e;
    }
  });

  // ---- PUT /api/auth/folders ----
  // Replace the account's configured project-launch folder list. Auth-gated
  // (same surface-JWT as /api/settings). Body: { folders: string[] }.
  app.put('/api/auth/folders', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // requireAuth's only throw site always sets statusCode=401.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    const account = deps.registry.getAccount();
    // requireAuth already throws (401) when no account exists, so account is
    // guaranteed non-null here — unreachable via the public API.
    /* v8 ignore next */
    if (!account) return reply.code(400).send({ error: 'no account bootstrapped' });
    const body = req.body as { folders?: unknown } | null;
    if (
      !body ||
      !Array.isArray(body.folders) ||
      !body.folders.every((f) => typeof f === 'string')
    ) {
      return reply.code(400).send({ error: 'folders must be an array of strings' });
    }
    deps.registry.setProjectFolders(account.accountId, body.folders as string[], now());
    return reply.code(200).send({ folders: deps.registry.getProjectFolders(account.accountId) });
  });

  // ---- GET /api/presence ----
  app.get('/api/presence', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // requireAuth's only throw site always sets statusCode=401.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    return reply.code(200).send({ presence: deps.presence.snapshot() });
  });

  // ---- POST /api/auth/daemon/pair/start ----
  // spec/10 § Host registration + spec/14 `/settings` → "add-daemon QR". This
  // is the ONLY way to open a daemon-registration window: the already-linked web
  // surface mints a genuine, single-use, server-issued daemon-registration nonce
  // and renders it as a QR. The host scans it
  // (`patch host start --pair <code>`), so the registration window is always
  // opened from a trusted, authenticated linked surface (H1 — there is no
  // unauthenticated daemon-initiated register/start). Surface-JWT gated (same as
  // /api/settings). The host binds its own hostId at register/complete time,
  // so none is required here.
  app.post(
    '/api/auth/daemon/pair/start',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      try {
        await requireAuth(req, deps.registry);
      } catch (e) {
        return (
          reply
            // requireAuth's only throw site always sets statusCode=401.
            /* v8 ignore next */
            .code((e as Error & { statusCode?: number }).statusCode ?? 401)
            .send({ error: (e as Error).message })
        );
      }
      // requireAuth already throws (401) when no account exists, so by the
      // time we get here an account is guaranteed — unreachable via the
      // public API; defensive-only against a future requireAuth refactor.
      /* v8 ignore next 3 */
      if (deps.registry.getAccount() === null) {
        return reply.code(400).send({ error: 'no account bootstrapped' });
      }
      const created = createPairingNonce({ nowMs: now() });
      const expiresAt = now() + HOST_REGISTER_NONCE_TTL_MS;
      // hostId/label are claimed by the host when it scans + completes; the
      // surface-issued slot reserves the nonce until then.
      hostRegisterStore.putPending(created.nonce, expiresAt, now());
      deps.logger.info(
        { nonce: created.nonce.slice(0, 8) + '…' },
        'host add-daemon pairing nonce issued (surface-initiated)',
      );
      return reply.code(200).send({ nonce: created.nonce, expiresAt });
    },
  );

  // ---- POST /api/auth/daemon/register/complete ----
  // The host scanned the QR shown by a linked surface (the ONLY way a
  // registration window is opened — see `daemon/pair/start`, requireAuth-gated)
  // and POSTs its chosen { hostId, label } against that surface-issued nonce.
  // The SERVER is the credential authority: it MINTS the daemonKey with the
  // account private key, registers the host identity, and stashes the
  // credential for the host's long-poll.
  //
  // H1: there is NO self-issued registration nonce. A nonce only exists if an
  // authenticated linked surface created a pending slot at `daemon/pair/start`,
  // so an unknown/forged nonce (incl. anything an unauthenticated attacker could
  // mint themselves) is rejected here (400) and mints nothing.
  app.post(
    '/api/auth/daemon/register/complete',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const account = deps.registry.getAccount();
      if (!account) {
        return reply.code(400).send({ error: 'no account bootstrapped' });
      }
      const parsed = HostRegisterCompleteBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
      }
      // Any number of machines may register against one account (spec/01), so a
      // second machine is ADDED, not refused. Re-registering an id that is
      // already live IS refused: silently supplanting a running machine would
      // decommission it without anyone asking for that. Revoke it first.
      const existing = deps.registry.getDaemonKey(parsed.data.hostId);
      if (existing && existing.revoked !== true) {
        return reply
          .code(409)
          .send({ error: `a machine is already registered as ${parsed.data.hostId}` });
      }
      if (!isValidEd25519PublicKey(parsed.data.publicKey)) {
        return reply.code(400).send({ error: 'invalid publicKey' });
      }
      // Validate the surface-issued slot BEFORE atomically taking it (so a
      // bad/expired/forged nonce never disturbs a legitimate window).
      const peek = hostRegisterStore.get(parsed.data.nonce, now());
      if (!peek) {
        // Never issued, or issued so long ago the slot is gone. The installer
        // reports this verbatim, so it names a cause rather than a status code.
        return reply.code(400).send({ error: 'unknown code', code: 'nonce_unknown' });
      }
      // A slot that already relayed a daemonKey has been REDEEMED. It is kept
      // (the host long-polls it for the credential), so it must be refused
      // here explicitly — otherwise a second machine could redeem one code.
      // Checked before expiry: "already used" is the truer answer for a code
      // that was used and has since also aged out.
      if (peek.daemonKey !== undefined) {
        return reply.code(400).send({ error: 'code already used', code: 'nonce_used' });
      }
      if (peek.expiresAt <= now()) {
        return reply.code(400).send({ error: 'code expired', code: 'nonce_expired' });
      }
      // M3 TOCTOU: atomically reserve-and-remove the slot before the async
      // mint. Concurrent completes race here; exactly one gets the slot back.
      const entry = hostRegisterStore.take(parsed.data.nonce);
      // peek (above) found the slot synchronously with no intervening await,
      // so take() cannot come back empty here — unreachable via the public
      // API in Node's single-threaded execution model; defensive-only
      // against a future refactor that adds an await between peek and take.
      /* v8 ignore next 3 */
      if (!entry) {
        return reply.code(400).send({ error: 'unknown nonce' });
      }
      // The scanning host claims its own id against the surface-issued slot.
      entry.hostId = parsed.data.hostId;

      const accountPrivateKey = deps.registry.getAccountPrivateKey();
      if (!accountPrivateKey) {
        throw new Error('account exists but no account private key is available');
      }
      const iat = Math.floor(now() / 1000);
      let daemonKey: string;
      try {
        daemonKey = await mintDaemonKey({
          userPrivateKey: accountPrivateKey,
          hostId: parsed.data.hostId,
          label: parsed.data.label,
          now: iat,
        });
      } catch (e) {
        // A failed mint must not burn the legitimate registration window.
        hostRegisterStore.restore(parsed.data.nonce, entry);
        throw e;
      }

      deps.registry.setDaemonKey({
        hostId: parsed.data.hostId,
        // The MACHINE's key, submitted with the code. (The daemonKey JWT itself
        // is signed by, and verified against, the ACCOUNT key — spec/10.)
        publicKey: parsed.data.publicKey,
        issuedAt: iat,
      });
      hostRegisterStore.complete(parsed.data.nonce, entry, daemonKey, now());
      deps.logger.info({ hostId: parsed.data.hostId }, 'host registered');
      return reply.code(200).send({ ok: true });
    },
  );

  // ---- GET /api/auth/daemon/register/await?nonce=<nonce> ----
  // The host long-polls here after showing the QR; resolves with the
  // daemonKey once `complete` relays it. 404 unknown nonce, 408 on timeout.
  app.get('/api/auth/daemon/register/await', async (req, reply) => {
    const nonce = (req.query as { nonce?: unknown })?.nonce;
    if (typeof nonce !== 'string' || nonce.length === 0) {
      return reply.code(400).send({ error: 'nonce query param required' });
    }
    const entry = hostRegisterStore.get(nonce, now());
    if (!entry) {
      return reply.code(404).send({ error: 'unknown nonce' });
    }
    const withSecret = deps.internalToken ? { internalToken: deps.internalToken } : {};
    if (entry.daemonKey) {
      // The credential is collectable only within its window, not for the life of the process.
      if (entry.expiresAt <= now()) return reply.code(410).send({ error: 'code expired' });
      return reply.code(200).send({ daemonKey: entry.daemonKey, ...withSecret });
    }
    // Long-poll until complete relays the credential or the nonce TTL elapses.
    const waitMs = Math.max(0, entry.expiresAt - now());
    const daemonKey = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), waitMs);
      hostRegisterStore.addAwaiter(nonce, { resolve: (k) => resolve(k), timer });
    });
    if (daemonKey === null) {
      return reply.code(408).send({ error: 'registration timed out' });
    }
    return reply.code(200).send({ daemonKey, ...withSecret });
  });

  return { nonceStore };
}
