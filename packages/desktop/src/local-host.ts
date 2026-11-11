// The host on this Mac (spec/02 § Desktop app and the local host).
//
// The desktop app is a surface, but it is the one surface sitting on a host
// that can also be a host, so it offers to make it one: it runs the same
// installer anyone runs from a shell, with the pairing code the SPA mints, and
// the host it leaves behind is an ordinary launchd service with its own
// lifetime. Nothing here talks to the host afterwards; once it is running it
// is a host like any other, and Settings → Hosts shows it from the server.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The launchd label the installer registers (`installer/service.ts`). */
export const HOST_SERVICE_LABEL = 'me.tomchambers.patch-host';

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
  // A Mac installed before the host rename still carries the old label until its next update.
  const legacyServiceLabel = HOST_SERVICE_LABEL.replace(/patch-host$/, 'patch-daemon');
  return [HOST_SERVICE_LABEL, legacyServiceLabel].map((l) => join(agents, `${l}.plist`));
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
