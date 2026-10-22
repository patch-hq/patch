import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readMeetingPermissions,
  requestMeetingPermission,
  type MeetingPermissionDeps,
} from './meeting-permissions.js';

function deps(over: Partial<MeetingPermissionDeps> = {}): MeetingPermissionDeps {
  let known = false;
  return {
    micStatus: () => 'granted',
    askMic: async () => true,
    accessibilityTrusted: () => false,
    probeCallAudio: async () => {},
    callAudioKnown: () => known,
    rememberCallAudio: () => {
      known = true;
    },
    ...over,
  };
}

test('reads the mic and Accessibility from macOS, and call audio as unknown until proven', () => {
  assert.deepEqual(readMeetingPermissions(deps()), {
    microphone: 'granted',
    callAudio: 'unknown',
    accessibility: 'missing',
  });
  assert.equal(
    readMeetingPermissions(deps({ micStatus: () => 'not-determined' })).microphone,
    'missing',
  );
});

test('a successful call-audio probe is remembered as granted', async () => {
  const d = deps();
  assert.equal(await requestMeetingPermission('callAudio', d), 'granted');
  assert.equal(readMeetingPermissions(d).callAudio, 'granted');
});

test('a refused probe throws the helper message and is not remembered', async () => {
  const d = deps({
    probeCallAudio: async () => {
      throw new Error('create audio tap failed');
    },
  });
  await assert.rejects(requestMeetingPermission('callAudio', d), /create audio tap/);
  assert.equal(readMeetingPermissions(d).callAudio, 'unknown');
});

test('asking for Accessibility prompts; the mic asks macOS', async () => {
  const asked: boolean[] = [];
  const state = await requestMeetingPermission(
    'accessibility',
    deps({
      accessibilityTrusted: (prompt) => {
        asked.push(prompt);
        return false;
      },
    }),
  );
  assert.equal(state, 'missing');
  assert.deepEqual(asked, [true]);
  assert.equal(
    await requestMeetingPermission('microphone', deps({ askMic: async () => false })),
    'missing',
  );
});
