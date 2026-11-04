import { test, expect } from '@playwright/test';

// Todoist: the running delegates strip sat above the composer, apart from the
// other bars. It belongs at the top of the chat, drawn like the task bar.
for (const [name, size] of [
  ['desktop', { width: 1600, height: 900 }],
  ['phone', { width: 390, height: 800 }],
] as const) {
  test(`the running delegates strip is a top bar above the transcript (${name})`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.goto('/app/dev-harness.html?chat=chat_delegate');
    const strip = page.locator('[data-testid="delegate-strip"]');
    await expect(strip).toBeVisible();
    const composer = page.locator('textarea, [contenteditable="true"]').first();
    const stripBox = (await strip.boundingBox())!;
    const composerBox = (await composer.boundingBox())!;
    expect(stripBox.y + stripBox.height).toBeLessThan(composerBox.y);
    expect(stripBox.y).toBeLessThan(size.height / 3);
    await expect(strip.locator('.status-spinner')).toBeVisible();
    const pad = await strip
      .locator('.status-row')
      .first()
      .evaluate((el) => getComputedStyle(el).paddingLeft);
    expect(pad).toBe(size.width < 600 ? '16px' : '28px');
  });
}
