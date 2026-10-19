// The phone's over-the-air update as release files (scripts/build-mobile-update.mjs,
// spec/11 § Mobile updates). What matters is that the app accepts it — signed by
// the key its certificate names, every file pinned by hash — and that it names
// the release, not any one server, so the same signed bytes serve everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  buildManifest,
  checkStamps,
  contentId,
  signManifest,
  verifyManifest,
  CERTIFICATE,
  KEY_ID,
} from './build-mobile-update.mjs';

const FILES = {
  '_expo/static/js/android/entry-1.hbc': Buffer.from('BUNDLE 1.2.3 abc1234'),
  'assets/aaa': Buffer.from('PNG-A'),
  'assets/bbb': Buffer.from('TTF-B'),
};
const METADATA = {
  version: 0,
  bundler: 'metro',
  fileMetadata: {
    android: {
      bundle: '_expo/static/js/android/entry-1.hbc',
      assets: [
        { path: 'assets/aaa', ext: 'png' },
        { path: 'assets/bbb', ext: 'ttf' },
        { path: 'assets/aaa', ext: 'png' },
      ],
    },
  },
};
const build = () =>
  buildManifest({
    metadata: METADATA,
    readFile: (p) => FILES[p],
    expoClient: { name: 'Patch', runtimeVersion: '0.1.6' },
    runtimeVersion: '0.1.6',
    releaseBase: 'https://github.com/o/r/releases/download/dev-1.2.3',
    createdAt: '2026-10-19T00:00:00.000Z',
  });

test('names every file by its release URL, pinned by its sha256', () => {
  const { manifest, files } = build();
  const md5 = createHash('md5').update(FILES['_expo/static/js/android/entry-1.hbc']).digest('hex');
  assert.equal(
    manifest.launchAsset.url,
    `https://github.com/o/r/releases/download/dev-1.2.3/mobile-update-${md5}.bundle`,
  );
  assert.equal(
    manifest.launchAsset.hash,
    createHash('sha256').update(FILES['_expo/static/js/android/entry-1.hbc']).digest('base64url'),
  );
  assert.equal(manifest.launchAsset.contentType, 'application/javascript');
  assert.equal(manifest.runtimeVersion, '0.1.6');
  assert.deepEqual(manifest.extra, { expoClient: { name: 'Patch', runtimeVersion: '0.1.6' } });
  // One asset per file, even where the export listed one twice.
  assert.deepEqual(
    manifest.assets.map((a) => [a.fileExtension, a.contentType]),
    [
      ['.png', 'image/png'],
      ['.ttf', 'font/ttf'],
    ],
  );
  assert.equal(files.length, 3);
  assert.ok(
    files.every(
      (f) =>
        manifest.launchAsset.url.endsWith(f.name) ||
        manifest.assets.some((a) => a.url.endsWith(f.name)),
    ),
  );
});

test('the same code gets the same id, so a rebuild is not downloaded again', () => {
  assert.equal(build().manifest.id, build().manifest.id);
  assert.match(
    build().manifest.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(contentId(['a']), contentId(['b']));
});

test('a signature verifies against its key, and against nothing else', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const body = JSON.stringify(build().manifest);
  const signature = signManifest(body, pem);
  assert.match(signature, new RegExp(`^sig="[A-Za-z0-9+/=]+", keyid="${KEY_ID}"$`));
  assert.equal(verifyManifest(body, signature, publicKey), true);
  assert.equal(verifyManifest(`${body} `, signature, publicKey), false);
  assert.equal(verifyManifest(body, signature, other.publicKey), false);
  assert.equal(verifyManifest(body, 'keyid="main"', publicKey), false);
});

test('refuses a bundle that does not carry this build’s stamps', () => {
  assert.deepEqual(
    checkStamps(FILES['_expo/static/js/android/entry-1.hbc'], {
      version: '1.2.3',
      gitSha: 'abc1234',
    }),
    { ok: true },
  );
  const stale = checkStamps(Buffer.from('BUNDLE 1.2.2 0000000'), {
    version: '1.2.3',
    gitSha: 'abc1234',
  });
  assert.equal(stale.ok, false);
  assert.match(stale.why, /version 1\.2\.3 or gitSha abc1234/);
});

test('refuses an export with no android bundle', () => {
  assert.throws(
    () =>
      buildManifest({
        metadata: { fileMetadata: {} },
        readFile: () => Buffer.from(''),
        releaseBase: 'x',
      }),
    /no android bundle/,
  );
});

// The certificate in the app is the one every phone trusts: it must be a code
// signing certificate, and must not expire under the phones carrying it.
test('the committed certificate is a code-signing certificate valid for years', () => {
  const cert = new X509Certificate(readFileSync(CERTIFICATE, 'utf8'));
  assert.ok(cert.keyUsage?.includes('1.3.6.1.5.5.7.3.3'), 'codeSigning extended key usage');
  const yearsLeft = (Date.parse(cert.validTo) - Date.now()) / (365 * 24 * 3600 * 1000);
  assert.ok(yearsLeft > 5, `certificate expires in ${yearsLeft.toFixed(1)} years`);
});
