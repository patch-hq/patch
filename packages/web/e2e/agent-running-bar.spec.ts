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

test('one agent carries pause, stop and open-as-chat; several fold to a count', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/app/dev-harness.html?chat=chat_delegate');
  for (const id of ['agent-pause', 'agent-stop', 'agent-spin-off']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  const bar = page.getByTestId('agent-running-bar');
  await expect(bar).toContainText('Sonnet 5.5');
  expect((await bar.boundingBox())!.height).toBeLessThan(40);
  await page.screenshot({ path: '/tmp/agentbar-controls-one.png' });

  await page.goto('/app/dev-harness.html?chat=chat_status');
  await expect(page.getByTestId('agent-running-bar')).toContainText('3 agents running');
  await expect(page.getByTestId('agent-stop')).toHaveCount(0);
  await page.getByTestId('agent-running-bar-toggle').click();
  await expect(page.getByTestId('agent-running-row')).toHaveCount(3);
  await expect(page.getByTestId('agent-running-row').first()).toContainText('Opus 5.5');
  await page.screenshot({ path: '/tmp/agentbar-controls-many.png' });
});
