import { describe, expect, it } from 'vitest';
import { MockVad, DEFAULT_VAD_CONFIG } from '../src/audio/vad.js';
import { clipHasSpeech } from '../src/meetingSpeechGate.js';

const wav = (amp: number, seconds: number): Buffer => {
  const n = 16000 * seconds;
  const b = Buffer.alloc(44 + n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 2 ? amp : -amp, 44 + i * 2);
  return b;
};

describe('clipHasSpeech', () => {
  const th = DEFAULT_VAD_CONFIG.startTh;
  it('rejects digital silence and low background noise', async () => {
    expect(await clipHasSpeech(wav(0, 3), new MockVad(), th)).toBe(false);
    expect(await clipHasSpeech(wav(300, 3), new MockVad(), th)).toBe(false);
  });
  it('accepts a clip with speech-level audio', async () => {
    expect(await clipHasSpeech(wav(5000, 1), new MockVad(), th)).toBe(true);
  });
  it('rejects a click shorter than the minimum', async () => {
    const b = wav(0, 2);
    for (let i = 0; i < 480; i++) b.writeInt16LE(i % 2 ? 6000 : -6000, 44 + i * 2);
    expect(await clipHasSpeech(b, new MockVad(), th)).toBe(false);
  });
});
