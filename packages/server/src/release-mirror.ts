// Follows a release channel on GitHub and mirrors it into this server's
// downloads folder, which the server already serves to its hosts, desktop app
// and phone (the update channel of spec/11 § Version reporting).
//
// Nothing about delivery changes for a client. A host asks THIS server for
// `host-latest.json`, the desktop app for `latest-mac.yml`, the phone for
// `android-latest.json`; what changes is where this server gets them from: a
// published release instead of a deploy someone ran by hand.
//
// The repository is the project's (release-channel.ts); the channel is the
// operator's one choice, `patch-server channel stable|dev|off`. A server that
// installed itself also installs the server release it mirrors (self-update.ts).
//
// NO FALLBACK: a release that is incomplete, a checksum that does not match, two
// host manifests that disagree about the build, or a GitHub that will not answer
// is an error that is logged and retried next time. The folder is never left
// half-updated: everything is downloaded and checked in a staging directory
// first, then moved into place, manifests last.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type Channel = 'stable' | 'dev';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}
export interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: ReleaseAsset[];
}

export interface MirrorState {
  tag: string;
  version: string;
  mirroredAt: string;
  /** The `MIRROR_FORMAT` that mirrored it; absent before formats were recorded. */
  format?: number;
}

/**
 * Bump whenever the mirror starts copying something it did not before. A
 * release is mirrored by the server that was running when it appeared — the
 * OLD code — and that server then installs the release carrying the new code,
 * which would otherwise see the tag as done and never fetch the new files
 * (mobile-update.json was missed exactly this way). A record from an older
 * format is mirrored again.
 */
export const MIRROR_FORMAT = 2;

/** Host manifest as build-host writes it; only what the merge needs is typed. */
interface HostManifest {
  version: string;
  gitSha: string;
  signingPublicKey: string;
  artifacts: { target: string }[];
  [k: string]: unknown;
}

const STATE_FILE = 'release-mirror.json';

/** The release a channel follows, or null when it has none. Pure. */
export function selectRelease(releases: Release[], channel: Channel): Release | null {
  const live = releases.filter((r) => !r.draft && r.published_at);
  const pool = channel === 'stable' ? live.filter((r) => !r.prerelease) : live;
  const sorted = [...pool].sort(
    (a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!),
  );
  return sorted[0] ?? null;
}

/**
 * One manifest from the per-target ones a release carries
 * (`host-latest-<target>.json`). They must describe ONE build and ONE signing
 * key: mixing two would install code that claims to be a version it is not.
 */
export function mergeHostManifests(manifests: HostManifest[]): HostManifest {
  const [first, ...rest] = manifests;
  if (!first) throw new Error('the release has no host manifest');
  for (const m of rest) {
    if (m.version !== first.version || m.gitSha !== first.gitSha) {
      throw new Error(
        `host manifests disagree: ${first.version} (${first.gitSha}) vs ${m.version} (${m.gitSha})`,
      );
    }
    if (m.signingPublicKey !== first.signingPublicKey) {
      throw new Error('host manifests were signed with different artifact keys');
    }
  }
  const byTarget = new Map<string, HostManifest['artifacts'][number]>();
  for (const m of manifests) for (const a of m.artifacts) byTarget.set(a.target, a);
  return { ...first, artifacts: [...byTarget.values()] };
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** `<hex>  <name>` lines, as `sha256sum` writes them. */
export function parseChecksum(text: string): string {
  const hex = text.trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a sha256 checksum: ${text.slice(0, 80)}`);
  return hex;
}

/** Files copied into the downloads folder as they are, when the release has them. */
const PASS_THROUGH = [
  /^patch-host-.+\.tar\.gz(\.sig)?$/,
  /^patch-.+\.apk$/,
  /^android-latest\.json$/,
  // The phone's signed update manifest. Only the manifest: the files it names
  // stay on the release, where the signed URLs point (spec/11 § Mobile updates).
  /^mobile-update\.json$/,
  /^latest-mac\.yml$/,
  /^.+\.zip(\.blockmap)?$/,
  /^desktop-latest\.json$/,
];
const SERVER_RELEASE = ['patch-server.tar.gz', 'patch-server.tar.gz.sha256', 'install.sh'];
const HOST_MANIFEST = /^host-latest-.+\.json$/;

export interface MirrorOptions {
  repo: string;
  channel: Channel;
  downloadsDir: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/**
 * What was last mirrored, or null. The record is re-derivable (the next check
 * just mirrors the release again), so a corrupt file is reported and read as
 * nothing mirrored rather than failing every check forever.
 */
export function readMirrorState(
  downloadsDir: string,
  log: (msg: string) => void = () => {},
): MirrorState | null {
  const file = join(downloadsDir, STATE_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as MirrorState;
  } catch (err: unknown) {
    log(
      `release mirror: ${STATE_FILE} is corrupt (${err instanceof Error ? err.message : String(err)}); mirroring again`,
    );
    return null;
  }
}

/**
 * Check the channel once and mirror a newer release if there is one. Resolves to
 * the tag now mirrored, or null when there was nothing to do.
 */
export async function mirrorOnce(opts: MirrorOptions): Promise<string | null> {
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };

  const get = async (url: string): Promise<Response> => {
    const res = await f(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res;
  };

  const listRes = await f(`https://api.github.com/repos/${opts.repo}/releases?per_page=30`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  // A repository that is not public yet answers 404: nothing to follow, not a fault.
  if (listRes.status === 404) {
    log(`release mirror: ${opts.repo} has no published releases`);
    return null;
  }
  if (!listRes.ok) throw new Error(`listing ${opts.repo} releases answered ${listRes.status}`);
  const list = (await listRes.json()) as Release[];
  const release = selectRelease(list, opts.channel);
  if (!release) {
    log(`release mirror: ${opts.repo} has no ${opts.channel} release yet`);
    return null;
  }
  const served = readMirrorState(opts.downloadsDir, log);
  if (served?.tag === release.tag_name && (served.format ?? 1) >= MIRROR_FORMAT) return null;

  const assets = new Map(release.assets.map((a) => [a.name, a]));
  const fetchAsset = async (name: string): Promise<Buffer> => {
    const a = assets.get(name);
    if (!a) throw new Error(`release ${release.tag_name} has no ${name}`);
    return Buffer.from(await (await get(a.browser_download_url)).arrayBuffer());
  };

  const staging = join(opts.downloadsDir, `.mirror-${release.tag_name.replace(/[^\w.-]/g, '_')}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, 'server-release'), { recursive: true });

  try {
    // The server release: the tarball must match the checksum published beside it.
    for (const name of SERVER_RELEASE) {
      if (!assets.has(name)) continue;
      writeFileSync(join(staging, 'server-release', name), await fetchAsset(name));
    }
    if (assets.has('patch-server.tar.gz')) {
      const want = parseChecksum(
        readFileSync(join(staging, 'server-release', 'patch-server.tar.gz.sha256'), 'utf8'),
      );
      const got = sha256(readFileSync(join(staging, 'server-release', 'patch-server.tar.gz')));
      if (got !== want)
        throw new Error('patch-server.tar.gz does not match its published checksum');
    }

    // Everything else is copied as published. Hosts verify their own artifacts
    // against the signing key they trust, so this server adds no trust of its own.
    const names = [...assets.keys()];
    for (const name of names.filter((n) => PASS_THROUGH.some((re) => re.test(n)))) {
      writeFileSync(join(staging, name), await fetchAsset(name));
    }

    // Host manifests are merged last, once everything they name has arrived.
    const manifestNames = names.filter((n) => HOST_MANIFEST.test(n));
    let version = release.tag_name;
    if (manifestNames.length > 0) {
      const merged = mergeHostManifests(
        await Promise.all(
          manifestNames.map(
            async (n) => JSON.parse((await fetchAsset(n)).toString('utf8')) as HostManifest,
          ),
        ),
      );
      for (const art of merged.artifacts) {
        const tar = names.find((n) => n.endsWith(`-${art.target}.tar.gz`));
        if (!tar || !existsSync(join(staging, tar)) || !existsSync(join(staging, `${tar}.sig`))) {
          throw new Error(
            `the manifest names ${art.target} but the release has no signed artifact for it`,
          );
        }
      }
      writeFileSync(join(staging, 'host-latest.json'), `${JSON.stringify(merged, null, 2)}\n`);
      version = merged.version;
    }

    // Into place: artifacts first, then the manifests clients poll, so a client
    // never sees a manifest whose files are not there yet.
    const move = (from: string, to: string) => {
      mkdirSync(join(to, '..'), { recursive: true });
      renameSync(from, to);
    };
    const MANIFESTS = new Set([
      'host-latest.json',
      'android-latest.json',
      'mobile-update.json',
      'latest-mac.yml',
      'desktop-latest.json',
    ]);
    const staged = readdirSync(staging).filter((n) => n !== 'server-release');
    for (const n of staged.filter((n) => !MANIFESTS.has(n)))
      move(join(staging, n), join(opts.downloadsDir, n));
    for (const n of staged.filter((n) => MANIFESTS.has(n)))
      move(join(staging, n), join(opts.downloadsDir, n));
    for (const n of readdirSync(join(staging, 'server-release'))) {
      move(join(staging, 'server-release', n), join(opts.downloadsDir, 'server-release', n));
    }
    const state: MirrorState = {
      tag: release.tag_name,
      version,
      mirroredAt: new Date().toISOString(),
      format: MIRROR_FORMAT,
    };
    // Temp + rename, so a crash mid-write cannot leave a truncated record.
    const stateFile = join(opts.downloadsDir, STATE_FILE);
    writeFileSync(`${stateFile}.tmp`, `${JSON.stringify(state)}\n`);
    renameSync(`${stateFile}.tmp`, stateFile);
    log(`release mirror: ${opts.repo} ${release.tag_name} (${version}) is now served`);
    return release.tag_name;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Check now and then every two minutes: one unauthenticated GitHub call per
 * check, half the 60 an hour GitHub allows an address. The channel is asked for
 * on every check, so an operator changing it is followed without a restart;
 * `off` skips the check. `afterCheck` runs after every check that was not
 * skipped (the server's self-update). Errors are logged and retried, never fatal.
 */
export function startReleaseMirror(
  opts: Omit<MirrorOptions, 'channel'> & {
    channel: () => Channel | 'off';
    afterCheck?: () => void;
  },
  everyMs = 2 * 60 * 1000,
): () => void {
  const log = opts.log ?? (() => {});
  const tick = async () => {
    let channel: Channel | 'off';
    try {
      channel = opts.channel();
      if (channel === 'off') return;
      await mirrorOnce({ ...opts, channel });
    } catch (err: unknown) {
      log(`release mirror FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      opts.afterCheck?.();
    } catch (err: unknown) {
      log(`self-update FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  void tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
