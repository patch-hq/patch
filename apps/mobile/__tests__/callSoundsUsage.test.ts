// The call's sounds follow the call's route, Bluetooth headset included
// (spec/07 § Call sounds): they play with the same audio usage the call's own
// playback and microphone use, and ask for no audio focus. Kotlin cannot run
// under Node, so this reads the sources.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const native = join(__dirname, '..', 'plugins', 'native');
const usage = (file: string): string[] =>
  [
    ...readFileSync(join(native, file), 'utf8').matchAll(/\.setUsage\(AudioAttributes\.(\w+)\)/g),
  ].map((m) => m[1] as string);

describe('call sounds audio usage', () => {
  it("is the call's usage, the one PcmPlayer plays the call with", () => {
    expect(usage('PatchCallSoundsModule.kt')).toEqual(['USAGE_VOICE_COMMUNICATION']);
    expect(usage('PcmPlayer.kt')).toContain('USAGE_VOICE_COMMUNICATION');
  });

  it('requests no audio focus', () => {
    expect(readFileSync(join(native, 'PatchCallSoundsModule.kt'), 'utf8')).not.toMatch(
      /requestAudioFocus|AudioFocusRequest\.Builder\(/,
    );
  });
});
