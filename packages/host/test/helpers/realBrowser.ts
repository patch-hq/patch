// Suites that drive the product's REAL Chromium.
//
// BrowserManager is non-headless by design (src/browser.ts: "honest by
// design"), so on a Linux host it hides in Xvfb. A Mac has no virtual display:
// the browser opens on the user's own screen and steals focus for the whole
// run. Anyone — human or agent — running `vitest` there got a browser window
// taking over the screen.
//
// So these suites run only where the browser can be hidden (Linux). Elsewhere
// they are skipped, and listed as skipped rather than silently passing.
// PATCH_TEST_VISIBLE_BROWSER=1 opts in knowingly, at a desk.
import { describe } from 'vitest';

export const canHideRealBrowser =
  process.platform === 'linux' || process.env['PATCH_TEST_VISIBLE_BROWSER'] === '1';

export const describeRealBrowser = describe.skipIf(!canHideRealBrowser);
