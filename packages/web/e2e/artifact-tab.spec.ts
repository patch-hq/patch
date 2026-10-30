import { test, expect } from '@playwright/test';

// spec/14 § Artifacts — an artifact opens as a tab in the chat's group: a tab
// in the chat's pane in a group of 1,400 px or less, a pane beside the chat in
// a wider one. Its slim address row has back, forward, reload, the title and
// file, and open-in-browser.

const HARNESS = '/app/dev-harness.html?chat=chat_artifact';
const PAGE_URL = '**/api/chats/chat_artifact/artifact/art001*';

test.beforeEach(async ({ page }) => {
  await page.route(PAGE_URL, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p id="p">hello artifact</p>' }),
  );
});

test('a card click opens a tab in the chat pane; no new browser tab', async ({ page, context }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto(HARNESS);
  await page.getByTestId('artifact-card').click();

  await expect(page.locator('.pane-tab')).toHaveCount(2);
  await expect(page.locator('.pane-tab[aria-selected="true"]')).toContainText('Bus times');
  await expect(page.getByTestId('artifact-pane-address')).toContainText('out/buses.html');
  await expect(page.getByTestId('artifact-pane-back')).toBeDisabled();
  await expect(page.getByTestId('artifact-pane-forward')).toBeDisabled();
  await expect(page.getByTestId('artifact-pane-reload')).toBeVisible();
  await expect(page.getByTestId('artifact-pane-external')).toBeVisible();
  await expect(page.frameLocator('[data-testid="artifact-pane-frame"]').locator('#p')).toHaveText(
    'hello artifact',
  );
  expect(context.pages()).toHaveLength(1);
  // One pane only.
  await expect(page.getByTestId('artifact-pane')).toHaveCount(1);
});

test('reload fetches the page again', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto(HARNESS);
  await page.getByTestId('artifact-card').click();
  await expect(page.getByTestId('artifact-pane-frame')).toBeVisible();
  const again = page.waitForRequest(/artifact\/art001/);
  await page.getByTestId('artifact-pane-reload').click();
  await again;
});

test('in a group wider than 1,400px it opens in a pane beside the chat', async ({ page }) => {
  await page.setViewportSize({ width: 1900, height: 900 });
  await page.goto(HARNESS);
  await page.getByTestId('artifact-card').click();

  const artifact = page.getByTestId('artifact-pane');
  await expect(artifact).toBeVisible();
  // The chat is still visible beside it, not hidden behind a tab.
  await expect(page.getByTestId('artifact-card')).toBeVisible();
  const a = (await artifact.boundingBox())!;
  const c = (await page.getByTestId('artifact-card').boundingBox())!;
  expect(a.x).toBeGreaterThan(c.x);
  await expect(page.locator('.pane-tab')).toHaveCount(2);
  await expect(page.locator('.pane')).toHaveCount(2);
});
