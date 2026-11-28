import { describe, expect, test } from 'vitest';
import { powerSpectrum } from '../src/smart-turn.js';

/** The plain DFT the FFT replaces: |X[k]|² for k in [0, 200]. */
function dftPower(frame: Float64Array): Float64Array {
  const n = frame.length;
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k < out.length; k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      re += frame[t]! * Math.cos((2 * Math.PI * k * t) / n);
      im -= frame[t]! * Math.sin((2 * Math.PI * k * t) / n);
    }
    out[k] = re * re + im * im;
  }
  return out;
}

describe('Smart Turn power spectrum', () => {
  test('the FFT gives the plain DFT', () => {
    let seed = 7;
    const rand = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (const make of [
      (i: number) => Math.sin((2 * Math.PI * 37 * i) / 400),
      () => rand(),
      (i: number) => (i === 0 ? 1 : 0),
    ]) {
      const frame = Float64Array.from({ length: 400 }, (_, i) => make(i));
      const want = dftPower(frame);
      const got = new Float64Array(201);
      powerSpectrum(frame, got);
      for (let k = 0; k < 201; k++) expect(got[k]).toBeCloseTo(want[k]!, 6);
    }
  });
});
