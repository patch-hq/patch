import { test, expect } from '@playwright/test';

// spec/14 § Composer — a long message in a composer that is drawing chips must
// stay readable: the chip mirror paints the text over a transparent textarea,
// so once the textarea scrolls (past the height cap) the mirror has to scroll
// with it and wrap at the same width, or the visible text is clipped and the
// caret line is out of sight (Todoist 6hpMXjw684whFPW6).

const CHAT = '/app/dev-harness.html?chat=chat_skill';

test('chip mirror scrolls and wraps with the textarea on a long message', async ({ page }) => {
  await page.route('**/api/skills**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        skills: ['plant'],
        paths: { plant: '/x/plant/SKILL.md' },
        descriptions: { plant: 'Sow.' },
        frontmatter: { plant: { name: 'plant', description: 'Sow.', 'user-invocable': 'true' } },
      }),
    }),
  );
  await page.goto(CHAT);
  const input = page.getByTestId('composer-input');
  const long = Array.from(
    { length: 60 },
    (_, i) => `line ${i + 1} https://example.com/${'x'.repeat(60)}`,
  ).join('\n');
  await input.fill(`/plant ${long}`);
  const mirror = page.getByTestId('composer-chip-mirror');
  await expect(mirror).toBeVisible();
  await input.evaluate((el: HTMLTextAreaElement) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
  });
  const m = await page.evaluate(() => {
    const t = document.querySelector<HTMLTextAreaElement>('[data-testid=composer-input]')!;
    const c = document.querySelector<HTMLElement>('[data-testid=composer-chip-mirror]')!;
    return {
      ta: t.scrollTop,
      th: t.scrollHeight,
      mh: c.scrollHeight,
      tc: t.clientHeight,
      mc: c.clientHeight,
      mirror: c.scrollTop,
      taWidth: t.clientWidth,
      mirrorTextWidth:
        c.clientWidth -
        parseFloat(getComputedStyle(c).paddingLeft) -
        parseFloat(getComputedStyle(c).paddingRight),
      taTextWidth:
        t.clientWidth -
        parseFloat(getComputedStyle(t).paddingLeft) -
        parseFloat(getComputedStyle(t).paddingRight),
    };
  });
  expect(m.ta).toBeGreaterThan(0);
  expect(Math.abs(m.mirror - m.ta)).toBeLessThan(2);
  expect(Math.abs(m.mirrorTextWidth - m.taTextWidth)).toBeLessThan(1.5);
});
