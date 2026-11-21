import { test, expect } from '@playwright/test';

// Round-7 blocker: on a fresh Mac the picker's folder list was squashed to zero
// height, so no folder could be seen or opened. The list must keep real height
// and show the home folder's subfolders at any window height.
const NEW = '/app/dev-harness.html?chat=new';
const NAMES = ['Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures'];

for (const height of [900, 640, 480]) {
  test(`browse list shows the home subfolders at ${height}px tall`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height });
    await page.route('**/api/folders/browse**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          hostId: 'd1',
          dir: '/Users/tom',
          parent: '/Users',
          entries: NAMES.map((name) => ({ name, path: `/Users/tom/${name}` })),
        }),
      }),
    );
    await page.goto(NEW);
    await page.getByTestId('new-chat-folder-pill').click();
    const desktop = page.getByTestId('folder-browser-entry-Desktop');
    await expect(desktop).toBeVisible();
    const m = await page.getByTestId('folder-popup-body').evaluate((el) => {
      const list = el.querySelector('.folder-browser-list') as HTMLElement;
      const head = el.querySelector('.folder-browser-bar') as HTMLElement;
      const body = el.getBoundingClientRect();
      const first = list.querySelector('li')!.getBoundingClientRect();
      return {
        body: body.height,
        list: list.getBoundingClientRect().height,
        listScroll: list.scrollHeight,
        headClipped: head.getBoundingClientRect().height < head.scrollHeight - 1,
        firstRowInsideBody: first.height > 0,
      };
    });
    expect(Math.abs(m.list - m.listScroll)).toBeLessThan(1);
    expect(m.body).toBeGreaterThanOrEqual(100);
    expect(m.headClipped).toBe(false);
    expect(m.firstRowInsideBody).toBe(true);
    // The first row can be reached and opened.
    await desktop.scrollIntoViewIfNeeded();
    await expect(desktop).toBeInViewport();
    await desktop.click();
  });
}
