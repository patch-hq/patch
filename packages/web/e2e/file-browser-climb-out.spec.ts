import { test, expect } from '@playwright/test';

// Editor overhaul — climb out of the repo (spec/14 § File browser): open
// without a chat, the breadcrumb reaching `/` from a chat, Places, and the
// host-wide editor tab genuinely mounting Monaco over the harness's host-files
// stub (dev-harness.tsx's `/api/hosts/` branch). Logic coverage (version
// guard, conflicts, ⌘P, ⌘⇧F) lives in HostFilesPage.test.tsx — these
// specs are for what only a real browser can prove: the sidebar button is
// genuinely clickable, the breadcrumb/Places menu render and respond to real
// clicks, and the editor that opens over a climbed-out file is a real,
// editable Monaco instance.

const MONACO_MOUNT = { timeout: 20_000 };

async function stubSidebarApis(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/chats/folders**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ folders: [] }),
    }),
  );
  await page.route('**/api/chats/counts**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hidden: 0, archived: 0, snoozed: 0, deleted: 0, automations: 0 }),
    }),
  );
}

test.describe('file browser — open without a chat', () => {
  test('the sidebar Files button opens the host-wide browser at its home directory', async ({
    page,
  }) => {
    await stubSidebarApis(page);
    // Land on a real chat first (the harness's normal entry point), then
    // navigate to Settings IN-APP — same as a person clicking the sidebar —
    // so `activeChatId` genuinely clears the way it would for them, rather
    // than a synthetic `?route=` jump that bypasses that navigation.
    await page.goto('/app/dev-harness.html?chat=chat_bus&editor=browse');
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-route')).toBeVisible();

    await page.getByTestId('nav-files').click();

    await expect(page.getByTestId('nav-files')).toHaveClass(/active/);
    await expect(page.getByTestId('host-browse-panel')).toBeVisible();
    await expect(page.getByTestId('browse-breadcrumb-current')).toHaveText('tom');
    await expect(page.getByTestId('host-browse-entry-projects')).toBeVisible();
  });
});

test.describe('file browser — climb out of a chat folder', () => {
  const HARNESS = '/app/dev-harness.html?chat=chat_bus&editor=browse';

  test('the breadcrumb runs to /, and a crumb above the chat folder opens the host browser there', async ({
    page,
  }) => {
    await stubSidebarApis(page);
    await page.goto(HARNESS);

    const crumbs = page.locator('[data-testid^="browse-breadcrumb-crumb-"]');
    await expect(crumbs.first()).toHaveText('/');
    await expect(page.getByTestId('browse-breadcrumb-current')).toHaveText('bus');

    await page.getByTestId('browse-breadcrumb-crumb-/home/tom/projects').click();

    await expect(page.getByTestId('host-browse-panel')).toBeVisible();
    await expect(page.getByTestId('host-browse-entry-portfolio')).toBeVisible();
  });

  test('Places → Skills opens and edits a real Monaco editor over a host file', async ({
    page,
  }) => {
    await stubSidebarApis(page);
    await page.goto(HARNESS);

    await page.getByTestId('browse-places-toggle').click();
    await expect(page.getByTestId('browse-places-menu')).toBeVisible();
    await page.getByTestId('browse-place-Skills').click();

    await expect(page.getByTestId('host-browse-entry-plant')).toBeVisible();
    await page.getByTestId('host-browse-entry-plant').click();
    await page.getByTestId('host-browse-entry-SKILL.md').click();

    const editorPane = page.getByTestId('host-browse-editor');
    const monaco = editorPane.locator('.monaco-editor').first();
    await expect(monaco).toBeVisible(MONACO_MOUNT);
    await expect(editorPane).toContainText('Sow what is in season', MONACO_MOUNT);

    await monaco.click();
    await page.keyboard.type(' more');
    await expect(page.getByTestId('host-browse-save')).toBeEnabled();
  });
});
