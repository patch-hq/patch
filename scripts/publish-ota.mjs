#!/usr/bin/env node
// Publish this commit's mobile JavaScript as an over-the-air update, and prove
// the installed app can fetch it.
//
//   node scripts/publish-ota.mjs        (needs EXPO_TOKEN)
//
// A JS-only change reaches a phone this way; a new APK is only needed when
// native code changes. Run by the release workflow for every build.
//
// `eas update` runs Metro, which inlines EXPO_PUBLIC_* into the bundle at
// transform time — and its cache key does NOT include their values, so without
// `--clear-cache` a publish can carry the version stamps of an older commit
// (it did, twice, on 1 Sep). So the published artifact is checked, not the
// endpoint: fetch the manifest exactly as the installed APK does, download the
// launch asset and read this commit's stamps out of it. Runtime and channel
// come from the committed Android project, because they are what the
// installed APK actually asks for. NO FALLBACK — a mismatch fails the release.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apkUpdateIdentity } from './apk-update-identity.mjs';
import { verifyOtaBundle } from './verify-ota-bundle.mjs';
import { builtAt, gitSha, version } from './version.mjs';

const MOBILE = 'apps/mobile';
// Pinned so a new eas-cli release cannot change what a build publishes.
const EAS_CLI = '24.11.0';

function easProjectId() {
  const m = /const EAS_PROJECT_ID = '([0-9a-f-]{36})'/.exec(
    readFileSync(join(MOBILE, 'app.config.ts'), 'utf8'),
  );
  if (!m) throw new Error(`no EAS_PROJECT_ID in ${MOBILE}/app.config.ts`);
  return m[1];
}

if (!process.env.EXPO_TOKEN) throw new Error('EXPO_TOKEN is not set');
const identity = apkUpdateIdentity(join(MOBILE, 'android'));
if (!identity.deliverable) throw new Error(`OTA NOT DELIVERABLE: ${identity.why}`);

const info = { version: version(), gitSha: gitSha(), builtAt: builtAt() };
console.log(`ota → publishing ${info.version} / ${info.gitSha} to EAS branch ${identity.channel}`);
execFileSync(
  'npx',
  [
    '--yes',
    `eas-cli@${EAS_CLI}`,
    'update',
    '--branch',
    identity.channel,
    '--message',
    `ota ${info.gitSha}`,
    '--clear-cache',
    '--non-interactive',
  ],
  {
    cwd: MOBILE,
    stdio: 'inherit',
    env: {
      ...process.env,
      EXPO_PUBLIC_PATCH_VERSION: info.version,
      EXPO_PUBLIC_PATCH_GIT_SHA: info.gitSha,
      EXPO_PUBLIC_PATCH_BUILT_AT: info.builtAt,
    },
  },
);

const verdict = await verifyOtaBundle({
  projectId: easProjectId(),
  runtime: identity.runtime,
  channel: identity.channel,
  version: info.version,
  gitSha: info.gitSha,
});
if (!verdict.ok) throw new Error(`OTA NOT DELIVERABLE: ${verdict.why}`);
console.log(`ota → published update ${verdict.id} carries ${info.version} / ${info.gitSha}`);
