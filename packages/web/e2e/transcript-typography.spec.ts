import { test, expect } from '@playwright/test';

// Real-browser e2e for the design-cleanup pass (spec/14 § Type): the transcript
// reads as ONE prose font — markdown headings use the body font, not Fraunces
// serif — and a model-emitted `---` is a quiet, low-opacity divider. `chat_md`
// is seeded with a heading/rule reply in the harness.
const MD = '/app/dev-harness.html?chat=chat_md';

test.describe('transcript typography', () => {
  test('markdown headings render in the body font, NOT Fraunces serif', async ({ page }) => {
    await page.goto(MD);
    const heading = page.locator('.msg-assistant .content h2').first();
    await expect(heading).toBeVisible();
    const bodyFont = await page
      .locator('.msg-assistant .content p')
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
    const headingFont = await heading.evaluate((el) => getComputedStyle(el).fontFamily);
    // The heading must not switch to the serif display face mid-message…
    expect(headingFont.toLowerCase()).not.toContain('fraunces');
    // …it uses the SAME family as the surrounding prose.
    expect(headingFont).toBe(bodyFont);
  });

  test('a model-emitted --- renders as a quiet, low-opacity divider', async ({ page }) => {
    await page.goto(MD);
    const hr = page.locator('.msg-assistant .content hr').first();
    await expect(hr).toBeVisible();
    const opacity = await hr.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBeLessThanOrEqual(0.6);
  });

  // todo: "font too small" — the base body size read small at
  // 16px. It floors at 17px now so the transcript prose is comfortably readable.
  test('the base body font is slightly bigger — at least 17px', async ({ page }) => {
    await page.goto(MD);
    const bodyFontSize = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.body).fontSize),
    );
    expect(bodyFontSize).toBeGreaterThanOrEqual(17);
    // Assistant prose inherits the base size, so it lifts too.
    const proseFontSize = await page
      .locator('.msg-assistant .content p')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(proseFontSize).toBeGreaterThanOrEqual(17);
  });

  // todo: "font too small" — tool rows and their expanded detail sat well
  // under the prose, so the transcript read small.
  test('tool rows are close to prose size', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_tools');
    const row = page
      .locator('.tool-call:not(.compaction):not(.trigger):not(.system-context), .tool-group')
      .first();
    if ((await row.count()) === 0) throw new Error('harness chat_tools has no tool row');
    const size = await row.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(16);
  });
});
