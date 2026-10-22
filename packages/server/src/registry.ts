// File-backed account + surface + host registry.
//
// Persistence: a single JSON file at `<dataDir>/registry.json`, written
// atomically via temp + rename. fsync before rename so a crash mid-write
// doesn't leave partial data.
//
// Implements `RevocationStoreInterface` from @patch/auth so the server's
// auth gate can plug straight in.

import { parsePersisted } from './persisted-json.js';
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  fsyncSync,
  openSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { generateUserKeypair, type RevocationStoreInterface, type UserKeypair } from '@patch/auth';
import type { SurfaceKind } from '@patch/auth';

const SurfaceRecord = z
  .object({
    surfaceId: z.string().min(1),
    surfaceKind: z.enum(['terminal', 'web', 'desktop', 'mobile', 'voice-device']),
    label: z.string(),
    issuedAt: z.number().int(),
    revoked: z.boolean().optional(),
  })
  .strict();
export type SurfaceRecord = z.infer<typeof SurfaceRecord>;

/** How much earlier than a registration a key may be and still count as that registration's own. */
const SUPERSEDE_SLACK_SECONDS = 60;

const DaemonKeyRecord = z
  .object({
    hostId: z.string().min(1),
    publicKey: z.string().min(1),
    issuedAt: z.number().int(),
    revoked: z.boolean().optional(),
    /**
     * User-editable label for the machine (spec/03 § Host events —
     * `host.rename` is surface → SERVER, because the server owns the registry
     * entry rather than the machine). Absent until the machine is renamed, in
     * which case the machine's own reported `hostName` stands.
     */
    hostName: z.string().min(1).optional(),
  })
  .strict();
export type DaemonKeyRecord = z.infer<typeof DaemonKeyRecord>;

/**
 * The account record as persisted to the registry file. Includes the account
 * Ed25519 PRIVATE key — the server is the credential authority and mints every
 * surface/daemon credential with it. This key is server-internal: it is read
 * back only via `getAccountPrivateKey()` and is NEVER returned from
 * `getAccount()` (the public-safe view) nor serialised into any HTTP response.
 */
const StoredAccountRecord = z
  .object({
    accountId: z.string().min(1),
    userPublicKey: z.string().min(1),
    userPrivateKey: z.string().min(1),
    createdAt: z.number().int(),
  })
  .strict();
type StoredAccountRecord = z.infer<typeof StoredAccountRecord>;

/**
 * Public-safe account view. This is what `getAccount()` returns and what the
 * HTTP layer is allowed to serialise. It deliberately omits `userPrivateKey`.
 */
export interface AccountRecord {
  accountId: string;
  userPublicKey: string;
  createdAt: number;
}

/** Per-surface Expo push token (group 11). One token per surface. */
const PushTokenRecord = z
  .object({
    surfaceId: z.string().min(1),
    /**
     * Account that owns this surface (group 12 DX-4). Optional only for
     * back-compat with pre-fix registry files; new writes always set it.
     * `listPushTokens(accountId)` filters on this so multi-account
     * deployments (when they arrive) don't leak tokens across boundaries.
     */
    accountId: z.string().min(1).optional(),
    token: z.string().min(1),
    registeredAt: z.number().int(),
  })
  .strict();
export type PushTokenRecord = z.infer<typeof PushTokenRecord>;

// Configurable project-launch folders per account. The user manages this list
// in Settings; the new-chat folder picker offers it first (spec/04 § Folders).
const ProjectFoldersRecord = z
  .object({
    accountId: z.string().min(1),
    folders: z.array(z.string().min(1)),
    updatedAt: z.number().int(),
  })
  .strict();
export type ProjectFoldersRecord = z.infer<typeof ProjectFoldersRecord>;

const RegistryFile = z
  .object({
    version: z.literal(1),
    account: StoredAccountRecord.nullable(),
    surfaces: z.array(SurfaceRecord),
    /**
     * Every machine registered against this account (spec/01 § "a relay for any
     * number of machines"). One record per machine, in registration order.
     */
    daemonKeys: z.array(DaemonKeyRecord),
    /**
     * The machine running the Manager and Speakers (spec/06). The server
     * moves it when that machine is away; `null` until chosen, in which case
     * the first registered machine holds it so exactly one always does.
     */
    managerHostId: z.string().min(1).nullable(),
    /** Group 11: Expo push tokens per surface. */
    pushTokens: z.array(PushTokenRecord).optional(),
    /** Configurable project-launch folders per account (Settings → Project folders). */
    projectFolders: z.array(ProjectFoldersRecord).optional(),
  })
  .strict();
export type RegistryFile = z.infer<typeof RegistryFile>;

export class AccountConflictError extends Error {
  constructor() {
    super('account already bootstrapped');
    this.name = 'AccountConflictError';
  }
}

const EMPTY: RegistryFile = {
  version: 1,
  account: null,
  surfaces: [],
  daemonKeys: [],
  managerHostId: null,
};

export class Registry implements RevocationStoreInterface {
  private state: RegistryFile;
  private readonly path: string;
  /** Original `dataDir` arg from `load()` — used by other server subsystems
   * (e.g. the jobs store) that share the same data directory. */
  readonly dataDir: string;

  private constructor(path: string, dataDir: string, state: RegistryFile) {
    this.path = path;
    this.dataDir = dataDir;
    this.state = state;
  }

  static load(dataDir: string): Registry {
    const path = join(dataDir, 'registry.json');
    if (!existsSync(path)) {
      const r = new Registry(path, dataDir, structuredClone(EMPTY));
      r.flush();
      return r;
    }
    const raw = readFileSync(path, 'utf8');
    const rawObj: unknown = parsePersisted(raw);
    // Back-compat guard: accounts bootstrapped before the server became the
    // credential authority (spec/10-auth) persisted only the account PUBLIC
    // key. The current schema requires `userPrivateKey`, which the server
    // cannot derive from the public key — so a plain `RegistryFile.parse()`
    // just throws a raw ZodError and crash-loops. Detect that exact case and
    // fail with an actionable migration instruction instead.
    const acct = (rawObj as { account?: Record<string, unknown> } | null)?.account;
    if (
      acct &&
      typeof acct === 'object' &&
      typeof acct.userPublicKey === 'string' &&
      typeof acct.userPrivateKey !== 'string'
    ) {
      throw new Error(
        `registry.json at ${path} has a legacy account with no userPrivateKey ` +
          `(bootstrapped before the server became the credential authority). ` +
          `The server signs surface credentials with the account private key and ` +
          `cannot derive it from the public key. Migrate with:\n` +
          `  pnpm --filter @patch/server migrate:account-key --data-dir <dataDir> --key-file <account-private-key-file>\n` +
          `The supplied key must derive to userPublicKey ${acct.userPublicKey}.`,
      );
    }
    // Migration: the field was named `fcmTokens` when it held native FCM
    // device tokens (pre-Expo-push). There's no way to derive an Expo push
    // token from an old FCM one, and the surface re-registers on its next
    // launch anyway (`push.ts` calls the register endpoint on every boot), so
    // the old values are dead weight — strip the stale key rather than let
    // `RegistryFile.parse`'s `.strict()` schema reject the whole file over a
    // field it no longer knows.
    if (rawObj && typeof rawObj === 'object' && 'fcmTokens' in rawObj) {
      delete (rawObj as Record<string, unknown>)['fcmTokens'];
    }
    const parsed = RegistryFile.parse(rawObj);
    return new Registry(path, dataDir, parsed);
  }

  /** Atomic write: temp + fsync + rename. */
  private flush(): void {
    const tmp = `${this.path}.tmp.${process.pid}.${Date.now()}`;
    // registry.json holds daemonKeys (the credential machines authenticate
    // with) and the account private key. Owner-only. The mode goes on the tmp
    // file because rename() preserves it from there.
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    const fd = openSync(tmp, 'r');
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, this.path);
  }

  // --- account ---

  /**
   * Public-safe account view — never includes the private key. This is the
   * only account shape that may be serialised into an HTTP response.
   */
  getAccount(): AccountRecord | null {
    const a = this.state.account;
    if (!a) return null;
    return { accountId: a.accountId, userPublicKey: a.userPublicKey, createdAt: a.createdAt };
  }

  /**
   * Server-internal accessor for the account Ed25519 PRIVATE key. The server
   * is the credential authority and signs every surface/daemon credential with
   * it. NEVER serialise the return value into an HTTP response or log line.
   * Returns null if no account has been bootstrapped yet.
   */
  getAccountPrivateKey(): string | null {
    return this.state.account?.userPrivateKey ?? null;
  }

  /**
   * Bootstrap the singleton account. The SERVER is the credential authority:
   * it generates the account Ed25519 keypair itself and persists BOTH keys.
   * `accountId` is the public key. Throws `AccountConflictError` if an account
   * already exists (the route maps this to 409).
   *
   * `opts.keypair` is a test seam ONLY — production always lets the registry
   * generate a fresh keypair so the private key is born server-side and never
   * crosses a trust boundary.
   */
  bootstrapAccount(opts: { keypair?: UserKeypair; nowMs?: number } = {}): AccountRecord {
    if (this.state.account) {
      throw new AccountConflictError();
    }
    const keypair = opts.keypair ?? generateUserKeypair();
    const nowMs = opts.nowMs ?? Date.now();
    const record: StoredAccountRecord = {
      accountId: keypair.publicKey,
      userPublicKey: keypair.publicKey,
      userPrivateKey: keypair.privateKey,
      createdAt: nowMs,
    };
    this.state.account = record;
    this.flush();
    return { accountId: record.accountId, userPublicKey: record.userPublicKey, createdAt: nowMs };
  }

  // --- surfaces ---

  listSurfaces(): SurfaceRecord[] {
    return this.state.surfaces.slice();
  }

  getSurface(surfaceId: string): SurfaceRecord | undefined {
    return this.state.surfaces.find((s) => s.surfaceId === surfaceId);
  }

  upsertSurface(input: {
    surfaceId: string;
    surfaceKind: SurfaceKind;
    label: string;
    issuedAt: number;
  }): SurfaceRecord {
    const existing = this.state.surfaces.findIndex((s) => s.surfaceId === input.surfaceId);
    const record: SurfaceRecord = {
      surfaceId: input.surfaceId,
      surfaceKind: input.surfaceKind,
      label: input.label,
      issuedAt: input.issuedAt,
    };
    if (existing >= 0) {
      this.state.surfaces[existing] = record;
    } else {
      this.state.surfaces.push(record);
    }
    this.flush();
    return record;
  }

  // --- host keys (one record per registered machine) ---

  /** The record for one machine, or null if that machine is not registered. */
  getDaemonKey(hostId: string): DaemonKeyRecord | null {
    return this.state.daemonKeys.find((d) => d.hostId === hostId) ?? null;
  }

  /**
   * Was a host key minted (`iat`, unix seconds) before this machine's current
   * registration? Pairing a machine again replaces its record but a daemonKey
   * carries only the machine's id and never expires, so without this an old key
   * — one that was revoked, or stolen — would work again the moment the machine
   * re-registered under the same id.
   */
  isDaemonKeySuperseded(hostId: string, iat: number): boolean {
    const rec = this.getDaemonKey(hostId);
    if (rec === null) return false;
    // `issuedAt` is unix seconds, but records written by `mint-daemon-key` hold
    // milliseconds; nothing in seconds reaches 1e11 for thousands of years.
    const registeredAt = rec.issuedAt > 1e11 ? Math.floor(rec.issuedAt / 1000) : rec.issuedAt;
    // A minute of slack: a key minted and recorded together can straddle a second.
    return iat + SUPERSEDE_SLACK_SECONDS < registeredAt;
  }

  /** Every machine's record, in registration order (revoked ones included). */
  listDaemonKeys(): DaemonKeyRecord[] {
    return this.state.daemonKeys.slice();
  }

  /**
   * Register a machine, or replace its record on re-pair. Keyed by `hostId`,
   * so a second machine ADDS a record rather than overwriting the first — the
   * account is a relay for any number of machines (spec/01).
   */
  setDaemonKey(record: DaemonKeyRecord): void {
    const idx = this.state.daemonKeys.findIndex((d) => d.hostId === record.hostId);
    // A re-pair must not silently discard the machine's user-editable name.
    const keptName = idx >= 0 ? this.state.daemonKeys[idx]?.hostName : undefined;
    const merged: DaemonKeyRecord = {
      ...record,
      ...(record.hostName === undefined && keptName !== undefined ? { hostName: keptName } : {}),
    };
    if (idx >= 0) this.state.daemonKeys[idx] = merged;
    else this.state.daemonKeys.push(merged);
    this.flush();
  }

  /**
   * Set a machine's user-editable label (spec/03 `host.rename`). Throws when
   * the machine is not registered or the name is empty — the offending value is
   * named rather than silently defaulted.
   */
  setHostName(hostId: string, hostName: string): void {
    if (hostName.trim().length === 0) {
      throw new Error(`Registry.setHostName: empty hostName for hostId ${hostId}`);
    }
    const idx = this.state.daemonKeys.findIndex((d) => d.hostId === hostId);
    if (idx < 0) throw new Error(`Registry.setHostName: no machine registered as ${hostId}`);
    const rec = this.state.daemonKeys[idx] as DaemonKeyRecord;
    this.state.daemonKeys[idx] = { ...rec, hostName: hostName.trim() };
    this.flush();
  }

  /** The machine's user-editable label, or undefined when never renamed. */
  hostName(hostId: string): string | undefined {
    return this.getDaemonKey(hostId)?.hostName;
  }

  /**
   * The machine running the Manager (spec/06). Defaults to the first registered
   * machine so exactly one machine holds it as soon as one exists.
   */
  managerHostId(): string | null {
    const explicit = this.state.managerHostId;
    if (explicit !== null && this.isRegisteredHost(explicit)) return explicit;
    return this.registeredHostIds()[0] ?? null;
  }

  /** Make one machine the one running the Manager. Throws if unregistered. */
  setManagerHostId(hostId: string): void {
    if (!this.isRegisteredHost(hostId)) {
      throw new Error(`Registry.setManagerHostId: no machine registered as ${hostId}`);
    }
    this.state.managerHostId = hostId;
    this.flush();
  }

  /**
   * Every machine registered against this account, in registration order
   * (spec/03 § Host events — a host-addressed frame names one of these).
   */
  registeredHostIds(): string[] {
    return this.state.daemonKeys.filter((d) => d.revoked !== true).map((d) => d.hostId);
  }

  /**
   * Is `hostId` a machine this account has registered?
   *
   * The gate for every host-addressed ingress. A frame naming an unregistered
   * machine is REFUSED naming the offending id — never relayed to whichever
   * host happens to be attached (spec/03 § Host events). With one machine
   * online that difference is invisible; with two it silently runs the work on
   * the wrong filesystem, which is why the check lives at the ingress rather
   * than at the routing layer.
   */
  isRegisteredHost(hostId: string): boolean {
    return this.registeredHostIds().includes(hostId);
  }

  /**
   * Take a machine off the account (Settings → Hosts → "Remove this host").
   *
   * The record is kept as a REVOKED tombstone rather than deleted: an unknown
   * hostId's hello is merely refused, whereas a revoked one is told
   * `auth.revoked` and wipes its key — so the machine learns it was removed
   * instead of retrying forever. It drops out of `registeredHostIds()` (and
   * so out of every roster and the host-addressing gate) at once. Pairing the
   * machine again replaces the tombstone (`setDaemonKey`). An explicit home
   * choice naming it is cleared, so `managerHostId()` falls to the next machine.
   *
   * Throws naming the id when it is not a registered machine.
   */
  removeHost(hostId: string): void {
    if (!this.isRegisteredHost(hostId)) {
      throw new Error(`Registry.removeHost: no machine registered as ${hostId}`);
    }
    const idx = this.state.daemonKeys.findIndex((d) => d.hostId === hostId);
    const rec = this.state.daemonKeys[idx] as DaemonKeyRecord;
    this.state.daemonKeys[idx] = { ...rec, revoked: true };
    if (this.state.managerHostId === hostId) this.state.managerHostId = null;
    this.flush();
  }

  // --- revocation (RevocationStoreInterface) ---

  revoke(id: string): void {
    if (!id || typeof id !== 'string') {
      throw new Error('Registry.revoke: id required');
    }
    const idx = this.state.surfaces.findIndex((s) => s.surfaceId === id);
    if (idx >= 0) {
      const surface = this.state.surfaces[idx];
      // idx >= 0 comes straight from findIndex on this same array with no
      // intervening await, so surfaces[idx] is always defined here —
      // unreachable via the public API; defensive-only against a future
      // refactor that adds concurrency to this method.
      /* v8 ignore next */
      if (!surface) throw new Error('Registry.revoke: lost surface mid-update');
      this.state.surfaces[idx] = { ...surface, revoked: true };
      this.flush();
      return;
    }
    const dIdx = this.state.daemonKeys.findIndex((d) => d.hostId === id);
    if (dIdx >= 0) {
      const rec = this.state.daemonKeys[dIdx] as DaemonKeyRecord;
      this.state.daemonKeys[dIdx] = { ...rec, revoked: true };
      this.flush();
      return;
    }
    throw new Error(`Registry.revoke: no surface or host with id=${id}`);
  }

  isRevoked(id: string): boolean {
    const surface = this.state.surfaces.find((s) => s.surfaceId === id);
    if (surface) return surface.revoked === true;
    const daemon = this.state.daemonKeys.find((d) => d.hostId === id);
    if (daemon) return daemon.revoked === true;
    // Unknown id: not revoked, but also not authoritative — caller should
    // pair this with a "do we know this id at all?" check via getSurface.
    return false;
  }

  // --- Expo push tokens (group 11) ---

  /** Register or refresh an Expo push token for a surface. */
  registerPushToken(input: {
    surfaceId: string;
    /** Owning account (group 12 DX-4). Required for new writes. */
    accountId: string;
    token: string;
    registeredAt: number;
  }): PushTokenRecord {
    const tokens = this.state.pushTokens ?? [];
    const existing = tokens.findIndex((t) => t.surfaceId === input.surfaceId);
    const record: PushTokenRecord = {
      surfaceId: input.surfaceId,
      accountId: input.accountId,
      token: input.token,
      registeredAt: input.registeredAt,
    };
    if (existing >= 0) {
      tokens[existing] = record;
    } else {
      tokens.push(record);
    }
    this.state.pushTokens = tokens;
    this.flush();
    return record;
  }

  /**
   * Remove Expo push tokens by their token string (spec/09: permanently-rejected
   * tokens are pruned so they are never re-attempted). Returns the count
   * removed. A no-op flush is skipped so a push that hits no dead tokens does
   * not churn the registry file.
   */
  removePushTokens(tokens: string[]): number {
    if (tokens.length === 0) return 0;
    const dead = new Set(tokens);
    const current = this.state.pushTokens ?? [];
    const kept = current.filter((t) => !dead.has(t.token));
    const removed = current.length - kept.length;
    if (removed > 0) {
      this.state.pushTokens = kept;
      this.flush();
    }
    return removed;
  }

  /**
   * List Expo push tokens for an account. Excludes revoked surfaces.
   *
   * Group 12 (DX-4): properly scopes by `accountId`. Pre-fix records without
   * an `accountId` field are included only for the bootstrapped account
   * (the singleton-account assumption holds for upgrade paths). Multi-account
   * deployments will always write `accountId` going forward.
   */
  listPushTokens(accountId: string): string[] {
    const tokens = this.state.pushTokens ?? [];
    const revoked = new Set(this.state.surfaces.filter((s) => s.revoked).map((s) => s.surfaceId));
    const singletonAccountId = this.state.account?.accountId;
    const live = tokens
      .filter((t) => !revoked.has(t.surfaceId))
      .filter((t) => {
        if (t.accountId) return t.accountId === accountId;
        // Legacy record (no accountId): attribute to the singleton account.
        return singletonAccountId === accountId;
      })
      .map((t) => t.token);
    // A phone re-paired as a new surface holds the same token under two ids; it
    // must be pushed once, not twice.
    return [...new Set(live)];
  }

  // --- Project-launch folders (Settings → Project folders) ---

  /** The account's configured launch folders, or [] when none set. */
  getProjectFolders(accountId: string): string[] {
    const recs = this.state.projectFolders ?? [];
    return recs.find((r) => r.accountId === accountId)?.folders ?? [];
  }

  /** Replace the account's launch-folder list. Trims, drops blanks + dupes. */
  setProjectFolders(accountId: string, folders: string[], nowMs: number): void {
    const cleaned: string[] = [];
    for (const f of folders) {
      const t = f.trim();
      if (t !== '' && !cleaned.includes(t)) cleaned.push(t);
    }
    const recs = this.state.projectFolders ?? [];
    const existing = recs.findIndex((r) => r.accountId === accountId);
    const record: ProjectFoldersRecord = { accountId, folders: cleaned, updatedAt: nowMs };
    if (existing >= 0) {
      recs[existing] = record;
    } else {
      recs.push(record);
    }
    this.state.projectFolders = recs;
    this.flush();
  }

  /** Test-only snapshot. */
  snapshot(): RegistryFile {
    return structuredClone(this.state);
  }
}
