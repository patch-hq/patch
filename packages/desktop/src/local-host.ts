// The host on this Mac (spec/02 § Desktop app and the local host).
//
// The desktop app is a surface, but it is the one surface sitting on a host
// that can also be a host, so it offers to make it one: it runs the same
// installer anyone runs from a shell, with the pairing code the SPA mints, and
// the host it leaves behind is an ordinary launchd service with its own
// lifetime. Nothing here talks to the host afterwards; once it is running it
// is a host like any other, and Settings → Hosts shows it from the server.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The launchd label the installer registers (`installer/service.ts`). */
export const HOST_SERVICE_LABEL = 'io.github.patch-hq.host';

/** Labels an older install carries until its next update (`installer/service.ts`). */
export const LEGACY_HOST_SERVICE_LABELS = [
  'me.tomchambers.patch-host',
  'me.tomchambers.patch-daemon',
] as const;

export interface LocalHostStatus {
  /** Whether a host service is installed for this user on this Mac. */
  installed: boolean;
  /** This Mac's host identity, once it has one — how the SPA finds its row. */
  hostId: string | null;
}

export interface LocalHostInstallResult {
  ok: boolean;
  exitCode: number | null;
  /** What the installer printed, stdout and stderr interleaved as they came. */
  output: string;
}

/** The systemd user units the installer writes on Linux (`installer/service.ts`). */
export const HOST_SYSTEMD_UNITS = ['patch-host.service', 'patch-daemon.service'] as const;

/** Where the installer leaves its service definition on this platform. */
function serviceFiles(home: string, platform: NodeJS.Platform): string[] {
  if (platform === 'linux') {
    const units = join(home, '.config', 'systemd', 'user');
    return HOST_SYSTEMD_UNITS.map((u) => join(units, u));
  }
  const agents = join(home, 'Library', 'LaunchAgents');
  return [HOST_SERVICE_LABEL, ...LEGACY_HOST_SERVICE_LABELS].map((l) => join(agents, `${l}.plist`));
}

export function localHostStatus(
  home: string,
  platform: NodeJS.Platform = process.platform,
): LocalHostStatus {
  const plists = serviceFiles(home, platform);
  const identityFile = join(home, '.patch', 'daemon-identity.json');
  let hostId: string | null = null;
  if (existsSync(identityFile)) {
    const parsed = JSON.parse(readFileSync(identityFile, 'utf8')) as {
      hostId?: unknown;
      daemonId?: unknown; // written by a host that predates the rename; phase 3b drops it
    };
    const id = parsed.hostId ?? parsed.daemonId;
    if (typeof id === 'string') hostId = id;
  }
  return { installed: plists.some((p) => existsSync(p)), hostId };
}

function passThrough(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = process.env[n];
    if (v) out[n] = v;
  }
  return out;
}

/** A pairing code is a base64url nonce; anything else never reaches a shell. */
export function isPairingCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(code);
}

/**
 * The server origin the installer should report to, from the URL the shell
 * loads its SPA from (`https://host/app/` → `https://host`).
 */
export function serverOrigin(spaUrl: string): string {
  return new URL(spaUrl).origin;
}

/**
 * Run the published installer for this Mac. The server URL and code travel as
 * environment, never spliced into the command, and the install script reads
 * both from there. The script is fetched in full before it runs: piped
 * straight into `sh`, a failed download still exits 0 as an empty script.
 */
export function installLocalHost(opts: {
  serverUrl: string;
  code: string;
  home: string;
  /** What to call this Mac; without one the installer uses the computer's own name. */
  name?: string;
  spawnImpl?: typeof spawn;
}): Promise<LocalHostInstallResult> {
  if (!isPairingCode(opts.code)) {
    return Promise.resolve({ ok: false, exitCode: null, output: 'not a pairing code' });
  }
  const run = opts.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    const child = run(
      '/bin/sh',
      [
        '-c',
        'script=$(curl -fsSL "$PATCH_SERVER_URL/api/daemon/install.sh") && ' +
          'printf "%s\\n" "$script" | sh -s -- --non-interactive',
      ],
      {
        env: {
          HOME: opts.home,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          PATCH_SERVER_URL: opts.serverUrl,
          PATCH_PAIRING_CODE: opts.code,
          ...(opts.name ? { PATCH_HOST_NAME: opts.name } : {}),
          // The installer reads the service's PATH from the user's own login
          // shell; without this it would have to assume which one that is.
          ...(process.env['SHELL'] ? { SHELL: process.env['SHELL'] } : {}),
          // On Linux the installer registers a systemd user unit, and
          // `systemctl --user` finds the user's manager only through these.
          ...passThrough(['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'USER', 'LOGNAME']),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', (err) => resolve({ ok: false, exitCode: null, output: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, exitCode: code, output }));
  });
}

/**
 * The name the person gave this computer (macOS Sharing → Computer Name), never
 * the network hostname (`WC-M-K0X7P0RV6C`). Elsewhere the pretty hostname, then
 * the plain one without its domain.
 */
export function friendlyComputerName(
  run: (cmd: string, args: string[]) => string = (cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8' }),
  platform: NodeJS.Platform = process.platform,
  host: string = hostname(),
): string {
  const tryRun = (cmd: string, args: string[]): string => {
    try {
      return run(cmd, args).trim();
    } catch {
      return '';
    }
  };
  const named =
    platform === 'darwin'
      ? tryRun('/usr/sbin/scutil', ['--get', 'ComputerName'])
      : platform === 'linux'
        ? tryRun('hostnamectl', ['--pretty'])
        : '';
  return named || host.replace(/\.local$/, '').split('.')[0] || host;
}

/** Runs one command and says whether it succeeded; injectable so tests never touch launchd or systemd. */
export type RunCommand = (cmd: string, args: string[]) => Promise<{ ok: boolean; output: string }>;

export const realRunCommand: RunCommand = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) =>
      resolve({ ok: err === null, output: `${stdout}${stderr}`.trim() }),
    );
  });

/**
 * The host process on this computer, as its service manager sees it. Stopping
 * it really ends the process (the service has KeepAlive, so killing the
 * process alone would only bring it back); starting it brings up a fresh one.
 */
export interface HostProcess {
  /** End the host process. `keepOff` also keeps it from starting at login until `start`. */
  stop(opts?: { keepOff?: boolean }): Promise<void>;
  /** Start the host if it is not running. A running host is left alone. */
  start(): Promise<void>;
  /** Kill the host process and start a fresh one, whatever state it is in. */
  restart(): Promise<void>;
}

export function hostProcess(opts: {
  home: string;
  uid: number;
  platform?: NodeJS.Platform;
  run?: RunCommand;
}): HostProcess {
  const run = opts.run ?? realRunCommand;
  const platform = opts.platform ?? process.platform;
  const must = async (cmd: string, args: string[]): Promise<void> => {
    const r = await run(cmd, args);
    if (!r.ok) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.output}`);
  };

  if (platform === 'linux') {
    const unit = HOST_SYSTEMD_UNITS[0];
    const sc = (verb: string): Promise<void> => must('systemctl', ['--user', verb, unit]);
    return {
      async stop(o) {
        if (o?.keepOff) await sc('disable');
        await sc('stop');
      },
      async start() {
        await sc('enable');
        await sc('start');
      },
      restart: () => sc('restart'),
    };
  }

  const domain = `gui/${opts.uid}`;
  const target = `${domain}/${HOST_SERVICE_LABEL}`;
  const plist = join(opts.home, 'Library', 'LaunchAgents', `${HOST_SERVICE_LABEL}.plist`);
  const loaded = async (): Promise<boolean> => (await run('/bin/launchctl', ['print', target])).ok;
  const lc = (args: string[]): Promise<void> => must('/bin/launchctl', args);
  const requirePlist = (): void => {
    if (!existsSync(plist)) {
      throw new Error(`There is no host service for this user on this computer (${plist}).`);
    }
  };
  const bringUp = async (kill: boolean): Promise<void> => {
    requirePlist();
    // A turn-off disabled the label; starting turns it back on.
    await lc(['enable', target]);
    if (!(await loaded())) {
      // RunAtLoad starts it as it is bootstrapped.
      await lc(['bootstrap', domain, plist]);
      return;
    }
    await lc(['kickstart', ...(kill ? ['-k'] : []), target]);
  };
  return {
    async stop(o) {
      if (o?.keepOff) await lc(['disable', target]);
      if (!(await loaded())) return;
      await lc(['bootout', target]);
      // bootout returns before launchd has finished removing the job.
      const deadline = Date.now() + 15_000;
      while (await loaded()) {
        if (Date.now() > deadline)
          throw new Error(`The host was still running 15s after stopping it.`);
        await new Promise((r) => setTimeout(r, 200));
      }
    },
    start: () => bringUp(false),
    restart: () => bringUp(true),
  };
}

/**
 * Make sure the host on this computer is up and answering: start it, and if it
 * does not answer within `waitMs`, kill it and start a fresh one. Throws when
 * even that does not bring it back, so the caller can say so.
 */
export async function ensureHostAnswering(opts: {
  process: HostProcess;
  /** Whether the host is connected to the server right now. */
  answering: () => Promise<boolean>;
  waitMs?: number;
  pollMs?: number;
}): Promise<'already-up' | 'started' | 'restarted'> {
  const waitMs = opts.waitMs ?? 5000;
  const pollMs = opts.pollMs ?? 250;
  const waitFor = async (): Promise<boolean> => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (await opts.answering()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  if (await opts.answering()) return 'already-up';
  await opts.process.start();
  if (await waitFor()) return 'started';
  await opts.process.restart();
  if (await waitFor()) return 'restarted';
  throw new Error(`The host on this computer did not answer ${waitMs / 1000}s after a restart.`);
}
