// The Android project is committed (bare workflow) and the APK is built from it
// as committed (build-apk-local.mjs) — nothing runs `expo prebuild` in CI. So a
// change to app.config.ts or plugins/native/ that is not followed by
// `pnpm prebuild` ships an APK without it: on 18 Oct the runtime stayed 0.1.3
// while app.config said 0.1.5, and the APK lacked PatchCrash, which the JS
// requires at startup. Fix a failure here with
// `cd apps/mobile && pnpm prebuild` and commit android/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeVersionOf } from './build-mobile-update.mjs';

const MOBILE = 'apps/mobile';
const JAVA = join(MOBILE, 'android/app/src/main/java/io/github/tomchambers2/patch');

test('the committed Android project runs the runtimeVersion app.config.ts declares', () => {
  const config = readFileSync(join(MOBILE, 'app.config.ts'), 'utf8');
  const declared = /runtimeVersion:\s*'([^']+)'/.exec(config)?.[1];
  assert.ok(declared, 'no runtimeVersion in app.config.ts');
  const runtime = runtimeVersionOf(join(MOBILE, 'android'));
  assert.equal(runtime, declared, 'android/ is stale: run `pnpm prebuild` in apps/mobile');
});

test('every native source in plugins/native is in the committed Android project, unchanged', () => {
  for (const file of readdirSync(join(MOBILE, 'plugins/native'))) {
    const src = readFileSync(join(MOBILE, 'plugins/native', file), 'utf8');
    let copied;
    try {
      copied = readFileSync(join(JAVA, file), 'utf8');
    } catch {
      assert.fail(`${file} is not in android/: run \`pnpm prebuild\` in apps/mobile`);
    }
    assert.equal(copied, src, `${file} in android/ differs: run \`pnpm prebuild\` in apps/mobile`);
  }
});
