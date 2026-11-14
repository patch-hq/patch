import { test, expect } from '@playwright/test';

// Todoist: "patch - the new go to top feature ... only appear when the user's
// behaviour suggests they are trying to go far ... navigation dots with
// dates/times as markers".

test.use({ viewport: { width: 1000, height: 700 } });

test('the rail is absent in a long chat until the reader scrolls a long way up', async ({
  page,
}) => {
  await page.goto('/app/dev-harness.html?chat=chat_long_history');
  const stream = page.locator('.chat-stream');
  await expect(stream).toBeVisible();
  const rail = page.getByTestId('scroll-rail');

  await stream.hover();
  await page.mouse.wheel(0, -300);
  await expect(rail).toHaveCount(0);

  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -400);
  await expect(rail).toBeVisible();
  const stops = page.getByTestId('scroll-rail-stop');
  expect(await stops.count()).toBeGreaterThan(2);
  await expect(stops.nth(1)).toContainText(/\d+ \w{3}/);
});

test('the first stop lands on the first message; a dated stop lands on its turn', async ({
  page,
}) => {
  await page.goto('/app/dev-harness.html?chat=chat_long_history');
  const stream = page.locator('.chat-stream');
  await expect(stream).toBeVisible();
  await stream.hover();
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -400);
  const stops = page.getByTestId('scroll-rail-stop');
  await expect(stops.first()).toBeVisible();

  await stops.nth(3).click();
  await expect.poll(async () => stream.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);

  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -400);
  await stops.first().click();
  await expect(page.getByText('history line 0 —')).toBeVisible();

  await page.getByTestId('scroll-to-bottom').click();
  await expect(page.getByText('history line 399 —')).toBeVisible();
  await expect(page.getByTestId('scroll-rail')).toHaveCount(0);
});
