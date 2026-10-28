import { test, expect } from '@playwright/test';

// spec/14 § Groups and § Panes and tabs — the look: a group is a bordered card
// whose header is the chat header (Files / Browser / Editor / Terminal that
// collapse to icons when narrow), and every pane's tab row is Chrome-shaped.

const HARNESS = '/app/dev-harness.html?chat=chat_bus';

test('a lone chat is a card with a 1px border, a group header and a tab row', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(HARNESS);
  const card = page.locator('.group-card').first();
  await expect(card).toBeVisible();
  expect(await card.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px');
  expect(
    await card.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius)),
  ).toBeGreaterThan(0);

  const head = card.getByTestId('chat-head');
  await expect(head).toHaveClass(/chat-head-group/);
  await expect(card.getByTestId('chat-head')).toHaveCount(1);
  for (const id of ['files', 'browser', 'editor', 'terminal']) {
    await expect(card.getByTestId(`group-tool-${id}`)).toBeVisible();
  }
  // Wide: the buttons carry their labels.
  await expect(card.getByTestId('group-tool-terminal').locator('.group-tool-label')).toBeVisible();

  // The tab row is there for a single chat tab, header above it.
  const tab = card.locator('.pane-tab').first();
  await expect(tab).toBeVisible();
  const headBox = (await head.boundingBox())!;
  const tabBox = (await tab.boundingBox())!;
  expect(tabBox.y).toBeGreaterThan(headBox.y + headBox.height - 1);
});

test('tabs are Chrome-shaped: rounded top, accent on the active tab of the focused pane, a + at the end', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(HARNESS);
  // The + menu opens ordinary tabs in this pane; the header buttons place
  // theirs in panes of their own (spec/14 § Opening things).
  for (const label of ['Terminal', 'Browser']) {
    await page.locator('.pane-tab-new').click();
    await page.locator('[role="menu"]').getByText(label, { exact: true }).click();
  }
  const tabs = page.locator('.pane-tab');
  await expect(tabs).toHaveCount(3);
  const active = page.locator('.pane-tab.active');
  const radius = await active.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  expect(parseFloat(radius)).toBeGreaterThan(0);
  const shadow = await active.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow).not.toBe('none');
  // A close button on each, and the + after the last tab.
  await expect(page.locator('.pane-tab .pane-tab-close')).toHaveCount(3);
  const last = (await tabs.last().boundingBox())!;
  const plus = (await page.locator('.pane-tab-new').boundingBox())!;
  expect(plus.x).toBeGreaterThan(last.x + last.width - 1);
  // Inactive tab separator: a faint line drawn before it.
  const sep = await tabs.nth(1).evaluate((el) => getComputedStyle(el, '::before').width);
  expect(sep).toBe('1px');
});

test('the header buttons collapse to icons when the group is narrow', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(HARNESS);
  const label = page.getByTestId('group-tool-terminal').locator('.group-tool-label');
  await expect(label).toBeVisible();
  await page
    .locator('.group-card')
    .first()
    .evaluate((el) => {
      (el as HTMLElement).style.width = '520px';
      (el as HTMLElement).style.flex = '0 0 520px';
    });
  await expect(label).toBeHidden();
  await expect(page.getByTestId('group-tool-terminal')).toBeVisible();
});

test('the focused group border is tinted with the accent', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto(HARNESS);
  const card = page.locator('.group-card').first();
  const border = await card.evaluate((el) => getComputedStyle(el).borderTopColor);
  const accent = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--accent-soft)';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(border).toBe(accent);
});
