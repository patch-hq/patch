import { test, expect } from '@playwright/test';

// Todoist: "patch alignment has broken". A tool row is a padded box (10px) on a
// background that matches the page, so its disclosure glyph sat 10px in from the
// prose above and below it. The box now hangs 10px into the gutter so the glyph
// lines up with the text edge.
test('tool row glyph aligns with the prose edge', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=chat_tools');
  const prose = page.locator('.msg-assistant .content').first();
  const summary = page.locator('.tool-summary').first();
  await expect(prose).toBeVisible();
  await expect(summary).toBeVisible();
  const [p, s] = await Promise.all([prose.boundingBox(), summary.boundingBox()]);
  // glyph sits after the summary's 10px inline padding
  expect(Math.abs(s!.x + 10 - p!.x)).toBeLessThanOrEqual(1);
});
