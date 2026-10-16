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
  const auth = ['--key', key, '--key-id', keyId, '--issuer', issuer];
  const result = JSON.parse(
    execFileSync('xcrun', ['notarytool', 'submit', zip, ...auth, '--wait', '--output-format', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
  execFileSync('rm', ['-f', zip]);
  if (result.status !== 'Accepted') {
    // Apple's log says which file it refused and why.
    execFileSync('xcrun', ['notarytool', 'log', result.id, ...auth], { stdio: 'inherit' });
    throw new Error(`notarize: Apple answered "${result.status}" for submission ${result.id}`);
  }
  console.log(`[notarize] accepted (${result.id})`);

  // Staple the ticket so Gatekeeper accepts the app offline. Fetching the ticket
  // is a network call that drops now and then; a few tries, then fail loudly.
  for (let attempt = 1; ; attempt += 1) {
    try {
      execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
      break;
    } catch (err) {
      if (attempt === 5) throw err;
      console.warn(`[notarize] stapling failed (try ${attempt} of 5); trying again in ${attempt * 10}s`);
      execFileSync('sleep', [String(attempt * 10)]);
    }
  }
  console.log('[notarize] notarized + stapled OK');
};
