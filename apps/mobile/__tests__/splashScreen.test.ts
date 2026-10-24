// The Android cold-start splash (Todoist: "Patch startup screen has edges cut
// off"). Android 12+'s SplashScreen API masks the splash icon to a circle
// 192dp across, centred in a 288dp canvas, whatever shape the image is. The
// logo is the full-bleed adaptive-icon square, so any of it further than 96dp
// from the centre — its corners first — is cut off.
//
// Two halves, because the config is not what ships: `expo prebuild` renders
// `imageWidth` into the committed `splashscreen_logo.png` drawables, and it is
// those the APK carries. So the config must fit the circle AND every committed
// drawable must actually have been rendered from it.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import config from '../app.config';
import { decodeRgba } from './stubs/png';

const CANVAS_DP = 288;
const MASK_RADIUS_DP = 96;
const RES = join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

function splashImageWidth(): number {
  const entry = (config.plugins ?? []).find(
    (p) => Array.isArray(p) && p[0] === 'expo-splash-screen',
  ) as [string, { imageWidth: number }] | undefined;
  if (!entry) throw new Error('app.config has no expo-splash-screen plugin entry');
  return entry[1].imageWidth;
}

/** The logo's extent, in dp, as painted over the flat background. */
function logoExtent(file: string): { maxRadiusDp: number; widthDp: number } {
  const { width, height, px } = decodeRgba(file);
  const dpPerPx = CANVAS_DP / width;
  const bg = px.subarray(0, 4);
  let maxRadius = 0;
  let minX = width;
  let maxX = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let diff = 0;
      for (let k = 0; k < 4; k++) diff += Math.abs(px[i + k]! - bg[k]!);
      if (diff <= 40) continue;
      maxRadius = Math.max(maxRadius, Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2));
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  }
  return { maxRadiusDp: maxRadius * dpPerPx, widthDp: (maxX - minX + 1) * dpPerPx };
}

const drawables = readdirSync(RES)
  .filter((d) => d.startsWith('drawable-'))
  .flatMap((d) =>
    readdirSync(join(RES, d))
      .filter((f) => f === 'splashscreen_logo.png')
      .map((f) => join(d, f)),
  );

describe('Android cold-start splash fits the SplashScreen mask', () => {
  it('the configured logo size keeps its corners inside the 192dp circle', () => {
    const half = splashImageWidth() / 2;
    expect(Math.hypot(half, half)).toBeLessThanOrEqual(MASK_RADIUS_DP);
  });

  it('there is a committed splash drawable for every density', () => {
    expect(drawables.length).toBeGreaterThanOrEqual(5);
  });

  it.each(drawables)('%s was rendered from that size and fits the circle', (file) => {
    const { maxRadiusDp, widthDp } = logoExtent(join(RES, file));
    expect(maxRadiusDp).toBeLessThanOrEqual(MASK_RADIUS_DP);
    expect(Math.abs(widthDp - splashImageWidth())).toBeLessThanOrEqual(2);
  });
});
