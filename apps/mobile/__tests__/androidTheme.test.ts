// The native Android window must follow the OS colour scheme, not just the JS.
//
// AppTheme was fixed Light with no night variant, and MainActivity handles the
// `uiMode` change itself (no recreate), so after a dark -> light switch the
// window background and status bar kept the dark values: the app looked broken
// even though JS theming flipped correctly. JS tests cannot see that, so these
// read the native sources.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { darkColors, lightColors } from '../src/lib/theme';

const MAIN = fileURLToPath(new URL('../android/app/src/main', import.meta.url));
const read = (p: string) => readFileSync(join(MAIN, p), 'utf8');
const colour = (xml: string, name: string) =>
  new RegExp(`<color name="${name}">([^<]+)</color>`).exec(xml)?.[1]?.toLowerCase();

describe('android native theme follows the OS colour scheme', () => {
  it('AppTheme derives from a DayNight parent and uses scheme-resolved colours', () => {
    const styles = read('res/values/styles.xml');
    expect(styles).toMatch(/name="AppTheme" parent="Theme\.AppCompat\.DayNight\.NoActionBar"/);
    expect(styles).toContain('@color/window_background');
    expect(styles).toContain('@color/status_bar');
    expect(styles).toContain('@bool/light_system_bars');
  });

  it('has day and night values for window background and status bar matching the JS palettes', () => {
    expect(existsSync(join(MAIN, 'res/values-night/colors.xml'))).toBe(true);
    const day = read('res/values/colors.xml');
    const night = read('res/values-night/colors.xml');
    expect(colour(day, 'window_background')).toBe(lightColors.paper);
    expect(colour(day, 'status_bar')).toBe(lightColors.paper);
    expect(colour(night, 'window_background')).toBe(darkColors.paper);
    expect(colour(night, 'status_bar')).toBe(darkColors.paper);
    expect(read('res/values/bools.xml')).toMatch(/name="light_system_bars">true</);
    expect(read('res/values-night/bools.xml')).toMatch(/name="light_system_bars">false</);
  });

  it('MainActivity re-applies window background and status bar when uiMode changes', () => {
    const kt = read('java/io/github/tomchambers2/patch/MainActivity.kt');
    expect(kt).toMatch(/override fun onConfigurationChanged/);
    expect(kt).toContain('R.color.window_background');
    expect(kt).toContain('R.color.status_bar');
    expect(kt).toContain('R.bool.light_system_bars');
  });
});
