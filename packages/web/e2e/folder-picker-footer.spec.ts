import { test, expect } from '@playwright/test';

// The picker's list scrolls on its own; Use this folder / New folder stay
// visible however long the list is, and the scrollbar is drawn.
const NEW = '/app/dev-harness.html?chat=new';
const SHOTS = process.env['FP_SHOTS'];

test('footer stays visible with a long list and the list scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.route('**/api/folders/browse**', (r) => {
    const dir = new URL(r.request().url()).searchParams.get('dir');
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hostId: 'd1',
        dir: dir ?? '/Users/tom',
        parent: '/Users',
        entries: Array.from({ length: 30 }, (_, i) => ({
          name: `Folder ${i}`,
          path: `/Users/tom/Folder ${i}`,
        })),
      }),
    });
  });
  await page.goto(NEW);
  await page.getByTestId('new-chat-folder-pill').click();
  const popup = page.getByTestId('folder-popup');
  const body = page.getByTestId('folder-popup-body');
  const footer = page.getByTestId('folder-popup-footer');
  await expect(footer).toBeVisible();
  await expect(page.getByTestId('folder-browser-use')).toBeInViewport();
  await expect(page.getByTestId('folder-browser-new')).toBeInViewport();
  const m = await body.evaluate((el) => ({
    scrolls: el.scrollHeight > el.clientHeight,
    bar: el.offsetWidth - el.clientWidth,
  }));
  expect(m.scrolls).toBe(true);
  expect(m.bar).toBeGreaterThan(0);
  const pb = (await popup.boundingBox())!;
  const fb = (await footer.boundingBox())!;
  expect(fb.y + fb.height).toBeLessThanOrEqual(pb.y + pb.height + 1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/picker.png` });
});
