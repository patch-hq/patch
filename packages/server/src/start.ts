// Starting the server from a loaded config: the app, listening, and — when a relay
// is configured — the tunnel that makes it reachable through it (spec/10 § Relay).

import type { FastifyInstance } from 'fastify';
import { buildAll } from './app.js';
import type { ServerConfig } from './config.js';
import { RelayService } from './relay-service.js';
import { startReleaseMirror } from './release-mirror.js';
import { RELEASE_REPO, readChannel } from './release-channel.js';
import { createSelfUpdater } from './self-update.js';
import { portInUseMessage } from './port-holder.js';

export async function startServer(
  config: ServerConfig,
  logger: boolean | object = { level: process.env.LOG_LEVEL ?? 'info' },
): Promise<{ app: FastifyInstance; relay?: RelayService; port: number }> {
  const relay = config.relayUrl
    ? new RelayService({ dataDir: config.dataDir, url: config.relayUrl })
    : undefined;
  const { app } = await buildAll({
    logger,
    dataDir: config.dataDir,
    internalToken: config.internalToken,
    ...(relay ? { relay } : {}),
  });
  // Registered before listening: Fastify refuses hooks on a running instance.
  if (relay) app.addHook('onClose', async () => relay.stop());
  let stopMirror: (() => void) | undefined;
  app.addHook('onClose', async () => stopMirror?.());
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(portInUseMessage(config.port), { cause: err });
    }
    throw err;
  }
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  app.log.info({ port, host: config.host }, 'patch-server listening');
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
  return { app, ...(relay ? { relay } : {}), port };
}
