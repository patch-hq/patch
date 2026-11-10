import { test, expect } from '@playwright/test';

// Every desktop page header (chat, new chat, Jobs, the job editor, Settings) shares one
// height (--page-head-height) and Back/Forward sit on its centre-line, so they are at the
// same place within the header on every screen. Absolute x/y is deliberately not compared:
// a grouped chat or route sits inside the group card (title + tab bar), which offsets the
// whole header, and the group card insets it horizontally.
const SCREENS = ['chat=chat_bus', 'chat=new', 'route=/jobs', 'route=/jobs/new', 'route=/settings'];

test('Back/Forward sit at the same place in the header on every screen', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const seen: { screen: string; headHeight: number; centreY: number }[] = [];
  for (const screen of SCREENS) {
    await page.goto(`/app/dev-harness.html?${screen}`);
    const back = page.getByTestId('nav-back').first();
    await back.waitFor();
    const m = await back.evaluate((el) => {
      const head =
        el.closest('.chat-head') ?? el.closest('.route-head') ?? el.closest('.route-head-title');
      if (!head) return null;
      const h = head.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return { headHeight: h.height, centreY: b.y + b.height / 2 - h.y };
    });
    expect(m, screen).not.toBeNull();
    seen.push({ screen, ...m! });
  }
  for (const s of seen) {
    expect(
      Math.abs(s.headHeight - seen[0]!.headHeight),
      `${s.screen} header height`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(s.centreY - seen[0]!.centreY),
      `${s.screen} Back centre-line`,
    ).toBeLessThanOrEqual(1);
  }
});
