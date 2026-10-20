import { test, expect } from '@playwright/test';

// Real-browser check for spec/14 § Message links: a message link carries a
// Summarise button; clicking it fetches a summary (stubbed here) and renders it
// inline without navigating away. `chat_link_preview` seeds one
// assistant message with a single link — see dev-harness.tsx.
const HARNESS = '/app/dev-harness.html?chat=chat_link_preview';
const MESSAGE_LINK = 'a[href="https://example.com/foraging-guide"]:not([data-testid])';

test.describe('a message link carries an inline Summarise button', () => {
  test('clicking the button fetches and shows the summary inline', async ({ page }) => {
    let body: unknown;
    await page.route('**/api/link-summary', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          url: 'https://example.com/foraging-guide',
          summary: 'Start with the hedgerows in early autumn.',
        }),
      });
    });
    await page.goto(HARNESS);

    const link = page.locator(MESSAGE_LINK);
    await expect(link).toBeVisible();
    const toggle = page.locator('[data-testid="link-summary-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(page.locator('[data-testid="link-summary-card"]')).toHaveCount(0);

    await toggle.click();

    const card = page.locator('[data-testid="link-summary-card"]');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('link-summary-text')).toHaveText(
      'Start with the hedgerows in early autumn.',
    );
    await expect(card).toContainText('example.com');
    expect(body).toEqual({ url: 'https://example.com/foraging-guide' });

    // The link itself still points at the real target.
    await expect(link).toHaveAttribute('href', 'https://example.com/foraging-guide');

    await toggle.click();
    await expect(card).toHaveCount(0);
  });

  test('a failed summary shows an error, not a silent blank card', async ({ page }) => {
    await page.route('**/api/link-summary', async (route) => {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'summary_failed', message: 'overloaded' }),
      });
    });
    await page.goto(HARNESS);

    await page.locator('[data-testid="link-summary-toggle"]').click();

    const card = page.locator('[data-testid="link-summary-card"]');
    await expect(card).toBeVisible();
    // rest.ts's error path surfaces the response body's `error` code.
    await expect(card).toContainText('summary_failed');
  });

  // "…also add an external browser button icon to the right so its easy to
  // open in desktop browser". A target=_blank open is what the desktop shell's
  // link policy hands to the OS browser (packages/desktop/src/link-policy.ts
  // routeWindowOpen); a plain click on the link itself goes to Patch's own
  // panel instead.
  test('an open-in-browser icon sits to the right of the link', async ({ page }) => {
    await page.goto(HARNESS);

    const link = page.locator(MESSAGE_LINK);
    const toggle = page.locator('[data-testid="link-summary-toggle"]');
    const external = page.locator('[data-testid="link-preview-external"]');
    await expect(external).toBeVisible();
    await expect(external).toHaveAttribute('href', 'https://example.com/foraging-guide');
    await expect(external).toHaveAttribute('target', '_blank');

    const linkBox = await link.boundingBox();
    const toggleBox = await toggle.boundingBox();
    const externalBox = await external.boundingBox();
    if (!linkBox || !toggleBox || !externalBox) throw new Error('link controls have no box');
    // After the link and after the summary button, on the link's own line.
    expect(externalBox.x).toBeGreaterThanOrEqual(linkBox.x + linkBox.width - 1);
    expect(externalBox.x).toBeGreaterThanOrEqual(toggleBox.x + toggleBox.width - 1);
    const mid = (b: { y: number; height: number }): number => b.y + b.height / 2;
    expect(Math.abs(mid(externalBox) - mid(linkBox))).toBeLessThan(linkBox.height);

    // It opens a new page (the real browser, on desktop) rather than
    // navigating this one.
    const [popup] = await Promise.all([page.waitForEvent('popup'), external.click()]);
    expect(popup.url()).toContain('example.com/foraging-guide');
    expect(page.url()).toContain('dev-harness.html');
  });

  // Todoist: "patch preview doesnt work" — opening a preview threw the link's
  // line out of order: the wrap was an inline-block holding the card, so the
  // link lined up with the card's last line and the icons sat on a line above
  // it. The icons must stay on the link's line and the card open below it.
  test('opening the summary keeps the icons on the link line and the card below', async ({
    page,
  }) => {
    await page.route('**/api/link-summary', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'https://example.com/foraging-guide', summary: 'Jira' }),
      });
    });
    await page.goto(HARNESS);
    const link = page.locator(MESSAGE_LINK);
    const toggle = page.locator('[data-testid="link-summary-toggle"]');
    await toggle.click();
    const card = page.locator('[data-testid="link-summary-card"]');
    await expect(card).toBeVisible();

    const linkBox = await link.boundingBox();
    const toggleBox = await toggle.boundingBox();
    const cardBox = await card.boundingBox();
    if (!linkBox || !toggleBox || !cardBox) throw new Error('missing box');
    const mid = (b: { y: number; height: number }): number => b.y + b.height / 2;
    expect(Math.abs(mid(toggleBox) - mid(linkBox))).toBeLessThan(linkBox.height);
    expect(cardBox.y).toBeGreaterThanOrEqual(linkBox.y + linkBox.height - 1);
  });
});
