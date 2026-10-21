import assert from 'node:assert/strict';
import test from 'node:test';
import { MeetingPermissions, type PermissionDeps } from './meeting-permissions';

function deps(over: Partial<PermissionDeps> = {}): PermissionDeps & { flag: boolean } {
  const state = { flag: false };
  return {
    get flag() {
      return state.flag;
    },
    micStatus: () => 'not-determined',
    askMic: async () => true,
    accessibility: async () => false,
    askAccessibility: async () => true,
    tapOnce: async () => {},
    readCallAudioGranted: () => state.flag,
    writeCallAudioGranted: () => {
      state.flag = true;
    },
    ...over,
  };
}

test('read: reports each permission, with call audio taken from the remembered grant', async () => {
  const p = new MeetingPermissions(deps({ micStatus: () => 'granted' }));
  assert.deepEqual(await p.read(), { microphone: true, callAudio: false, accessibility: false });
});

test('request microphone asks the OS and returns the new state', async () => {
  let asked = 0;
  const p = new MeetingPermissions(
    deps({
      micStatus: () => (asked ? 'granted' : 'not-determined'),
      askMic: async () => {
        asked++;
        return true;
      },
    }),
  );
  assert.equal((await p.request('microphone')).microphone, true);
  assert.equal(asked, 1);
});

test('request callAudio opens the tap once and remembers the grant', async () => {
  const d = deps();
  let taps = 0;
  d.tapOnce = async () => {
    taps++;
  };
  const p = new MeetingPermissions(d);
  assert.equal((await p.request('callAudio')).callAudio, true);
  assert.equal(taps, 1);
  assert.equal(d.flag, true);
});

test('request callAudio that fails to open the tap rejects and remembers nothing', async () => {
  const d = deps({
    tapOnce: async () => {
      throw new Error('System audio did not start in time');
    },
  });
  const p = new MeetingPermissions(d);
  await assert.rejects(p.request('callAudio'), /did not start/);
  assert.equal(d.flag, false);
});

test('request accessibility prompts through the helper', async () => {
  let prompted = false;
  let trusted = false;
  const p = new MeetingPermissions(
    deps({
      accessibility: async () => trusted,
      askAccessibility: async () => {
        prompted = true;
        trusted = true;
        return true;
      },
    }),
  );
  assert.equal((await p.request('accessibility')).accessibility, true);
  assert.equal(prompted, true);
});

test('request rejects an unknown kind', async () => {
  await assert.rejects(new MeetingPermissions(deps()).request('camera' as never), /unknown/);
});
