import { test, expect } from '@playwright/test';

// spec/05 § Desktop packaging → Window chrome. A tab detached into its own
// window (`/tab-window`) has no native title bar, so the tab bar is the top row
// and the macOS traffic lights float over it. The tab titles must start right of
// the lights. The bare route is not mounted by the dev harness, so this injects
// the route's real markup (TabWindowRoute → PaneArea class names) into the
// harness page, which carries the real stylesheet.

const LIGHTS_RIGHT_EDGE = 70;
const LIGHTS_CENTRE = 37;

async function mountTabWindow(page: import('@playwright/test').Page, overlay: boolean) {
  await page.goto('/app/dev-harness.html?chat=thread_manager');
  await page.evaluate((overlayTitleBar) => {
    document.documentElement.classList.toggle('overlay-titlebar', overlayTitleBar);
    const host = document.createElement('div');
    host.setAttribute('data-testid', 'tab-window');
    host.className = 'editor-window';
    host.style.cssText = 'position:fixed;inset:0;z-index:9999';
    host.innerHTML =
      '<div class="pane pane-focused"><div class="pane-tab-bar">' +
      '<div class="pane-tab active"><span class="pane-tab-title">Settings</span></div>' +
      '<div class="pane-tab-bar-fill"></div></div></div>';
    document.body.appendChild(host);
  }, overlay);
}

test.describe('tab window title bar', () => {
  test('in the desktop shell the first tab clears the traffic lights and sits on their centre-line', async ({
    page,
  }) => {
    await mountTabWindow(page, true);
    const tab = (await page.locator('[data-testid=tab-window] .pane-tab').boundingBox())!;
    const title = (await page.locator('[data-testid=tab-window] .pane-tab-title').boundingBox())!;
    expect(title.x).toBeGreaterThanOrEqual(LIGHTS_RIGHT_EDGE);
    expect(Math.abs(tab.y + tab.height / 2 - LIGHTS_CENTRE)).toBeLessThanOrEqual(1);
  });

  test('in a plain browser the tab bar is untouched', async ({ page }) => {
    await mountTabWindow(page, false);
    const tab = (await page.locator('[data-testid=tab-window] .pane-tab').boundingBox())!;
    expect(tab.x).toBeLessThan(LIGHTS_RIGHT_EDGE);
    // The Chrome-shaped tab sits on the bar's bottom edge, 7px below its top.
    expect(tab.y).toBeLessThan(8);
  });
});
