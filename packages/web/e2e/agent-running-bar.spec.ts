import { test, expect } from '@playwright/test';

// Todoist: show that an agent is running just above the input bar, as a round
// cornered bar that matches the input box, not obtrusive.
for (const [name, size] of [
  ['desktop', { width: 1600, height: 900 }],
  ['phone', { width: 390, height: 800 }],
] as const) {
  test(`a running agent shows a slim bar directly above the input (${name})`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/app/dev-harness.html?chat=chat_delegate');
    const bar = page.locator('[data-testid="agent-running-bar"]');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('running');
    const input = page.locator('textarea.composer-input').first();
    const b = (await bar.boundingBox())!;
    const i = (await input.boundingBox())!;
    // Sits right above the input, aligned to it, and slim.
    expect(i.y - (b.y + b.height)).toBeLessThan(40);
    expect(i.y).toBeGreaterThan(b.y);
    expect(Math.abs(b.x - i.x)).toBeLessThan(2);
    expect(Math.abs(b.width - i.width)).toBeLessThan(2);
    expect(b.height).toBeLessThan(36);
    const radius = await bar.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    const inputRadius = await input.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    expect(radius).toBe(inputRadius);
    await page.screenshot({ path: `/tmp/agentbar-${name}.png` });
  });
}
