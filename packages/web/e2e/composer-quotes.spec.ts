import { test, expect } from '@playwright/test';

// spec/14 § Composer — quotes: leading `> ` blocks of a chat's draft are cards
// stacked ABOVE the prompt input, and the input holds only what is typed.
// Real browser + real components (dev harness, no backend).
const HARNESS = '/app/dev-harness.html';
const CACHE_KEY = 'patch.composer-drafts-cache.v1';

test('quotes stack as cards above the prompt input and can be removed', async ({ page }) => {
  await page.goto(HARNESS);
  const first = await page
    .locator('.sb-folder [data-testid^="chat-row-"]')
    .first()
    .getAttribute('data-testid')
    .then((t) => t!.replace('chat-row-', ''));
  await page.evaluate(
    ([key, chat]) =>
      window.localStorage.setItem(
        key!,
        JSON.stringify({
          [chat!]: '> first quote\n\n> second quote\n> over two lines\n\nmy question',
        }),
      ),
    [CACHE_KEY, first],
  );
  await page.goto(`${HARNESS}?chat=${first}`);

  const input = page.getByTestId('composer-input');
  await expect(input).toHaveValue('my question');
  const cards = page.getByTestId('composer-quote');
  await expect(cards).toHaveCount(2);

  const inputBox = (await input.boundingBox())!;
  const lastCard = (await cards.nth(1).boundingBox())!;
  expect(lastCard.y + lastCard.height).toBeLessThanOrEqual(inputBox.y);
  const firstCard = (await cards.nth(0).boundingBox())!;
  expect(firstCard.y).toBeLessThan(lastCard.y);

  await page.getByTestId('composer-quote-remove').first().click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('second quote');
  await expect(input).toHaveValue('my question');
});
