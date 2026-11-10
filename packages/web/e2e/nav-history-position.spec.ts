import { test, expect } from '@playwright/test';

// Back / Forward sit at the same x and y on every desktop screen: chat, new chat,
// Jobs, the job editor and Settings all share one header height (--page-head-height).
const SCREENS = ['chat=chat_bus', 'chat=new', 'route=/jobs', 'route=/jobs/new', 'route=/settings'];

test('Back/Forward are at one position on every screen', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const seen: { screen: string; x: number; y: number }[] = [];
  for (const screen of SCREENS) {
    await page.goto(`/app/dev-harness.html?${screen}`);
    const box = await page.getByTestId('nav-back').first().boundingBox();
    expect(box, screen).not.toBeNull();
    seen.push({ screen, x: box!.x, y: box!.y + box!.height / 2 });
  }
  for (const s of seen) {
    expect(Math.abs(s.x - seen[0]!.x), s.screen).toBeLessThanOrEqual(1);
    expect(Math.abs(s.y - seen[0]!.y), s.screen).toBeLessThanOrEqual(1);
  }
});
