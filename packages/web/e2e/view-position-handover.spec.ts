import { test, expect, type Page } from '@playwright/test';

// spec/05 § Handover × spec/14 § Groups — what the phone last looked at is
// what the desktop opens on, through the group/tab layout the desktop already
// has, and the Settings switch turns it off.

test.use({ viewport: { width: 1800, height: 900 } });

const HARNESS = '/app/dev-harness.html?chat=chat_bus&viewsync=1';
const groups = (page: Page) => page.locator('.group-card');

type Pos = { page: string; id?: string; seq?: number; surfaceId: string; updatedAt: number };

async function phoneReports(page: Page, pos: Omit<Pos, 'surfaceId' | 'updatedAt'>): Promise<void> {
  await page.evaluate((p) => {
    const w = window as unknown as {
      __viewPositionStore: {
        getState: () => { applyUpdated: (p: Pos, own: string | null) => void };
      };
    };
    w.__viewPositionStore
      .getState()
      .applyUpdated({ ...p, surfaceId: 'phone', updatedAt: Date.now() }, 'desk');
    // The desktop window coming back to the front is when a position is taken
    // up — never while the user is mid-use.
    window.dispatchEvent(new Event('focus'));
  }, pos);
}

async function setSync(page: Page, on: boolean): Promise<void> {
  await page.evaluate((v) => {
    const w = window as unknown as {
      __preferencesStore: {
        getState: () => { preferences: object };
        setState: (s: unknown) => void;
      };
    };
    const st = w.__preferencesStore.getState();
    w.__preferencesStore.setState({
      loaded: true,
      preferences: { ...st.preferences, syncPosition: v },
    });
  }, on);
}

test('the phone’s chat opens in the focused group, leaving the other group alone', async ({
  page,
}) => {
  await page.goto(HARNESS);
  await setSync(page, true);
  await page.getByTestId('chat-row-chat_md').click({ button: 'middle' });
  await expect(groups(page)).toHaveCount(2);
  await page.getByTestId('chat-row-chat_md').click(); // md group is focused

  await phoneReports(page, { page: 'chat', id: 'chat_scroll' });

  await expect(groups(page)).toHaveCount(2);
  await expect(page.locator('.group-card-focused')).toContainText('scroll');
});

test('a chat another group already shows is focused, not duplicated', async ({ page }) => {
  await page.goto(HARNESS);
  await setSync(page, true);
  await page.getByTestId('chat-row-chat_md').click({ button: 'middle' });
  await expect(groups(page)).toHaveCount(2);

  await phoneReports(page, { page: 'chat', id: 'chat_bus' });

  await expect(groups(page)).toHaveCount(2);
  await expect(groups(page).first()).toHaveClass(/group-card-focused/);
});

test('a page the phone was on opens as a tab, replacing the active one like a plain click', async ({
  page,
}) => {
  await page.goto(HARNESS);
  await setSync(page, true);
  await phoneReports(page, { page: 'jobs' });
  await expect(page.locator('.pane-tab')).toHaveCount(1);
  await expect(page.locator('.pane-tab')).toContainText('Jobs');
});

test('with the setting off the phone’s position is ignored', async ({ page }) => {
  await page.goto(HARNESS);
  await setSync(page, false);
  await phoneReports(page, { page: 'jobs' });
  await page.waitForTimeout(500);
  await expect(page.locator('.pane-tab')).toHaveCount(1);
  await expect(page.locator('.pane-tab')).not.toContainText('Jobs');
});
