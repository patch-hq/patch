// The launcher icon is a solid green circle ("Patch mobile make icon circular
// green"). An adaptive icon is masked to whatever shape the launcher uses
// (squircle, rounded square...), so a circle can only be guaranteed by the
// artwork itself: an opaque green disc on a transparent foreground, with no
// background layer of its own for the mask to fill the corners with.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import config from '../app.config';
import { decodeRgba } from './stubs/png';

const ROOT = join(__dirname, '..');
const RES = join(ROOT, 'android', 'app', 'src', 'main', 'res');
const DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
const GREEN = [0x3a, 0x5e, 0x2c];

function at(img: ReturnType<typeof decodeRgba>, x: number, y: number) {
  const i = (Math.floor(y) * img.width + Math.floor(x)) * 4;
  return [...img.px.slice(i, i + 4)];
}

function expectGreenDisc(file: string) {
  const img = decodeRgba(file);
  const c = img.width / 2;
  // Disc centre-left of the glyph is plain green; the four corners and the
  // edge midpoints of the canvas are transparent.
  expect(at(img, c * 0.6, c).slice(0, 3)).toEqual(GREEN);
  expect(at(img, c * 0.6, c)[3]).toBe(255);
  for (const [x, y] of [
    [1, 1],
    [img.width - 2, 1],
    [1, img.height - 2],
    [img.width - 2, img.height - 2],
    [c, 1],
    [1, c],
  ]) {
    expect(at(img, x!, y!)[3]).toBe(0);
  }
  // Circular, not square: a point on the diagonal past the radius is clear,
  // and one just inside it is opaque green.
  const r = img.width * 0.34;
  const d = Math.SQRT1_2;
  expect(at(img, c + (r + img.width * 0.02) * d, c + (r + img.width * 0.02) * d)[3]).toBe(0);
  expect(
    at(img, c + (r - img.width * 0.03) * d, c + (r - img.width * 0.03) * d).slice(0, 3),
  ).toEqual(GREEN);
}

describe('launcher icon', () => {
  it('config foreground is a green disc on transparent', () => {
    const fg = config.android?.adaptiveIcon?.foregroundImage;
    expect(fg).toBeTruthy();
    expectGreenDisc(join(ROOT, fg!));
  });

  it('adaptive icon has no opaque background layer', () => {
    const bg = config.android?.adaptiveIcon?.backgroundColor;
    expect(bg === undefined || /^#[0-9a-f]{6}00$/i.test(bg)).toBe(true);
    const colors = readFileSync(join(RES, 'values', 'colors.xml'), 'utf8');
    expect(colors).toMatch(/<color name="iconBackground">#00000000<\/color>/);
  });

  for (const d of DENSITIES) {
    it(`committed ${d} foreground is a green disc on transparent`, () => {
      expectGreenDisc(join(RES, `mipmap-${d}`, 'ic_launcher_foreground.png'));
    });
  }
});
