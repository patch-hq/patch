import { test, expect, type Page } from '@playwright/test';

// spec/14 § Groups, § Panes and tabs — dragging tabs and chat rows between
// groups, the right-click menus and the searchable + menu, in a real browser
// (native drag-and-drop, hit testing, focus).

const HARNESS = '/app/dev-harness.html?chat=chat_bus';

// Wide enough that three groups sit side by side (each is at least 420px).
test.use({ viewport: { width: 1800, height: 900 } });

const groups = (page: Page) => page.locator('.group-card');

/** Move the held pointer to (x, y) and nudge it once more: Chromium only
 *  delivers `dragover` to the element under a pointer that is moving. */
async function dragTo(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.move(x + 1, y + 1);
  await page.mouse.move(x, y);
}

/** Show a second chat in a group of its own beside the first. */
async function twoGroups(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await page.getByTestId('chat-row-chat_md').click({ button: 'middle' });
  await expect(groups(page)).toHaveCount(2);
}

test.describe('tabs 5/5 — dragging a tab', () => {
  test('shows split and add-as-tab targets on the pane while dragging, the hovered one hot', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.getByTestId('nav-jobs').click({ button: 'middle' });
    await expect(page.locator('.pane-tab')).toHaveCount(2);
    await expect(page.getByTestId('pane-droptargets')).toHaveCount(0);

    const content = page.locator('.pane-content').first();
    const tab = page.locator('.pane-tab').last();
    const tb = (await tab.boundingBox())!;
    await page.mouse.move(tb.x + 20, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + 40, tb.y + 80, { steps: 4 });
    // Measured once the drag has started: the gap slot has narrowed the group.
    await expect(page.getByTestId('pane-droptargets')).toBeVisible();
    const box = (await content.boundingBox())!;
    await dragTo(page, box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('.pane-dz.hot')).toHaveText('Add as tab');
    await dragTo(page, box.x + box.width - 20, box.y + box.height / 2);
    await expect(page.locator('.pane-dz.hot')).toHaveText('Split right');
    await page.mouse.up();
    await expect(page.locator('.pane')).toHaveCount(2);
    await expect(page.getByTestId('pane-droptargets')).toHaveCount(0);
  });

  test('dropping a tab into the gap past the last group makes a new group for the same chat', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.getByTestId('nav-jobs').click({ button: 'middle' });
    await expect(page.locator('.pane-tab')).toHaveCount(2);
    const tab = page.locator('.pane-tab').last();
    const tb = (await tab.boundingBox())!;
    await page.mouse.move(tb.x + 20, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + 60, tb.y + 120, { steps: 5 });
    const gap = page.locator('.gap-drop').last();
    await expect(gap).toBeVisible();
    const gb = (await gap.boundingBox())!;
    await dragTo(page, gb.x + gb.width / 2, gb.y + gb.height / 2);
    await expect(gap).toHaveClass(/hot/);
    await page.mouse.up();
    await expect(groups(page)).toHaveCount(2);
    await expect(groups(page).nth(1).locator('.pane-tab')).toHaveCount(1);
    await expect(groups(page).nth(0).locator('.pane-tab')).toHaveCount(1);
  });

  test('a tab cannot be dropped into a group showing a different chat', async ({ page }) => {
    await twoGroups(page);
    // Put a second tab in the focused (second) group, then try dragging it onto the first group.
    await page.getByTestId('nav-jobs').click({ button: 'middle' });
    const second = groups(page).nth(1);
    await expect(second.locator('.pane-tab')).toHaveCount(2);
    const tab = second.locator('.pane-tab').last();
    const tb = (await tab.boundingBox())!;
    await page.mouse.move(tb.x + 20, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + 40, tb.y + 80, { steps: 4 });
    const t2 = (await groups(page).nth(0).locator('.pane-content').first().boundingBox())!;
    await dragTo(page, t2.x + t2.width / 2, t2.y + t2.height / 2);
    // The other chat's group offers no target…
    await expect(groups(page).nth(0).getByTestId('pane-droptargets')).toHaveCount(0);
    await page.mouse.up();
    // …and nothing moved.
    await expect(groups(page).nth(0).locator('.pane-tab')).toHaveCount(1);
    await expect(second.locator('.pane-tab')).toHaveCount(2);
  });
});

test.describe('tabs 5/5 — dragging a chat row', () => {
  test('onto a group makes that group show the chat', async ({ page }) => {
    await twoGroups(page);
    const row = page.getByTestId('chat-row-chat_table');
    const rb = (await row.boundingBox())!;
    await page.mouse.move(rb.x + 40, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(rb.x + 60, rb.y + 80, { steps: 4 });
    await expect(groups(page).nth(0).locator('.gdrop')).toBeVisible();
    const first = (await groups(page).nth(0).boundingBox())!;
    await dragTo(page, first.x + first.width / 2, first.y + first.height / 2);
    const zone = groups(page).nth(0).locator('.gdrop .z');
    await expect(zone).toHaveText('Show here');
    await expect(zone).toHaveClass(/hot/);
    await page.mouse.up();
    await expect(groups(page)).toHaveCount(2);
    await expect(groups(page).nth(0).getByTestId('chat-title')).toHaveText('Tea prices');
  });

  test('into the gap between groups makes a new group for it', async ({ page }) => {
    await twoGroups(page);
    const row = page.getByTestId('chat-row-chat_table');
    const rb = (await row.boundingBox())!;
    await page.mouse.move(rb.x + 40, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(rb.x + 400, rb.y + 100, { steps: 6 });
    const gap = page.getByTestId('gap-drop-1');
    await expect(gap).toBeVisible();
    const gb = (await gap.boundingBox())!;
    await dragTo(page, gb.x + gb.width / 2, gb.y + gb.height / 2);
    await page.mouse.up();
    await expect(groups(page)).toHaveCount(3);
    await expect(groups(page).nth(1).getByTestId('chat-title')).toHaveText('Tea prices');
  });
});

test.describe('tabs 5/5 — menus', () => {
  test('a sidebar row menu offers Open here, Open in new group and Open in new window', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-chat_md');
    await row.scrollIntoViewIfNeeded();
    await row.click({ button: 'right' });
    const menu = page.getByRole('menu');
    const items = await menu.getByRole('menuitem').allTextContents();
    expect(items.slice(0, 3)).toEqual(['Open here', 'Open in new group', 'Open in new window']);
    await menu.getByRole('menuitem', { name: 'Open here' }).click();
    await expect(groups(page)).toHaveCount(1);
    await expect(page.getByTestId('chat-title')).toHaveText('July Seasonal Food');
  });

  test('a chat tab’s menu has no “Open to the side”; a page tab’s still does', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('nav-jobs').click({ button: 'middle' });
    await page.locator('.pane-tab').first().click({ button: 'right' });
    const chatItems = await page.getByRole('menu').getByRole('menuitem').allTextContents();
    expect(chatItems).toEqual([
      'Open here',
      'Open in new group',
      'Open in new window',
      'Close tab',
    ]);
    await page.keyboard.press('Escape');
    await page.locator('.pane-tab').last().click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Open to the side' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Open in new group' }).click();
    await expect(groups(page)).toHaveCount(2);
  });

  test('the + menu is searchable and groups this chat’s things, other chats and pages', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.locator('.pane-tab-new').first().click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('searchbox')).toBeFocused();
    await expect(menu.locator('.context-menu-section').last()).toHaveText('Pages');
    await expect(menu.getByText('Chats', { exact: true })).toBeVisible();
    for (const label of ['Terminal', 'Files', 'Browser', 'Pads', 'Jobs', 'Settings'])
      await expect(menu.getByRole('menuitem', { name: label, exact: true })).toBeVisible();

    await page.keyboard.type('seas');
    const names = await menu.getByRole('menuitem').allTextContents();
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => /seas/i.test(n))).toBe(true);

    // Choosing another chat switches this group to it.
    await menu.getByRole('menuitem').first().click();
    await expect(groups(page)).toHaveCount(1);
    await expect(page.locator('.pane-tab')).toHaveCount(1);
    await expect(page.getByTestId('chat-title')).toHaveText('July Seasonal Food');
  });

  test('a sidebar click focuses the most recently used of two groups showing the same chat', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    // Two groups showing the same chat (bus), then a third showing another.
    const bus = page.getByTestId('chat-row-chat_bus');
    await bus.scrollIntoViewIfNeeded();
    await bus.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open in new group' }).click();
    await page.getByTestId('chat-row-chat_md').click({ button: 'middle' });
    await expect(groups(page)).toHaveCount(3);
    // Focus the first group, then the last, then the first again.
    await groups(page).nth(0).locator('.pane-tab').first().click();
    await groups(page).nth(2).locator('.pane-tab').first().click();
    await groups(page).nth(0).locator('.pane-tab').first().click();
    await groups(page).nth(1).locator('.pane-tab').first().click();
    await page.getByTestId('chat-row-chat_bus').click();
    await expect(groups(page).nth(1)).toHaveAttribute('data-focused', 'true');
  });
});

test('a lone tab in the only pane can be dragged onto its own edge to split it', async ({
  page,
}) => {
  await page.goto(HARNESS);
  await expect(page.locator('.pane-tab')).toHaveCount(1);
  const tab = page.locator('.pane-tab').first();
  await expect(tab).toHaveAttribute('draggable', 'true');
  const tb = (await tab.boundingBox())!;
  await page.mouse.move(tb.x + 20, tb.y + tb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + 40, tb.y + 80, { steps: 4 });
  await expect(page.getByTestId('pane-droptargets')).toBeVisible();
  const box = (await page.locator('.pane-content').first().boundingBox())!;
  await dragTo(page, box.x + box.width - 20, box.y + box.height / 2);
  await expect(page.locator('.pane-dz.hot')).toHaveText('Split right');
  await page.mouse.up();
  await expect(page.locator('.pane')).toHaveCount(2);
  await expect(page.locator('.pane').last().locator('.pane-tab')).toHaveCount(1);
});
