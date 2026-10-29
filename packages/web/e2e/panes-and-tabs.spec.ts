import { test, expect, type Page, type Locator } from '@playwright/test';

// spec/14 § Panes and tabs — real-browser e2e for the parts that need actual
// pointer/DataTransfer/localStorage behaviour jsdom can't give: dragging a
// tab (reorder, move to another pane, split onto an edge), dragging a
// divider, persistence across a reload, and the keyboard shortcuts. Click/
// close/activate and the hide-when-trivial rule are covered more cheaply in
// src/__tests__/PaneArea.test.tsx.

const HARNESS = '/app/dev-harness.html?chat=chat_bus';

/** Pane tabs only — the sidebar's own Chats/Batch switch is ALSO `role="tab"`
 *  (spec/14 § Sidebar §1b), so a bare `getByRole('tab')` over-matches. */
function paneTabs(page: Page): Locator {
  return page.locator('.pane-tab');
}

/**
 * Right-click a sidebar row and wait for its context menu. The row is scrolled
 * into view FIRST, and two frames allowed to pass: Playwright's own
 * scroll-into-view inside `click` dispatches its `scroll` event a frame later —
 * after the menu has opened — and the menu correctly closes when the list
 * under it scrolls. Whether the row needs scrolling depends on the sidebar's
 * time-based order, which is why this only failed on some hosts.
 */
async function openRowMenu(page: Page, testId: string): Promise<void> {
  const row = page.getByTestId(testId);
  await row.scrollIntoViewIfNeeded();
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await row.click({ button: 'right' });
  await page.locator('[role="menu"]').waitFor({ state: 'visible' });
}

/** Open a page as a second tab, then split it off to the side through its own
 *  tab's context menu — the way to get two panes now that chats open as groups,
 *  not tabs (spec/14 § Groups). */
async function splitViaTabMenu(page: Page): Promise<void> {
  await page.getByTestId('nav-jobs').click({ button: 'middle' });
  await expect(paneTabs(page)).toHaveCount(2);
  await paneTabs(page).last().click({ button: 'right' });
  await page.getByText('Open to the side').click();
  await expect(page.locator('.pane')).toHaveCount(2);
}

test.describe('panes and tabs — opening', () => {
  test('a sidebar click switches the group’s chat; middle-click shows a chat in a new group', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    // The common case: one group, one pane, one tab — no tab bar, no card.
    await expect(paneTabs(page)).toHaveCount(0);
    await expect(page.locator('.group-card')).toHaveCount(1);

    await page.getByTestId('chat-row-chat_md').click();
    // Still one group and one tab — the click SWITCHED the group's chat, it did
    // not add a tab — and it's the chat just clicked, not the harness's own.
    await expect(paneTabs(page)).toHaveCount(0);
    await expect(page.locator('.chat-head-title .chat-title')).toHaveText('July Seasonal Food');
    // The row click also navigates the router; wait for that to land (the row
    // goes active) so its route effect can't run after the middle-click below
    // and pull focus back to this chat.
    await expect(page.getByTestId('chat-row-chat_md')).toHaveClass(/active/);

    await page.getByTestId('chat-row-chat_table').click({ button: 'middle' });
    await expect(page.locator('.group-card')).toHaveCount(2);
    await expect(paneTabs(page)).toHaveCount(0);
  });

  test('a page opens as a tab: middle-click adds one, and a plain click on it again focuses it rather than duplicating', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.getByTestId('nav-jobs').click({ button: 'middle' });
    await expect(paneTabs(page)).toHaveCount(2);

    await page.getByTestId('nav-jobs').click();
    await expect(paneTabs(page)).toHaveCount(2); // not duplicated
    await expect(paneTabs(page).last()).toHaveAttribute('aria-selected', 'true');
  });

  test('right-click → Open in new group shows the chat beside the focused one; showing it again focuses that group', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await openRowMenu(page, 'chat-row-chat_md');
    await page.getByText('Open in new group').click();
    await expect(page.locator('.group-card')).toHaveCount(2);

    await page.getByTestId('chat-row-chat_bus').click();
    await expect(page.locator('.group-card')).toHaveCount(2); // not duplicated
    await expect(page.locator('.group-card-focused .group-title')).toHaveText('bus-watch');
  });

  test('right-click → Open in new window pops a real window at /chats/:id', async ({ page }) => {
    await page.goto(HARNESS);
    await openRowMenu(page, 'chat-row-chat_md');
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByText('Open in new window').click(),
    ]);
    expect(new URL(popup.url()).pathname).toBe('/app/chats/chat_md');
    await popup.close();
  });
});

test.describe('panes and tabs — drag and drop', () => {
  test('dragging a tab reorders it within the bar', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('nav-jobs').click({ button: 'middle' });
    await page.getByTestId('nav-pads').click({ button: 'middle' });
    const tabs = paneTabs(page);
    await expect(tabs).toHaveCount(3);
    const order = async (): Promise<(string | null)[]> =>
      tabs.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    const before = await order();

    // Drag the LAST tab to the FIRST position.
    await tabs.nth(2).dragTo(tabs.nth(0), { targetPosition: { x: 2, y: 10 } });

    const after = await order();
    expect(after[0]).toBe(before[2]);
    expect(after).not.toEqual(before);
  });

  test('dragging a tab forward onto the right half of the next one lands it there, not at the end', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.getByTestId('nav-jobs').click({ button: 'middle' });
    await page.getByTestId('nav-pads').click({ button: 'middle' });
    const tabs = paneTabs(page);
    await expect(tabs).toHaveCount(3);
    const ids = await tabs.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));

    const second = (await tabs.nth(1).boundingBox())!;
    await tabs.nth(0).dragTo(tabs.nth(1), { targetPosition: { x: second.width - 4, y: 10 } });

    const after = await tabs.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    expect(after).toEqual([ids[1], ids[0], ids[2]]);
  });

  test('dragging a tab onto another pane moves it there', async ({ page }) => {
    await page.goto(HARNESS);
    await splitViaTabMenu(page);
    await expect(page.locator('.pane')).toHaveCount(2);

    const leftPane = page.locator('.pane').first();
    const rightPane = page.locator('.pane').last();
    const leftTab = leftPane.locator('.pane-tab');
    await expect(leftTab).toHaveCount(1);
    await expect(rightPane.locator('.pane-tab')).toHaveCount(1);

    await leftTab.first().dragTo(rightPane.locator('.pane-content').first());

    // The left pane's only tab moved away — closing it collapses the split
    // back to one pane (spec/14 § Panes and tabs — "closing a pane's last
    // tab closes the pane").
    await expect(page.locator('.pane')).toHaveCount(1);
    await expect(paneTabs(page)).toHaveCount(2);
  });

  test('dragging a tab onto a pane edge splits it', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('nav-jobs').click({ button: 'middle' });
    const tabs = paneTabs(page);
    await expect(tabs).toHaveCount(2);

    const content = page.locator('.pane-content').first();
    const box = (await content.boundingBox())!;
    await tabs.last().dragTo(content, {
      // Far right edge of the pane content — inside the 25% "right" drop zone.
      targetPosition: { x: box.width - 10, y: box.height / 2 },
    });

    await expect(page.locator('.pane')).toHaveCount(2);
    // One tab per pane now — still 2 bars (now a second PANE, not just a
    // second tab, has appeared; spec/14 § Panes and tabs shows a bar once
    // there's more than one pane, even with one tab each).
    await expect(paneTabs(page)).toHaveCount(2);
  });

  test('a divider drag resizes the two panes', async ({ page }) => {
    await page.goto(HARNESS);
    await splitViaTabMenu(page);

    const panes = page.locator('.pane');
    const beforeLeft = (await panes.first().boundingBox())!;
    const divider = page.locator('.pane-divider');
    const dBox = (await divider.boundingBox())!;

    await page.mouse.move(dBox.x + dBox.width / 2, dBox.y + dBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dBox.x + 150, dBox.y + dBox.height / 2);
    await page.mouse.up();

    const afterLeft = (await panes.first().boundingBox())!;
    expect(afterLeft.width).toBeGreaterThan(beforeLeft.width + 50);
  });
});

test.describe('panes and tabs — persistence', () => {
  test('the whole layout survives a reload', async ({ page }) => {
    await page.goto(HARNESS);
    await splitViaTabMenu(page);
    await page.getByTestId('nav-pads').click({ button: 'middle' });
    await expect(page.locator('.pane')).toHaveCount(2);
    await expect(paneTabs(page)).toHaveCount(3);

    await page.reload();

    await expect(page.locator('.pane')).toHaveCount(2);
    await expect(paneTabs(page)).toHaveCount(3);
  });
});

test.describe('panes and tabs — keyboard', () => {
  test('⌘W closes the active tab', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('nav-jobs').click({ button: 'middle' });
    await expect(paneTabs(page)).toHaveCount(2);
    await page.keyboard.press('Meta+w');
    await expect(paneTabs(page)).toHaveCount(0); // back to one tab, no bar
  });

  test('⌘⌥→ switches to the next tab', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('nav-jobs').click({ button: 'middle' });
    const tabs = paneTabs(page);
    // The just-opened (second) tab is the active one; switch back to the
    // first before exercising the chord.
    await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
    await tabs.first().click();
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Meta+Alt+ArrowRight');
    await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  });

  test('⌘\\ splits the active pane', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.locator('.pane')).toHaveCount(1);
    await page.keyboard.press('Meta+Backslash');
    await expect(page.locator('.pane')).toHaveCount(2);
  });
});
