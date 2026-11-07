import { test, expect } from '@playwright/test';

// A message ending in a newline (or blank lines) in a composer drawing chips:
// the textarea gives the trailing newline its own empty line, so the chip mirror
// has to as well, or its text sits a row away from the caret once the field
// scrolls (Todoist 6hwpWHvH64WpwFXc "cursor sometimes in wrong place").

const CHAT = '/app/dev-harness.html?chat=chat_skill';

test('chip mirror is as tall as the textarea when the text ends in a newline', async ({ page }) => {
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
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1} words words words`);
  await input.fill(`/plant ${lines.join('\n')}\n`);
  await expect(page.getByTestId('composer-chip-mirror')).toBeVisible();
  await input.evaluate((el: HTMLTextAreaElement) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
  });
  const m = await page.evaluate(() => {
    const t = document.querySelector<HTMLTextAreaElement>('[data-testid=composer-input]')!;
    const c = document.querySelector<HTMLElement>('[data-testid=composer-chip-mirror]')!;
    return { ta: t.scrollTop, th: t.scrollHeight, mirror: c.scrollTop, mh: c.scrollHeight };
  });
  expect(m.ta).toBeGreaterThan(0);
  expect(Math.abs(m.mh - m.th)).toBeLessThan(2);
  expect(Math.abs(m.mirror - m.ta)).toBeLessThan(2);
});
