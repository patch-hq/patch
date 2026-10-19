#!/usr/bin/env node
// Build this commit's phone update (the JS that ships without a new APK) as
// release files, signed so an installed app accepts it only if CI built it.
//
//   PATCH_UPDATE_SIGNING_KEY=<pem> node scripts/build-mobile-update.mjs \
//     --version <v> --sha <gitSha> --built-at <iso> --repo <owner/name> --tag <tag> --out <dir>
//     [--base-url <url>]   where the files are served, if not that release (a test rig)
//
// Run by the release workflow. It writes into <dir>:
//
//   mobile-update-<key>.<ext>   the bundle and every asset, each a release file
//   mobile-update.json          the signed manifest, which servers mirror and serve
//
// The manifest names each file by its GitHub release URL. That is what lets it
// be signed HERE: a manifest pointing at each server's own address would differ
// per server and could only be signed by the server, and then a server could
// hand a phone any code at all. Pointing at the release instead, the signed
// bytes are the same everywhere, the server relays them untouched, and every
// file is checked against its hash in those bytes (spec/11 § Mobile updates).
//
// NO FALLBACK: a missing key, a bundle without this commit's stamps, or a
// signature the app's own certificate does not accept stops the release.

import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, sign, verify, X509Certificate } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMain } from './lib/is-main.mjs';

const MOBILE = 'apps/mobile';
export const CERTIFICATE = join(MOBILE, 'certs', 'certificate.pem');
/** Matches `updates.codeSigningMetadata.keyid` in app.config.ts. */
export const KEY_ID = 'main';

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  json: 'application/json',
};

const sha256 = (buf) => createHash('sha256').update(buf).digest();
const md5 = (buf) => createHash('md5').update(buf).digest('hex');

/**
 * A UUID that is a function of the update's content, so rebuilding the same
 * code gives the same id and the app does not download it again.
 */
export function contentId(hashes) {
  const h = sha256(Buffer.from(hashes.join('\n'))).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The Expo Updates manifest for an `expo export` of the android platform.
 *
 * `readFile(path)` reads a file of the export (relative path). Returns the
 * manifest object and the release files it names (`from` → `name`).
 */
export function buildManifest({
  metadata,
  readFile,
  expoClient,
  runtimeVersion,
  releaseBase,
  createdAt,
}) {
  const android = metadata?.fileMetadata?.android;
  if (!android?.bundle) throw new Error('the export has no android bundle');
  const files = [];
  const describe = (path, ext, launch) => {
    const body = readFile(path);
    const key = md5(body);
    const name = `mobile-update-${key}.${launch ? 'bundle' : ext}`;
    files.push({ from: path, name });
    return {
      hash: sha256(body).toString('base64url'),
      key,
      contentType: launch ? 'application/javascript' : (MIME[ext] ?? 'application/octet-stream'),
      ...(launch ? {} : { fileExtension: `.${ext}` }),
      url: `${releaseBase}/${name}`,
    };
  };
  const launchAsset = describe(android.bundle, 'bundle', true);
  // `expo export` lists an image twice when two modules import it; one file is
  // one asset, and a manifest naming the same key twice is not one Expo writes.
  const seen = new Set();
  const assets = (android.assets ?? [])
    .filter((a) => !seen.has(a.path) && seen.add(a.path))
    .map((a) => describe(a.path, a.ext, false));
  const manifest = {
    id: contentId([launchAsset.hash, ...assets.map((a) => a.hash), runtimeVersion]),
    createdAt,
    runtimeVersion,
    launchAsset,
    assets,
    metadata: {},
    extra: { expoClient },
  };
  return { manifest, files };
}

/**
 * Does the bundle carry this build's version and commit? Read as latin1 so
 * Hermes bytecode's string table is scanned like plain JS: the stamps are
 * literals either way.
 */
export function checkStamps(bundle, expected) {
  const text = Buffer.isBuffer(bundle) ? bundle.toString('latin1') : String(bundle);
  const missing = [];
  if (!text.includes(expected.version)) missing.push(`version ${expected.version}`);
  if (!text.includes(expected.gitSha)) missing.push(`gitSha ${expected.gitSha}`);
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    why:
      `the bundle does not contain ${missing.join(' or ')}: Metro reused a cached transform ` +
      'of the module that carries them, so the phone would report a different build than it runs',
  };
}

/** `expo-signature` header value for `body`, signed RSA-SHA256 with `keyPem`. */
export function signManifest(body, keyPem) {
  const sig = sign('sha256', Buffer.from(body), createPrivateKey(keyPem)).toString('base64');
  return `sig="${sig}", keyid="${KEY_ID}"`;
}

/**
 * True when `signature` over `body` verifies against the app's certificate
 * (a PEM string) or a public key.
 */
export function verifyManifest(body, signature, certificateOrKey) {
  const sig = /sig="([^"]+)"/.exec(signature)?.[1];
  if (!sig) return false;
  const key =
    typeof certificateOrKey === 'string'
      ? new X509Certificate(certificateOrKey).publicKey
      : certificateOrKey;
  return verify('sha256', Buffer.from(body), key, Buffer.from(sig, 'base64'));
}

/** The runtime the committed Android project — and so the APK — reports. */
export function runtimeVersionOf(androidDir = join(MOBILE, 'android')) {
  const strings = readFileSync(join(androidDir, 'app/src/main/res/values/strings.xml'), 'utf8');
  const runtime = /<string name="expo_runtime_version">([^<]+)<\/string>/.exec(strings)?.[1];
  if (!runtime) throw new Error('android/ declares no expo_runtime_version');
  return runtime;
}

function optionalArg(args, name) {
  const v = args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return v ?? (i >= 0 ? args[i + 1] : undefined);
}

function arg(args, name) {
  const v = args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  const value = v ?? (i >= 0 ? args[i + 1] : undefined);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function main() {
  const args = process.argv.slice(2);
  const info = {
    version: arg(args, 'version'),
    gitSha: arg(args, 'sha'),
    builtAt: arg(args, 'built-at'),
  };
  const repo = arg(args, 'repo');
  const tag = arg(args, 'tag');
  const out = arg(args, 'out');
  const keyPem = process.env.PATCH_UPDATE_SIGNING_KEY;
  if (!keyPem) throw new Error('PATCH_UPDATE_SIGNING_KEY is not set');

  const exportDir = mkdtempSync(join(tmpdir(), 'patch-mobile-update-'));
  try {
    const env = {
      ...process.env,
      EXPO_PUBLIC_PATCH_VERSION: info.version,
      EXPO_PUBLIC_PATCH_GIT_SHA: info.gitSha,
      EXPO_PUBLIC_PATCH_BUILT_AT: info.builtAt,
    };
    // `--clear`: Metro's transform cache is not keyed on EXPO_PUBLIC_* values,
    // and a cached transform once shipped the previous commit's stamps.
    execFileSync(
      'npx',
      ['expo', 'export', '--platform', 'android', '--output-dir', exportDir, '--clear'],
      { cwd: MOBILE, stdio: 'inherit', env },
    );
    const expoClient = JSON.parse(
      execFileSync('npx', ['expo', 'config', '--type', 'public', '--json'], {
        cwd: MOBILE,
        encoding: 'utf8',
        env,
      }),
    );
    const runtimeVersion = runtimeVersionOf();
    if (expoClient.runtimeVersion !== runtimeVersion) {
      throw new Error(
        `app.config says runtime ${expoClient.runtimeVersion} but android/ says ${runtimeVersion}: run \`pnpm prebuild\` in apps/mobile`,
      );
    }
    const metadata = JSON.parse(readFileSync(join(exportDir, 'metadata.json'), 'utf8'));
    const { manifest, files } = buildManifest({
      metadata,
      readFile: (p) => readFileSync(join(exportDir, p)),
      expoClient,
      runtimeVersion,
      releaseBase:
        optionalArg(args, 'base-url')?.replace(/\/$/, '') ??
        `https://github.com/${repo}/releases/download/${tag}`,
      createdAt: info.builtAt,
    });
    const stamps = checkStamps(
      readFileSync(join(exportDir, metadata.fileMetadata.android.bundle)),
      info,
    );
    if (!stamps.ok) throw new Error(`MOBILE UPDATE NOT SHIPPABLE: ${stamps.why}`);

    const body = JSON.stringify(manifest);
    const signature = signManifest(body, keyPem);
    if (!verifyManifest(body, signature, readFileSync(CERTIFICATE, 'utf8'))) {
      throw new Error(
        `PATCH_UPDATE_SIGNING_KEY does not match ${CERTIFICATE}: every installed app would refuse this update`,
      );
    }

    mkdirSync(out, { recursive: true });
    for (const f of files) copyFileSync(join(exportDir, f.from), join(out, f.name));
    writeFileSync(
      join(out, 'mobile-update.json'),
      `${JSON.stringify({ platform: 'android', runtimeVersion, ...info, manifest: body, signature }, null, 2)}\n`,
    );
    console.log(
      `mobile update → ${info.version} (${info.gitSha}) for runtime ${runtimeVersion}: ${files.length} files, id ${manifest.id}`,
    );
  } finally {
    rmSync(exportDir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) main();
