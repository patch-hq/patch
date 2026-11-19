import { describe, expect, it } from 'vitest';
import {
  addVoiceSample,
  DEFAULT_SHARED_SETTINGS,
  identifyVoice,
  SharedSettingsPatch,
  VOICE_MATCH_THRESHOLD,
  VOICEPRINT_DIM,
  voiceSimilarity,
  type VoiceProfile,
} from '../src/index.js';

/** A unit vector pointing mostly along axis `i`, with a little of axis `j`. */
function vec(i: number, j = (i + 1) % VOICEPRINT_DIM, lean = 0): number[] {
  const v = new Array<number>(VOICEPRINT_DIM).fill(0);
  v[i] = 1;
  v[j] = lean;
  return v;
}

function profile(id: string, voiceprint: number[] | undefined): VoiceProfile {
  return {
    id,
    name: id,
    access: 'owner',
    context: '',
    samples: voiceprint ? 1 : 0,
    ...(voiceprint ? { voiceprint } : {}),
  };
}

describe('voice profiles', () => {
  it('recognises the closest enrolled voice', () => {
    const tom = profile('tom', vec(0));
    const eleanor = profile('eleanor', vec(5));
    const m = identifyVoice(vec(0, 1, 0.3), [eleanor, tom]);
    expect(m.profile?.id).toBe('tom');
    expect(m.score).toBeGreaterThan(VOICE_MATCH_THRESHOLD);
  });

  it('recognises nobody when no voice is close enough', () => {
    const m = identifyVoice(vec(9), [profile('tom', vec(0)), profile('eleanor', vec(5))]);
    expect(m.profile).toBeNull();
  });

  it('refuses a match two profiles share almost equally', () => {
    const a = vec(0, 1, 0.98);
    const b = vec(1, 0, 0.98);
    const heard = vec(0, 1, 1);
    const m = identifyVoice(heard, [profile('a', a), profile('b', b)]);
    expect(m.profile).toBeNull();
  });

  it('never matches a profile with no voiceprint yet', () => {
    expect(identifyVoice(vec(0), [profile('tom', undefined)]).profile).toBeNull();
  });

  it('averages samples into a unit-length voiceprint', () => {
    const one = addVoiceSample(undefined, 0, vec(0));
    const two = addVoiceSample(one, 1, vec(1));
    expect(voiceSimilarity(two, vec(0))).toBeCloseTo(Math.SQRT1_2, 3);
    expect(voiceSimilarity(two, vec(1))).toBeCloseTo(Math.SQRT1_2, 3);
    expect(Math.hypot(...two)).toBeCloseTo(1, 4);
  });

  it('defaults to no profiles and the built-in spoken-aloud prompt', () => {
    expect(DEFAULT_SHARED_SETTINGS.voiceProfiles).toEqual([]);
    expect(DEFAULT_SHARED_SETTINGS.voiceDevicePrompt).toMatch(/out loud/);
  });

  it('accepts a profile in a settings patch and rejects a wrong-length voiceprint', () => {
    expect(SharedSettingsPatch.safeParse({ voiceProfiles: [profile('tom', vec(0))] }).success).toBe(
      true,
    );
    expect(
      SharedSettingsPatch.safeParse({ voiceProfiles: [profile('tom', [1, 0, 0])] }).success,
    ).toBe(false);
  });
});
