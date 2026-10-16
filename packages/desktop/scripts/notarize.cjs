// electron-builder afterSign hook. Runs Apple notarytool against the produced
// .app bundle so people who download it don't see "Apple cannot verify this app
// for malicious software" on first launch.
//
// Authenticates with an App Store Connect API key (no Apple ID password):
//   APPLE_API_KEY         path to the AuthKey_<id>.p8 file
//   APPLE_API_KEY_ID      the key's id
//   APPLE_API_ISSUER      the issuer id of the team the key belongs to
//
// NO FALLBACK: missing values throw, so a forgotten secret in CI never quietly
// publishes an un-notarised build. PATCH_SKIP_NOTARIZE=1 is for a local build
// that will never be published.

const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.PATCH_SKIP_NOTARIZE === '1') {
    console.warn('[notarize] PATCH_SKIP_NOTARIZE=1 — not notarising (local build).');
    return;
  }

  const key = process.env.APPLE_API_KEY;
  const keyId = process.env.APPLE_API_KEY_ID;
  const issuer = process.env.APPLE_API_ISSUER;
  if (!key || !keyId || !issuer) {
    throw new Error(
      'notarize: APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER are required ' +
        '(set PATCH_SKIP_NOTARIZE=1 for a local build that is never published).',
    );
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  // notarytool takes a zip or dmg, not a bare .app.
  const zip = path.join(context.appOutDir, `${appName}-notarize.zip`);
  execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, zip], { stdio: 'inherit' });

  console.log(`[notarize] submitting ${appPath}`);
  execFileSync(
    'xcrun',
    ['notarytool', 'submit', zip, '--key', key, '--key-id', keyId, '--issuer', issuer, '--wait'],
    { stdio: 'inherit' },
  );
  execFileSync('rm', ['-f', zip]);
  // Staple the ticket so Gatekeeper accepts the app offline.
  execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
  console.log('[notarize] notarized + stapled OK');
};
