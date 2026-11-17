import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDevTag, stableAliases } from './promote.mjs';

const releases = [
  { tagName: 'v1.1.10', isDraft: false, createdAt: '2026-10-16T10:00:00Z' },
  { tagName: 'dev-1.1.12', isDraft: false, createdAt: '2026-10-16T12:00:00Z' },
  { tagName: 'dev-1.1.11', isDraft: false, createdAt: '2026-10-16T11:00:00Z' },
  { tagName: 'dev-1.1.13', isDraft: true, createdAt: '2026-10-16T13:00:00Z' },
];

test('with no version, the newest published dev release', () => {
  assert.equal(pickDevTag(releases), 'dev-1.1.12');
});

test('a named version must exist as a published dev release', () => {
  assert.equal(pickDevTag(releases, '1.1.11'), 'dev-1.1.11');
  assert.throws(() => pickDevTag(releases, '1.1.13'), /no release dev-1.1.13/);
  assert.throws(() => pickDevTag(releases, '1.1.10'), /no release dev-1.1.10/);
});

test('nothing to promote is an error', () => {
  assert.throws(() => pickDevTag([]), /no dev releases/);
});

const release = [
  'Patch-1.1.40-arm64-mac.zip',
  'Patch-1.1.40-arm64-mac.zip.blockmap',
  'Patch-1.1.42-arm64.dmg',
  'Patch-1.1.42-x86_64.AppImage',
  'latest-mac.yml',
  'latest-linux.yml',
  'patch-1.1.42.apk',
  'install.sh',
  'patch-server.tar.gz',
];

test('a stable release carries every download under its fixed name', () => {
  assert.deepEqual(stableAliases(release), [
    { from: 'Patch-1.1.40-arm64-mac.zip', to: 'Patch-mac-arm64.zip' },
    { from: 'Patch-1.1.42-x86_64.AppImage', to: 'Patch-linux-x86_64.AppImage' },
    { from: 'patch-1.1.42.apk', to: 'Patch-android.apk' },
    { from: 'install.sh', to: 'install.sh' },
    { from: 'Patch-1.1.42-arm64.dmg', to: 'Patch-mac-arm64.dmg' },
  ]);
});

test('a release missing a download the website links to is not promoted', () => {
  assert.throws(
    () => stableAliases(release.filter((n) => !n.endsWith('.AppImage'))),
    /Patch-linux-x86_64\.AppImage/,
  );
  assert.throws(() => stableAliases(release.filter((n) => n !== 'install.sh')), /install\.sh/);
});

test('the disk image is optional, and two candidates for one name are refused', () => {
  assert.equal(
    stableAliases(release.filter((n) => !n.endsWith('.dmg'))).some((a) => a.to.endsWith('.dmg')),
    false,
  );
  assert.throws(() => stableAliases([...release, 'patch-1.1.41.apk']), /more than one/);
});

test('promoting an already-promoted file set does not alias the aliases', () => {
  const again = [
    ...release,
    'Patch-mac-arm64.zip',
    'Patch-linux-x86_64.AppImage',
    'Patch-android.apk',
  ];
  assert.deepEqual(
    stableAliases(again).map((a) => a.from),
    stableAliases(release).map((a) => a.from),
  );
});
