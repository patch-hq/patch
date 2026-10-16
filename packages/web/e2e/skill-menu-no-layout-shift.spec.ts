import { test, expect } from '@playwright/test';

// Todoist: "patch skill window is causing the new chat stuff to bounce
// around". The `/` skill list opened in normal flow above the input, so on the
// new-chat screen it grew the composer and shoved the centred heading and chips
// upward — and again every time the list filtered to a different height. The
// list must float over the page instead.
const NEW = '/app/dev-harness.html?chat=new';

test.describe('skill menu floats over the new-chat screen', () => {
  test('opening and filtering the menu leaves the new-chat content where it was', async ({
    page,
  }) => {
    await page.route('**/api/skills*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ skills: ['plant', 'plan-travel', 'deploy', 'buy', 'sync', 'prod'] }),
      }),
    );
    await page.goto(NEW);
    const content = page.getByTestId('new-chat-setup');
    const input = page.getByTestId('composer-input');
    await expect(content).toBeVisible();
    const before = await content.boundingBox();
    const inputBefore = await input.boundingBox();

    await input.fill('/');
    await expect(page.getByTestId('composer-skill-menu')).toBeVisible();
    expect(await content.boundingBox()).toEqual(before);
    expect(await input.boundingBox()).toEqual(inputBefore);

    await input.fill('/pl');
    await expect(page.locator('.composer-skill-option')).toHaveCount(3);
    expect(await content.boundingBox()).toEqual(before);
    expect(await input.boundingBox()).toEqual(inputBefore);

    // Still sits directly above the input, not off-screen.
    const menu = await page.getByTestId('composer-skill-menu').boundingBox();
    expect(menu!.y + menu!.height).toBeLessThanOrEqual(inputBefore!.y);
    expect(menu!.y).toBeGreaterThanOrEqual(0);
  });
});
