import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quietInstanceFromEnv, standInPermissions } from './quiet-instance.js';

test('quiet instance is off without PATCH_USER_DATA_DIR', () => {
  assert.equal(quietInstanceFromEnv({}), null);
  assert.equal(quietInstanceFromEnv({ PATCH_USER_DATA_DIR: '' }), null);
});

test('quiet instance carries its own data folder', () => {
  assert.deepEqual(quietInstanceFromEnv({ PATCH_USER_DATA_DIR: '/tmp/x' }), {
    userDataDir: '/tmp/x',
    quiet: true,
  });
});

test('a relative data folder is refused, not guessed at', () => {
  assert.throws(() => quietInstanceFromEnv({ PATCH_USER_DATA_DIR: 'x' }), /absolute/);
});

test('test sources stand in for exactly the permissions they replace', () => {
  const none = standInPermissions({}, () => false);
  assert.deepEqual(none, { microphone: false, callAudio: false, accessibility: false });
  const all = standInPermissions(
    { PATCH_AUDIO_TAP_FILE: '/a.wav', PATCH_AUDIO_SPEAKERS_FEED: '/s' },
    (n) => n === 'use-fake-device-for-media-stream',
  );
  assert.deepEqual(all, { microphone: true, callAudio: true, accessibility: true });
  const tapOnly = standInPermissions({ PATCH_AUDIO_TAP_FILE: '/a.wav' }, () => false);
  assert.deepEqual(tapOnly, { microphone: false, callAudio: true, accessibility: false });
});
