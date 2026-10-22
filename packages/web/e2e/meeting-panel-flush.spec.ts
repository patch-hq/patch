import { test, expect } from '@playwright/test';

// The notes panel is flush: no box, border or inset around the write-up.
test('meeting notes panel has no box around the summary', async ({ page }) => {
  await page.goto('/app/dev-harness.html?chat=chat_tools&meeting=ended');
  const panel = page.getByTestId('meeting-panel');
  const sum = page.getByTestId('meeting-summary');
  await expect(sum).toBeVisible();
  const p = (await panel.boundingBox())!;
  const s = (await sum.boundingBox())!;
  const st = await sum.evaluate((el) => {
    const c = getComputedStyle(el);
    return {
      bg: c.backgroundColor,
      bw:
        parseFloat(c.borderTopWidth) +
        parseFloat(c.borderLeftWidth) +
        parseFloat(c.borderRightWidth),
    };
  });
  expect(st.bg).toBe('rgba(0, 0, 0, 0)');
  expect(st.bw).toBe(0);
  expect(s.x - p.x).toBeLessThanOrEqual(12);
  expect(p.x + p.width - (s.x + s.width)).toBeLessThanOrEqual(12);
});
