// The server this Mac runs for itself, as its own launchd agent (spec/11 §
// Server on a Mac). The desktop app installs the release it carries into an
// install home, registers the agent and starts it; after that the app is only a
// window onto it. Quitting the app leaves the agent running.

import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** The launchd label of the server agent (the host's is `io.github.patch-hq.host`). */
export const SERVER_SERVICE_LABEL = 'io.github.patch-hq.server';

/** Releases kept in `versions/`: the current one and the two before it. */
const KEPT_VERSIONS = 3;

export interface ServiceEnv {
  home: string;
  /** The Node that runs the launcher; in Electron the app's own with `ELECTRON_RUN_AS_NODE`. */
  node: { execPath: string; env: Record<string, string> };
  port: number;
  relayUrl?: string;
}

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function serverPlistPath(userHome: string): string {
  return join(userHome, 'Library', 'LaunchAgents', `${SERVER_SERVICE_LABEL}.plist`);
}

/** The agent: starts at login, comes back whatever stopped it but `launchctl bootout`. */
export function serverPlist(env: ServiceEnv, userHome: string): string {
  const vars: Record<string, string> = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: userHome,
    ...env.node.env,
    PATCH_SERVER_HOME: env.home,
    PATCH_NODE: env.node.execPath,
    PORT: String(env.port),
    HOST: '127.0.0.1',
    ...(env.relayUrl ? { PATCH_RELAY_URL: env.relayUrl } : {}),
  };
  const entries = Object.entries(vars)
    .map(([k, v]) => `      <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join('\n');
  const log = xml(join(env.home, 'logs', 'server.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVER_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xml(join(env.home, 'current', 'patch-server'))}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${entries}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

/** `launchctl`, injectable so tests do not touch the machine's launchd. */
export type Launchctl = (args: string[]) => Promise<{ ok: boolean; output: string }>;

export const realLaunchctl: Launchctl = (args) =>
  new Promise((resolve) => {
    execFile('/bin/launchctl', args, (err, stdout, stderr) =>
      resolve({ ok: err === null, output: `${stdout}${stderr}`.trim() }),
    );
  });

/**
 * Copy the release into `versions/<release>/`, swap `current` onto it
 * atomically and drop all but the newest few (spec/11 § Server installation).
 * Returns whether `current` moved.
 */
export function layOutRelease(home: string, releaseDir: string, release: string): boolean {
  for (const d of ['data', 'downloads', 'logs', 'versions'])
    mkdirSync(join(home, d), { recursive: true });
  const target = join(home, 'versions', release);
  if (!existsSync(target)) cpSync(releaseDir, target, { recursive: true });
  const current = join(home, 'current');
  const link = `versions/${release}`;
  if (existsSync(current) && realpathSync(current) === realpathSync(target)) return false;
  const tmp = join(home, `current.${process.pid}`);
  rmSync(tmp, { force: true });
  symlinkSync(link, tmp);
  renameSync(tmp, current);
  const all = readdirSync(join(home, 'versions'))
    .filter((v) => v !== release)
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - (KEPT_VERSIONS - 1))))
    rmSync(join(home, 'versions', old), { recursive: true, force: true });
  return true;
}

export interface ServiceControl {
  /** Registers the agent from `plist` and starts it, restarting a running one that differs. */
  install(plist: string, restart: boolean): Promise<void>;
  /** Stops the agent and keeps it from starting at login until `install` runs again. */
  turnOff(): Promise<void>;
  /** Whether launchd has the agent loaded. */
  loaded(): Promise<boolean>;
}

export function serviceControl(opts: {
  userHome: string;
  uid: number;
  launchctl?: Launchctl;
}): ServiceControl {
  const lc = opts.launchctl ?? realLaunchctl;
  const domain = `gui/${opts.uid}`;
  const target = `${domain}/${SERVER_SERVICE_LABEL}`;
  const path = serverPlistPath(opts.userHome);
  const must = async (args: string[]): Promise<void> => {
    const r = await lc(args);
    if (!r.ok) throw new Error(`launchctl ${args.join(' ')} failed: ${r.output}`);
  };
  const loaded = async (): Promise<boolean> => (await lc(['print', target])).ok;
  return {
    loaded,
    async install(plist, restart) {
      mkdirSync(join(opts.userHome, 'Library', 'LaunchAgents'), { recursive: true });
      const changed = !existsSync(path) || readFileSync(path, 'utf8') !== plist;
      if (changed) writeFileSync(path, plist);
      // A turn-off disabled the label; opening the app turns it back on.
      await must(['enable', target]);
      const isLoaded = await loaded();
      if (isLoaded && !changed && !restart) return;
      if (isLoaded) await lc(['bootout', target]);
      await must(['bootstrap', domain, path]);
    },
    async turnOff() {
      await must(['disable', target]);
      if (await loaded()) await must(['bootout', target]);
    },
  };
}
