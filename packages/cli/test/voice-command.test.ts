// `patch voice` (spec/17-cli.md § Commands, spec/16 § Who is speaking).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { voiceSimilarity, type VoiceProfile } from '@patch/wire';
import { enrolProfiles, registerVoiceCommands } from '../src/commands/voice.js';

const axis = (i: number): number[] => Array.from({ length: 256 }, (_, j) => (j === i ? 1 : 0));

test('voice has profiles (default), recent, enrol and remove', () => {
  const program = new Command();
  registerVoiceCommands(program);
  const subs = program.commands.find((c) => c.name() === 'voice')!.commands.map((c) => c.name());
  for (const name of ['profiles', 'recent', 'enrol', 'remove']) {
    assert.ok(subs.includes(name), `voice ${name}`);
  }
});

test('enrolling a new name makes a household member from the heard voices', () => {
  const { profiles, profile } = enrolProfiles([], 'Eleanor', [axis(0), axis(1)], { newId: 'e' });
  assert.equal(profiles.length, 1);
  assert.equal(profile.access, 'household');
  assert.equal(profile.samples, 2);
  assert.ok(
    Math.abs(
      voiceSimilarity(profile.voiceprint!, axis(0)) - voiceSimilarity(profile.voiceprint!, axis(1)),
    ) < 1e-5,
  );
});

test('enrolling an existing name (any case) adds samples and can change access and notes', () => {
  const tom: VoiceProfile = {
    id: 't',
    name: 'Tom',
    access: 'owner',
    context: 'Likes trains.',
    voiceprint: axis(0),
    samples: 1,
  };
  const { profiles, profile } = enrolProfiles([tom], 'tom', [axis(0)], { context: 'Likes boats.' });
  assert.equal(profiles.length, 1);
  assert.equal(profile.id, 't');
  assert.equal(profile.access, 'owner');
  assert.equal(profile.context, 'Likes boats.');
  assert.equal(profile.samples, 2);
});
