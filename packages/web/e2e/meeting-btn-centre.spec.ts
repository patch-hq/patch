import { test, expect } from '@playwright/test';

// The live (red) Meeting button keeps its waveform icon centred in the button.
test('meeting button icon is centred while a meeting is live', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=chat_tools&meeting=live');
  const btn = page.getByTestId('meeting-btn');
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  const b = (await btn.boundingBox())!;
  const i = (await btn.locator('svg').boundingBox())!;
  expect(Math.abs(b.x + b.width / 2 - (i.x + i.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(b.y + b.height / 2 - (i.y + i.height / 2))).toBeLessThanOrEqual(1);
});
