import { test, expect } from '@playwright/test';

// Every desktop page header (chat, new chat, Jobs, the job editor, Settings) shares one
// height (--page-head-height) and Back/Forward sit on its centre-line, so they are at the
// same place within the header on every screen. Absolute x/y is deliberately not compared:
// a grouped chat or route sits inside the group card (title + tab bar), which offsets the
// whole header, and the group card insets it horizontally.
const SCREENS = ['chat=chat_bus', 'chat=new', 'route=/jobs/new', 'route=/settings'];
// The Jobs list is named by its tab and carries a compact toolbar instead of a page head, so it
// is deliberately shorter than the others: it only has to keep Back centred in its own bar.
const COMPACT_SCREENS = ['route=/jobs'];

test('Back/Forward sit at the same place in the header on every screen', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const seen: { screen: string; headHeight: number; centreY: number }[] = [];
  const compact: { screen: string; headHeight: number; centreY: number }[] = [];
  for (const screen of [...SCREENS, ...COMPACT_SCREENS]) {
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
    (COMPACT_SCREENS.includes(screen) ? compact : seen).push({ screen, ...m! });
  }
  for (const s of compact) {
    expect(Math.abs(s.centreY - s.headHeight / 2), `${s.screen} Back centred`).toBeLessThanOrEqual(
      1,
    );
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
