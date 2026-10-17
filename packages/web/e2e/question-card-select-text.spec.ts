import { test, expect } from '@playwright/test';

// App Updates: "patch text in questions should be selectable on drag, as well
// as click the whole thing". Real browser only: whether a drag across an
// option's text makes a selection is the browser's own behaviour, and a
// <button> never allows it.
const HARNESS = '/app/dev-harness.html?chat=chat_question';

test.describe('question option text', () => {
  test('dragging across an option label selects its text without choosing it', async ({ page }) => {
    await page.goto(HARNESS);
    const option = page.getByTestId('question-option').filter({ hasText: 'Luxon' }).first();
    const label = option.locator('.question-option-label');
    const box = (await label.boundingBox())!;
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();

    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('Lux');
    await expect(option).toHaveAttribute('data-selected', 'false');
  });

  test('clicking anywhere on the option still chooses it', async ({ page }) => {
    await page.goto(HARNESS);
    const option = page.getByTestId('question-option').filter({ hasText: 'Luxon' }).first();
    const box = (await option.boundingBox())!;
    await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
    await expect(option).toHaveAttribute('data-selected', 'true');
  });
});
