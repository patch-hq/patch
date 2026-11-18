// "On this Mac" (spec/05 § Desktop first run): the app runs a Patch server of its
// own and a host beside it. Idempotent from the point the account exists: the
// connection is saved the moment it does, so a host install that fails can be
// tried again without starting over (a second account is refused by the server).

import { generateUserKeypair } from '@patch/auth';
import type { SavedConnection } from './connection.js';
import type { LocalServer } from './local-server.js';

export interface LocalDeps {
  freePort(): Promise<number>;
  startServer(opts: { port: number }): Promise<LocalServer>;
  /** One JSON POST to the local server. */
  call(
    origin: string,
    path: string,
    body: unknown,
    bearer?: string,
  ): Promise<{ status: number; json: { credential?: string; nonce?: string; error?: string } }>;
  /** Whether this computer already runs a host. */
  hostInstalled(): boolean;
  installHost(
    origin: string,
    code: string,
    name?: string,
  ): Promise<{ ok: boolean; exitCode: number | null; output: string }>;
  save(saved: SavedConnection): void;
  /**
   * What an earlier setup of this Mac's server left behind: the account's
   * credential survives a "switch server", so choosing "On this Mac" again picks
   * the account up instead of being refused a second one.
   */
  recover(): SavedConnection | null;
  /** Which setup step has started: 'server' | 'account' | 'host' | 'connect'. The page words it. */
  progress(step: string): void;
  /** What the server calls this app in its device list when no name was chosen (the chosen name wins). */
  label: string;
}

export async function bringUpLocal(
  existing: SavedConnection | null,
  d: LocalDeps,
  name?: string,
): Promise<{ saved: SavedConnection; server: LocalServer }> {
  existing ??= d.recover();
  const port =
    existing?.connection.mode === 'local' ? existing.connection.port : await d.freePort();
  d.progress('server');
  const server = await d.startServer({ port });
  try {
    let saved = existing;
    if (saved === null) {
      d.progress('account');
      const made = await d.call(server.origin, '/api/auth/account', {
        clientType: 'surface-desktop',
        devicePublicKey: generateUserKeypair().publicKey,
        label: name ?? d.label,
      });
      if (made.status === 409) {
        throw new Error(
          'This computer’s Patch server already has an account that this app does not hold the key to. Delete the server folder (Patch → Show server data) to start over.',
        );
      }
      if (made.status !== 200 || !made.json.credential) {
        throw new Error(
          `Setting up the account failed: ${made.json.error ?? `HTTP ${made.status}`}`,
        );
      }
      saved = { connection: { mode: 'local', port }, credential: made.json.credential };
      d.save(saved);
    }
    if (!d.hostInstalled()) {
      d.progress('host');
      const started = await d.call(
        server.origin,
        '/api/auth/daemon/pair/start',
        {},
        saved.credential,
      );
      if (started.status !== 200 || !started.json.nonce) {
        throw new Error(
          `The server gave no pairing code for this computer: ${started.json.error ?? `HTTP ${started.status}`}`,
        );
      }
      const installed = await d.installHost(server.origin, started.json.nonce, name);
      if (!installed.ok) {
        throw new Error(
          `Installing the host failed (${installed.exitCode ?? 'did not run'}):\n${installed.output.trim()}`,
        );
      }
    }
    d.progress('connect');
    return { saved, server };
  } catch (e) {
    await server.stop();
    throw e;
  }
}
