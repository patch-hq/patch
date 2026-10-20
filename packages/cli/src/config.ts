// CLI configuration loader.
//
// Reads ~/.patch/config.json (server URL, default folder, voice prefs) and
// allows env overrides via PATCH_SERVER_URL / PATCH_DAEMON_SOCKET /
// PATCH_DAEMON_LOCAL_KEY. NO FALLBACKS: a malformed config crashes loud.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface PatchConfig {
  serverUrl: string;
  defaultFlags?: string[];
  defaultFolder?: string;
  voice?: { enabled?: boolean };
}

export interface ResolvedConfig {
  serverUrl: string;
  hostSocket: string | null;
  daemonLocalKey: string | null;
  defaultFlags: string[];
  defaultFolder: string | null;
  configHome: string;
}

const DEFAULT_SERVER = 'http://localhost:3000';

export function configHomeDir(): string {
  const home = process.env.PATCH_HOME;
  const cfg = process.env.PATCH_CONFIG_DIR;
  if (home && home.length > 0 && cfg && cfg.length > 0 && home !== cfg) {
    throw new Error(
      'set only one of PATCH_HOME / PATCH_CONFIG_DIR (they are aliases; got different values)',
    );
  }
  const override = home || cfg;
  if (override && override.length > 0) return override;
  return join(homedir(), '.patch');
}

export function configFilePath(): string {
  return join(configHomeDir(), 'config.json');
}

export function identityFilePath(): string {
  return join(configHomeDir(), 'identity.key');
}

export function credentialFilePath(): string {
  return join(configHomeDir(), 'credential.jwt');
}

/**
 * Mirrors the host's `defaultSocketPath`: `<home>/host.sock` on Unix, a named
 * pipe keyed by the home on Windows. The two must agree, so the host test and
 * the CLI test pin the same value.
 */
export function defaultHostSocketPath(platform: NodeJS.Platform = process.platform): string {
  const home = configHomeDir();
  if (platform !== 'win32') return join(home, 'host.sock');
  const id = createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\patch-host-${id}`;
}

/** The socket a host built before the rename listens on. */
export function legacyHostSocketPath(): string {
  return join(configHomeDir(), 'daemon.sock');
}

/**
 * Where the running host keeps this run's local key — beside the socket,
 * under the host user's own `~/.patch` (spec/02 § Control IPC). The fixed
 * path is what makes it findable without a discovery step.
 */
export function defaultLocalKeyPath(): string {
  return join(configHomeDir(), 'local.key');
}

/** Load and resolve config, applying env overrides. */
export function loadConfig(): ResolvedConfig {
  let fileConfig: Partial<PatchConfig> = {};
  const path = configFilePath();
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    fileConfig = JSON.parse(raw) as Partial<PatchConfig>;
    if (typeof fileConfig !== 'object' || fileConfig === null) {
      throw new Error(`config: ${path} is not an object`);
    }
  }

  // Empty env counts as unset, like every other override here. A value that
  // is present but empty/invalid in the file, or invalid in the env, throws.
  const envServer = process.env.PATCH_SERVER_URL;
  let serverUrl: string;
  let serverUrlSource: string;
  if (envServer !== undefined && envServer.length > 0) {
    serverUrl = envServer;
    serverUrlSource = 'PATCH_SERVER_URL';
  } else if (fileConfig.serverUrl !== undefined) {
    serverUrl = fileConfig.serverUrl;
    serverUrlSource = `serverUrl in ${path}`;
  } else {
    serverUrl = DEFAULT_SERVER;
    serverUrlSource = 'the default';
  }
  try {
    new URL(serverUrl);
  } catch {
    throw new Error(
      `config: invalid server URL ${JSON.stringify(serverUrl)} from ${serverUrlSource}`,
    );
  }

  // Host socket auto-detection: env override > default path if it exists
  // and is reachable as a socket.
  const envSocket = process.env.PATCH_HOST_SOCKET ?? process.env.PATCH_DAEMON_SOCKET;
  let hostSocket: string | null = null;
  if (envSocket && envSocket.length > 0) {
    hostSocket = envSocket;
  } else {
    // A host older than the rename still listens on daemon.sock.
    const candidates =
      process.platform === 'win32'
        ? [defaultHostSocketPath()]
        : [defaultHostSocketPath(), legacyHostSocketPath()];
    for (const defaultPath of candidates) {
      // A Windows named pipe stats as something other than a socket.
      if (
        existsSync(defaultPath) &&
        (process.platform === 'win32' || statSync(defaultPath).isSocket())
      ) {
        hostSocket = defaultPath;
        break;
      }
    }
  }

  // The host mints the key and writes it beside the socket; a person running
  // the CLI on that machine READS IT FROM THAT FILE. The env var is honoured
  // first only because the host puts it in the environment of the children it
  // starts, which is the same value — it is not a way to configure the key,
  // and nothing but the host may set it (spec/02 § Control IPC).
  const envLocalKey = process.env.PATCH_DAEMON_LOCAL_KEY;
  let daemonLocalKey: string | null =
    envLocalKey !== undefined && envLocalKey.length > 0 ? envLocalKey : null;
  if (daemonLocalKey === null) {
    const keyPath = defaultLocalKeyPath();
    if (existsSync(keyPath)) {
      const value = readFileSync(keyPath, 'utf8').trim();
      // An empty file means a rotation is mid-flight or the host is gone.
      // Leaving it null makes the socket call fail with a clear 401 rather
      // than sending an empty bearer that reads as a bug elsewhere.
      daemonLocalKey = value.length > 0 ? value : null;
    }
  }

  return {
    serverUrl,
    hostSocket,
    daemonLocalKey,
    defaultFlags: fileConfig.defaultFlags ?? [],
    defaultFolder: fileConfig.defaultFolder ?? null,
    configHome: configHomeDir(),
  };
}
