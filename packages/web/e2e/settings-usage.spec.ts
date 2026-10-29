import { test, expect } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

// spec/10 § Surface in Settings — Usage. One row per shared Claude account
// (spec/01 § Settings); its bars are the freshest reading any host has taken,
// which a host reports on `host.account`. Settings renders each window it HAS as a percentage +
// a human local reset time — never a raw epoch/enum. A window with no reading
// is omitted entirely rather than drawn as a blank/zero placeholder, but the
// row is always present and says the reading has not been taken: the host
// reads every account on its own clock, so there is no button to press.
// Real-browser e2e against the harness, seeding the report via
// `window.__presenceStore` the way the real WS greeting/report would.
const SETTINGS = settingsUrl('usage');

/** A host's reading of shared account `a1`, as its `host.account` report carries it. */
async function reading(page: import('@playwright/test').Page, usage: Record<string, unknown>) {
  await page.evaluate((u) => {
    (
      window as unknown as {
        __presenceStore: {
          getState: () => { setHostAccount: (e: Record<string, unknown>) => void };
        };
      }
    ).__presenceStore
      .getState()
      .setHostAccount({
        type: 'host.account',
        hostId: 'd1',
        backendId: 'claude-code',
        connected: true,
        accountEmail: 'dev@example.com',
        accounts: [
          {
            id: 'a1',
            label: 'Default',
            connected: true,
            accountEmail: 'dev@example.com',
            usage: u,
          },
        ],
      });
  }, usage);
}

test.describe('settings — Claude usage (session/week/reset)', () => {
  test.beforeEach(async ({ page }) => {
    await stubSettingsApi(page, {
      secrets: {
        claude: [{ id: 'a1', label: 'Default', connected: true, email: 'dev@example.com' }],
      },
    });
  });

  // Was "render nothing at all". That left an account too spent to run a turn —
  // and therefore unable to produce an in-turn reading — as a blank area.
  test('says usage has not been read yet, and the ⋯ opens a panel that explains itself', async ({
    page,
  }) => {
    await page.goto(SETTINGS);
    await expect(page.getByTestId('account-claude-code-a1')).toBeVisible();
    await expect(page.getByTestId('account-usage-claude-code-a1-empty')).toContainText(
      /not read yet/i,
    );
    // The row's actions float beside it rather than pushing the list down.
    const before = (await page.getByTestId('account-claude-code-a1').boundingBox())!;
    await page.getByTestId('account-menu-claude-code-a1').click();
    const menu = page.getByTestId('account-menu-claude-code-a1-open');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('account-refresh-claude-code-a1')).toHaveCount(0);
    await expect(page.getByTestId('account-disconnect-claude-code-a1')).toContainText('Sign out');
    await expect(page.getByTestId('account-remove-claude-code-a1')).toContainText(/everywhere/);
    const after = (await page.getByTestId('account-claude-code-a1').boundingBox())!;
    expect(Math.abs(after.height - before.height)).toBeLessThan(2);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    // No window lines at all, for any of the three windows: "not read" and
    // "read as zero" must not look the same. This is the regression the test
    // was written for, so it has to cover every window, not just the first.
    await expect(page.getByTestId('account-usage-session-claude-code-a1')).toHaveCount(0);
    await expect(page.getByTestId('account-usage-week-claude-code-a1')).toHaveCount(0);
    await expect(page.getByTestId('account-usage-overage-claude-code-a1')).toHaveCount(0);
  });

  test('renders session + week usage as a percentage and a local reset time', async ({ page }) => {
    await page.goto(SETTINGS);
    await expect(page.getByTestId('account-claude-code-a1')).toBeVisible();

    const resetsAt = Date.now() + 60 * 60 * 1000; // one hour out, same day
    await reading(page, {
      session: { status: 'allowed_warning', utilization: 0.82, resetsAt: resetsAt },
      week: { status: 'allowed', utilization: 0.31, resetsAt: resetsAt },
    });

    const session = page.getByTestId('account-usage-session-claude-code-a1');
    const week = page.getByTestId('account-usage-week-claude-code-a1');
    await expect(session).toContainText('82%');
    await expect(week).toContainText('31%');
    // Human time, not the raw epoch millis.
    await expect(session).not.toContainText(String(resetsAt));
    await expect(session).toContainText('resets');
  });

  // The window patch used to discard. Its refusal is what Claude Code prints as
  // "You've hit your monthly spend limit", and `org_level_disabled_until` means
  // the extra-usage add-on was never taken out — nothing was overspent. Here
  // the SESSION has genuinely run out, so the account really is blocked; the
  // overage line still explains itself without claiming to be the refusal.
  test('renders the extra-usage window, and explains its reason in words', async ({ page }) => {
    await page.goto(SETTINGS);
    await expect(page.getByTestId('account-claude-code-a1')).toBeVisible();

    await reading(page, {
      session: { status: 'rejected', utilization: 1, resetsAt: Date.now() + 1000 },
      overage: { status: 'rejected', disabledReason: 'org_level_disabled_until' },
      at: Date.now(),
    });

    const overage = page.getByTestId('account-usage-overage-claude-code-a1');
    await expect(overage).toContainText('Extra usage');
    await expect(overage).toContainText('off');
    // Where to turn it on, on the line itself, in place of a reset time.
    const bars = page.getByTestId('account-usage-claude-code-a1');
    await expect(overage).toContainText('Turn on');
    await expect(page.getByTestId('account-extra-usage-settings')).toHaveAttribute(
      'href',
      'https://claude.ai/settings/usage',
    );
    await expect(bars).not.toContainText(/nothing has been overspent/i);
    // One line: the label never wraps.
    const label = overage.locator('.set-bar-label');
    const box = (await label.boundingBox())!;
    expect(box.height).toBeLessThan(30);
    // The session is what stopped the work, and it is the only line that says so.
    await expect(page.getByTestId('account-usage-session-claude-code-a1')).toContainText(
      /blocked/i,
    );
    await expect(overage).not.toContainText(/blocked/i);
    // And the reading says how old it is beside the name, so a stale figure
    // cannot pass for live — without naming the host that took it.
    await expect(page.getByTestId('account-read-claude-code-a1')).toContainText(/just now|ago/);
    await expect(page.getByTestId('account-claude-code-a1')).not.toContainText(/dev-host/);
  });

  // The bug the user reported: their Default account was healthy — Anthropic said
  // `allowed` overall, 5% of the 5-hour pool, 44% of the week — and Settings
  // drew the Extra usage line in red with "· blocked" and a sentence accusing
  // his organisation of switching something off. Extra usage is a paid add-on
  // he never took out; a rejected overage is that account's permanent steady
  // state, so it must read as off, not as a fault (spec/12 § A turn only dies
  // for a reason someone chose).
  test('extra usage being off on a healthy account does not read as blocked', async ({ page }) => {
    await page.goto(SETTINGS);
    await expect(page.getByTestId('account-claude-code-a1')).toBeVisible();

    await reading(page, {
      session: { status: 'allowed', utilization: 0.05 },
      week: { status: 'allowed', utilization: 0.44 },
      overage: { status: 'rejected', disabledReason: 'org_level_disabled_until' },
      at: Date.now(),
    });

    const overage = page.getByTestId('account-usage-overage-claude-code-a1');
    await expect(overage).toBeVisible();
    // Neutral, not the red refusal styling, and not the word "blocked".
    await expect(overage).not.toHaveClass(/\bblocked\b/);
    await expect(overage).toHaveClass(/\boff\b/);
    await expect(overage).not.toContainText(/blocked/i);
    await expect(overage).toContainText('off');
    // And nothing accusing an organisation of anything.
    const bars = page.getByTestId('account-usage-claude-code-a1');
    await expect(bars).not.toContainText(/organisation/i);
    await expect(bars).not.toContainText(/switched off/i);
    await expect(overage).toContainText('Turn on');
    await expect(bars).not.toContainText(/nothing has been overspent/i);
    // The pools that CAN stop work are drawn normally and say nothing is wrong.
    await expect(page.getByTestId('account-usage-session-claude-code-a1')).toContainText('5%');
    await expect(page.getByTestId('account-usage-session-claude-code-a1')).not.toContainText(
      /blocked/i,
    );
    await expect(page.getByTestId('account-usage-week-claude-code-a1')).toContainText('44%');
  });

  test('distinguishes an organisation-disabled extra-usage pool', async ({ page }) => {
    await page.goto(SETTINGS);
    await expect(page.getByTestId('account-claude-code-a1')).toBeVisible();

    await reading(page, {
      session: { status: 'allowed', utilization: 0.05 },
      overage: { status: 'rejected', disabledReason: 'org_level_disabled' },
      at: Date.now(),
    });

    const overage = page.getByTestId('account-usage-overage-claude-code-a1');
    await expect(overage).toContainText('disabled by organisation');
    await expect(overage).not.toContainText('Turn on');
    await expect(page.getByTestId('account-extra-usage-settings')).toHaveCount(0);
  });

  test('a rejected window reads as blocked', async ({ page }) => {
    await page.goto(SETTINGS);
    await expect(page.getByTestId('account-claude-code-a1')).toBeVisible();

    await reading(page, {
      session: { status: 'rejected', utilization: 1, resetsAt: Date.now() + 1000 },
    });

    await expect(page.getByTestId('account-usage-session-claude-code-a1')).toContainText(
      /blocked/i,
    );
    await expect(page.getByTestId('account-usage-week-claude-code-a1')).toHaveCount(0);
  });
});
