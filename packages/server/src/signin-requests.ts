// Sign-in requests — approving a new device from one that is already signed in.
//
// The new device asks (`POST /api/auth/signin/request`) and is handed an `id`
// plus a private `secret` it keeps. Every signed-in surface is told. Whoever
// approves is shown a six-digit `code`; the person types it into the new
// device, which redeems it for a credential. The code only ever leaves the
// server on an authenticated approve, so being able to name the request is not
// enough — you must also be looking at the approving device.
//
// In memory, like pairing nonces: a request lives five minutes.

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const SIGNIN_REQUEST_TTL_MS = 5 * 60 * 1000;
/** Wrong codes allowed before the request is burned. */
export const SIGNIN_MAX_CODE_ATTEMPTS = 3;
/** Requests waiting at once; a flood of unauthenticated asks must not grow memory. */
export const SIGNIN_MAX_PENDING = 5;
/** How long a settled request is remembered, so the asking device hears "denied" not "unknown". */
const KEEP_AFTER_EXPIRY_MS = 60 * 1000;

export type SignInState = 'pending' | 'approved' | 'denied' | 'expired';

export interface SignInRequest {
  id: string;
  /** Held only by the asking device. */
  secret: string;
  code: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  state: 'pending' | 'approved' | 'denied';
  attempts: number;
}

export type RedeemResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'unknown' | 'expired' | 'not_approved' | 'denied' | 'wrong_code' | 'locked';
    };

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class SignInRequestStore {
  private readonly entries = new Map<string, SignInRequest>();

  /** Open a request. Throws when too many are already waiting. */
  create(label: string, nowMs: number): SignInRequest {
    this.sweep(nowMs);
    if (this.pending(nowMs).length >= SIGNIN_MAX_PENDING) {
      throw new TooManySignInRequestsError();
    }
    const req: SignInRequest = {
      id: randomBytes(12).toString('base64url'),
      secret: randomBytes(24).toString('base64url'),
      code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
      label,
      createdAt: nowMs,
      expiresAt: nowMs + SIGNIN_REQUEST_TTL_MS,
      state: 'pending',
      attempts: 0,
    };
    this.entries.set(req.id, req);
    return req;
  }

  /** Requests still waiting for an answer, oldest first. */
  pending(nowMs: number): SignInRequest[] {
    this.sweep(nowMs);
    return [...this.entries.values()]
      .filter((r) => r.state === 'pending' && r.expiresAt > nowMs)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Look a request up by id alone (the approving side). */
  get(id: string, nowMs: number): SignInRequest | undefined {
    this.sweep(nowMs);
    return this.entries.get(id);
  }

  /** The asking device's view: needs the secret, reveals only the state. */
  stateFor(id: string, secret: string, nowMs: number): SignInState | undefined {
    const r = this.get(id, nowMs);
    if (!r || !safeEqual(r.secret, secret)) return undefined;
    if (r.expiresAt <= nowMs) return 'expired';
    return r.state;
  }

  approve(id: string, nowMs: number): SignInRequest | undefined {
    const r = this.get(id, nowMs);
    if (!r || r.expiresAt <= nowMs || r.state !== 'pending') return undefined;
    r.state = 'approved';
    return r;
  }

  deny(id: string, nowMs: number): SignInRequest | undefined {
    const r = this.get(id, nowMs);
    if (!r || r.expiresAt <= nowMs || r.state !== 'pending') return undefined;
    r.state = 'denied';
    return r;
  }

  /**
   * Check the typed code. Success consumes the request, so a code works once.
   * A wrong code counts against the request; the last allowed miss burns it.
   */
  redeem(id: string, secret: string, code: string, nowMs: number): RedeemResult {
    const r = this.get(id, nowMs);
    if (!r || !safeEqual(r.secret, secret)) return { ok: false, reason: 'unknown' };
    if (r.expiresAt <= nowMs) return { ok: false, reason: 'expired' };
    if (r.state === 'denied') return { ok: false, reason: 'denied' };
    if (r.state !== 'approved') return { ok: false, reason: 'not_approved' };
    if (r.attempts >= SIGNIN_MAX_CODE_ATTEMPTS) return { ok: false, reason: 'locked' };
    if (!safeEqual(r.code, code.trim())) {
      r.attempts += 1;
      if (r.attempts >= SIGNIN_MAX_CODE_ATTEMPTS) {
        r.state = 'denied';
        return { ok: false, reason: 'locked' };
      }
      return { ok: false, reason: 'wrong_code' };
    }
    this.entries.delete(id);
    return { ok: true };
  }

  private sweep(nowMs: number): void {
    for (const [id, r] of this.entries) {
      if (r.expiresAt + KEEP_AFTER_EXPIRY_MS <= nowMs) this.entries.delete(id);
    }
  }
}

export class TooManySignInRequestsError extends Error {
  constructor() {
    super('too many sign-in requests are waiting');
  }
}
