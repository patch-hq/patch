// The Patch app's browser, when the app is installed on this host (spec/02 §
// Browser — In the Patch app). The app writes `~/.patch/agent-browser.json`
// (mode 600): where its DevTools endpoint is while it runs, and how to start it
// when it does not. The host's agent browser then lives in the app — real tabs
// a large view shows as themselves — instead of in a Chromium of its own.
//
// NO FALLBACK: once the app is installed, an app that will not start fails the
// browser call saying so; it never quietly reverts to a separate Chromium.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { BrowserNotInstalledError, type AppBrowserLink } from './browser.js';

/** How long the app has to start and open its browser. */
const START_WAIT_MS = 30_000;

interface EndpointFile {
  endpoint?: string;
  pid?: number;
  appPath?: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The link to the app's browser. `present()` is false while the app has never
 * run on this host, and the host keeps its own Chromium.
 */
export function appBrowserLink(opts: {
  home: string;
  logger: Logger;
  platform?: NodeJS.Platform;
  now?: () => number;
}): AppBrowserLink {
  const file = join(opts.home, '.patch', 'agent-browser.json');
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now;
  const read = (): EndpointFile => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as EndpointFile;
    } catch (err) {
      opts.logger.warn({ err, file }, 'app browser: could not read the endpoint file');
      return {};
    }
  };
  const running = (e: EndpointFile): string | undefined =>
    e.endpoint && e.pid !== undefined && alive(e.pid) ? e.endpoint : undefined;
  return {
    present: () => existsSync(file),
    async endpoint(): Promise<string> {
      const first = read();
      const ready = running(first);
      if (ready) return ready;
      if (!first.appPath) {
        throw new BrowserNotInstalledError(
          `the Patch app's browser is not running and ${file} does not say how to start it. Open the Patch app.`,
        );
      }
      opts.logger.info({ appPath: first.appPath }, 'app browser: starting the Patch app');
      // In the background: the agent wants a browser, not the user's attention.
      const child =
        platform === 'darwin'
          ? spawn('open', ['-g', '-j', first.appPath], { detached: true, stdio: 'ignore' })
          : spawn(first.appPath, [], { detached: true, stdio: 'ignore' });
      // An unhandled 'error' event would take the whole host down: keep it and fail this call.
      let spawnError: Error | undefined;
      child.on('error', (err) => {
        spawnError = err;
      });
      child.unref();
      const until = now() + START_WAIT_MS;
      while (now() < until) {
        await new Promise((r) => setTimeout(r, 250));
        if (spawnError) {
          opts.logger.error(
            { err: spawnError, appPath: first.appPath },
            'app browser: could not start the Patch app',
          );
          throw new BrowserNotInstalledError(
            `the Patch app at ${first.appPath} could not be started (${spawnError.message}). Open the Patch app.`,
          );
        }
        const found = running(read());
        if (found) return found;
      }
      throw new BrowserNotInstalledError(
        `the Patch app at ${first.appPath} did not start its browser within ${START_WAIT_MS / 1000} seconds.`,
      );
    },
  };
}
