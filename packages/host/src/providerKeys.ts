// The provider keys this host uses (spec/02 § Provider keys).
//
// Each paid service the host itself calls — Gemini and OpenAI Realtime for
// hosted voice, Groq for Whisper, and the rest of Settings → Providers — needs
// an API key here. The keys are held on the server, encrypted, and sent to every
// host in each settings snapshot (spec/01 § Settings, spec/10 § Provider keys).
// A key has two possible sources on this host:
//
//   ui  — the shared key from the server's latest snapshot, cached in
//         `<patchHome>/keys.json` (mode 0600) so a host that restarts while the
//         server is away still starts with the keys it last had. The cache is
//         only ever replaced whole from a snapshot (`replaceAll`); nothing on the
//         host sets or deletes a key of its own.
//   env — the host's environment (`GEMINI_API_KEY`, `OPENAI_REALTIME_API_KEY`,
//         `GROQ_API_KEY`), read once at boot.
//
// The shared key wins over the environment. Everything that uses a key reads it
// through `get()` at the moment it opens a session or sends a request, so a new
// snapshot takes effect for the next session without a restart.
//
// A value never leaves this module except to the provider it belongs to, and
// once to the server when it imports a host that held keys before it first
// connected (`settingsKeys`). `describe()` reports only where each key comes
// from and its last four characters. Crash-durable atomic write (temp + fsync +
// rename) as secrets.ts. NO FALLBACK: a malformed file throws on load rather
// than silently starting empty and running on a different key than the one
// chosen.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  PROVIDER_KEYS,
  providerKeyInfo,
  type HostProviderKey,
  type ProviderKeyId,
} from '@patch/wire';

const KeysFile = z
  .object({
    version: z.literal(1),
    keys: z
      .object({
        gemini: z.string().min(1).optional(),
        openai: z.string().min(1).optional(),
        groq: z.string().min(1).optional(),
        deepgram: z.string().min(1).optional(),
        assemblyai: z.string().min(1).optional(),
        elevenlabs: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();
type KeysFile = z.infer<typeof KeysFile>;

export type ProviderKeyErrorCode = 'required';

export class ProviderKeyError extends Error {
  override readonly name = 'ProviderKeyError';
  constructor(
    readonly code: ProviderKeyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The environment's value for each key, read once at boot. */
export type EnvProviderKeys = Partial<Record<ProviderKeyId, string | undefined>>;

export function providerKeysPath(patchHome: string): string {
  return join(patchHome, 'keys.json');
}

export class ProviderKeyStore {
  private readonly path: string;
  private readonly env: EnvProviderKeys;
  private stored: KeysFile['keys'];
  private readonly listeners = new Set<() => void>();

  private requiredToStart: Partial<Record<ProviderKeyId, string>>;

  /**
   * `requiredToStart` names each key this host cannot boot without, with the
   * reason (the host aborts at startup when it is missing — Groq under
   * the speech setting naming Groq). A snapshot that drops the last value of
   * such a key is refused: the host would not come back up to be given a new one.
   */
  constructor(opts: {
    path: string;
    env: EnvProviderKeys;
    requiredToStart?: Partial<Record<ProviderKeyId, string>>;
  }) {
    this.path = opts.path;
    this.env = {};
    // `GEMINI_API_KEY=` in a .env file is an unset key, not a key of "".
    for (const [id, value] of Object.entries(opts.env) as [ProviderKeyId, string | undefined][]) {
      if (value !== undefined && value.trim() !== '') this.env[id] = value;
    }
    this.requiredToStart = opts.requiredToStart ?? {};
    this.stored = this.load();
  }

  /** The keys this host cannot start without now (the speech setting changed). */
  setRequiredToStart(required: Partial<Record<ProviderKeyId, string>>): void {
    this.requiredToStart = required;
  }

  private load(): KeysFile['keys'] {
    if (!existsSync(this.path)) return {};
    // A file someone widened is narrowed back before it is read: the values in
    // it are live credentials.
    if ((statSync(this.path).mode & 0o077) !== 0) chmodSync(this.path, 0o600);
    const raw = readFileSync(this.path, 'utf8');
    try {
      return KeysFile.parse(JSON.parse(raw)).keys;
    } catch (err) {
      throw new Error(
        `${this.path} is not a valid provider-key file (${(err as Error).message.split('\n')[0]}). ` +
          'Fix or remove it; the host will not guess which keys it held.',
      );
    }
  }

  /** The value in use for `id`: the shared one, else the environment's. */
  get(id: ProviderKeyId): string | undefined {
    return this.stored[id] ?? this.env[id];
  }

  has(id: ProviderKeyId): boolean {
    return this.get(id) !== undefined;
  }

  /** Every key's status, in Settings order. Never a value. */
  describe(): HostProviderKey[] {
    return PROVIDER_KEYS.map(({ id }) => {
      const ui = this.stored[id];
      const env = this.env[id];
      const value = ui ?? env;
      return {
        id,
        source: ui !== undefined ? 'ui' : env !== undefined ? 'env' : 'none',
        ...(value !== undefined ? { last4: value.slice(-4) } : {}),
        envSet: env !== undefined,
      } satisfies HostProviderKey;
    });
  }

  /**
   * Replace the cached shared keys with the ones from a snapshot
   * (spec/01 § Settings). Refuses — and changes nothing — when the snapshot
   * drops the one key this host needs to start, with none in its environment:
   * the host would not come back up to be given another.
   */
  replaceAll(next: Partial<Record<ProviderKeyId, string>>): void {
    for (const [id, reason] of Object.entries(this.requiredToStart) as [ProviderKeyId, string][]) {
      if (next[id] === undefined && this.env[id] === undefined) {
        const { label } = providerKeyInfo(id);
        throw new ProviderKeyError(
          'required',
          `${reason}, and the shared settings have no ${label} key: without it the host would not start`,
        );
      }
    }
    const same =
      Object.keys(next).length === Object.keys(this.stored).length &&
      (Object.keys(next) as ProviderKeyId[]).every((id) => this.stored[id] === next[id]);
    if (!same) this.persist({ ...next });
  }

  /**
   * Every key this host holds, shared or from its environment (the shared one
   * wins), for its one-time import into the account's store.
   */
  settingsKeys(): Partial<Record<ProviderKeyId, string>> {
    return { ...this.env, ...this.stored };
  }

  /** The key in the host's own environment, for adopting it as the shared one. */
  envValue(id: ProviderKeyId): string | undefined {
    return this.env[id];
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private persist(next: KeysFile['keys']): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const data = `${JSON.stringify({ version: 1, keys: next } satisfies KeysFile, null, 2)}\n`;
    const tmp = `${this.path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    // Only once the file holds it does the host use it: a write that failed
    // must not leave a key in use that the next boot would not have.
    this.stored = next;
    for (const fn of this.listeners) fn();
  }
}
