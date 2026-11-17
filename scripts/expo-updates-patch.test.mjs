// expo-updates 0.27.5 crashes the app on a bad update response (issue #631).
// FileDownloader.parseMultipartRemoteUpdateResponse reads the body inside
// MultipartReader.use{}, which closes it; its catch block then calls
// responseBody.bytes() on the closed body, which throws IllegalStateException
// ("closed") on the OkHttp Dispatcher thread, uncaught, killing the process.
// The fix is a pnpm patch; Kotlin cannot run here, so this pins that the patch
// is registered and still guards that read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PATCH = 'patches/expo-updates@0.27.5.patch';

test('the workspace applies the expo-updates patch', () => {
  assert.match(read('pnpm-workspace.yaml'), /expo-updates@0\.27\.5:\s*patches\/expo-updates@0\.27\.5\.patch/);
  assert.match(read('pnpm-lock.yaml'), /patchedDependencies:\s*\n\s*expo-updates@0\.27\.5:/);
});

test('the patch catches the closed-body read and reports the parse failure', () => {
  const patch = read(PATCH);
  assert.match(patch, /FileDownloader\.kt/);
  assert.match(patch, /\+\s*responseBody\.bytes\(\)\.isNotEmpty\(\)\s*\n\+\s*\} catch \(closed: Exception\)/);
  assert.match(patch, /\+\s*if \(hasContent\)/);
});
