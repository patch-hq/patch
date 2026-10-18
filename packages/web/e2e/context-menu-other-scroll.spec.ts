import { test, expect } from '@playwright/test';

// A sidebar row's context menu closes when the list under it scrolls (it is
// anchored to a point), but not when some OTHER scroller moves — the chat
// transcript pinning itself to the bottom as a reply streams in. Closing on
// that pulled the menu out from under the user.

test('a row menu survives the transcript scrolling, and closes when the sidebar list does', async ({
  page,
}) => {
  await page.goto('/app/dev-harness.html?chat=chat_bus');
  const row = page.getByTestId('chat-row-chat_md');
  // Settle Playwright's scroll-into-view first: its scroll event lands a frame
  // late and would (rightly) close the menu.
  await row.scrollIntoViewIfNeeded();
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await row.click({ button: 'right' });
  const menu = page.locator('[role="menu"]');
  await expect(menu).toBeVisible();

  const scrollOutsideSidebar = await page.evaluate(() => {
    const sidebarRow = document.querySelector('[data-testid="chat-row-chat_md"]')!;
    const el = Array.from(document.querySelectorAll<HTMLElement>('*')).find(
      (n) =>
        n.scrollHeight > n.clientHeight + 10 &&
        getComputedStyle(n).overflowY !== 'visible' &&
        !n.contains(sidebarRow),
    );
    if (!el) return false;
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
    return true;
  });
  expect(scrollOutsideSidebar).toBe(true);
  await expect(menu).toBeVisible();
  await expect(page.getByText('Open to the side')).toBeVisible();

  await page.evaluate(() => {
    document.querySelector('[data-testid="chat-row-chat_md"]')!.dispatchEvent(new Event('scroll'));
  });
  await expect(menu).toHaveCount(0);
});
