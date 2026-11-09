// Starting the server from a loaded config: the app, listening, and — when a relay
// is configured — the tunnel that makes it reachable through it (spec/10 § Relay).

import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyListenOptions } from 'fastify';
import { buildAll } from './app.js';
import type { ServerConfig } from './config.js';
import { RelayService } from './relay-service.js';
import { startReleaseMirror } from './release-mirror.js';
import { RELEASE_REPO, readChannel } from './release-channel.js';
import { createSelfUpdater } from './self-update.js';
import { portInUseMessage } from './port-holder.js';
import { activatedFd } from './socket-activation.js';

/**
 * The version an installed server is about to restart into: the installer swaps
 * `<home>/current` before it restarts the unit, so the release `current` points
 * at is the one that will run next. Null when it is the release already running
 * (a plain restart) or this is not an installed server. A present but unreadable
 * build-info.json throws: the going-away notice must not guess.
 */
export function readRestartTarget(
  home: string | undefined,
  running: string | undefined,
): string | null {
  if (!home) return null;
  let raw: string;
  try {
    raw = readFileSync(join(home, 'current', 'build-info.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const version = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== 'string' || version === '') {
    throw new Error(`${home}/current/build-info.json has no version`);
  }
  return version === running ? null : version;
}

export async function startServer(
  config: ServerConfig,
  logger: boolean | object = { level: process.env.LOG_LEVEL ?? 'info' },
): Promise<{ app: FastifyInstance; relay?: RelayService; port: number }> {
  const relay = config.relayUrl
    ? new RelayService({ dataDir: config.dataDir, url: config.relayUrl })
    : undefined;
  const { app, issueFiler } = await buildAll({
    logger,
    dataDir: config.dataDir,
    internalToken: config.internalToken,
    restartTarget: () =>
      readRestartTarget(process.env.PATCH_SERVER_HOME, process.env.PATCH_VERSION),
    ...(relay ? { relay } : {}),
  });
  // The process is about to die, so the report is queued synchronously and files
  // on the next start. This only observes: Node still exits as it would have.
  process.on('uncaughtExceptionMonitor', (err) => {
    issueFiler.reportAuto({
      kind: 'uncaught',
      message: err.message,
      stack: err.stack,
      surface: 'server',
    });
  });
  // Registered before listening: Fastify refuses hooks on a running instance.
  if (relay) app.addHook('onClose', async () => relay.stop());
  let stopMirror: (() => void) | undefined;
  app.addHook('onClose', async () => stopMirror?.());
  const fd = activatedFd();
  try {
    if (fd !== undefined) {
      // systemd owns the socket and keeps it across restarts (socket-activation.ts).
      // Fastify passes these options to net.Server.listen, which takes `fd`; its types omit it.
      await app.listen({ fd } as unknown as FastifyListenOptions);
      // Not for anything this process starts.
      delete process.env.LISTEN_PID;
      delete process.env.LISTEN_FDS;
    } else if (config.socketPath) {
      // A socket file left by a previous run would make listen fail with EADDRINUSE.
      rmSync(config.socketPath, { force: true });
      await app.listen({ path: config.socketPath });
      // Group-accessible so the reverse proxy (a different user) can connect.
      chmodSync(config.socketPath, 0o660);
    } else {
      await app.listen({ port: config.port, host: config.host });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(portInUseMessage(config.port), { cause: err });
    }
    throw err;
  }
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  if (fd !== undefined) app.log.info({ fd }, 'patch-server listening on the socket systemd holds');
  else if (config.socketPath) app.log.info({ socket: config.socketPath }, 'patch-server listening');
  else app.log.info({ port, host: config.host }, 'patch-server listening');
  if (relay) {
    // The tunnel ends on this process's own loopback, so it starts once that listens.
    relay.start(`http://127.0.0.1:${port}`);
    app.log.info({ channel: relay.info().channel }, 'reachable through the relay');
  }
  // Follows the project's releases unless the operator turned that off
  // (`patch-server channel off`); the channel file is read on every check.
  // A server installed by its installer (PATCH_SERVER_HOME set) also installs the
  // releases it mirrors (self-update.ts).
  const downloadsDir = process.env.PATCH_DOWNLOADS_DIR ?? '/app/downloads';
  const home = process.env.PATCH_SERVER_HOME;
  const running = process.env.PATCH_VERSION;
  stopMirror = startReleaseMirror({
    repo: RELEASE_REPO,
    channel: () => readChannel(config.dataDir),
    downloadsDir,
    log: (msg) => app.log.info(msg),
    ...(home && running
      ? {
          afterCheck: createSelfUpdater({
            home,
            downloadsDir,
            running,
            log: (msg) => app.log.info(msg),
          }),
        }
      : {}),
  });
  // systemd stops the unit with SIGTERM, which would kill the process with every
  // socket still open: hosts and surfaces would see a bare drop instead of the
  // going-away notice. Closing the app sends it first (app.ts preClose).
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'patch-server stopping: telling hosts and surfaces');
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, 'patch-server: shutdown failed');
        process.exit(1);
      });
  };
  const onTerm = (): void => stop('SIGTERM');
  const onInt = (): void => stop('SIGINT');
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);
  app.server.once('close', () => {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  });
  return { app, ...(relay ? { relay } : {}), port };
}
