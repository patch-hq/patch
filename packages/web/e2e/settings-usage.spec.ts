import { test, expect } from '@playwright/test';
import {
  addSecondHost,
  reportHost,
  setHostAccount,
  settingsUrl,
  stubSettingsApi,
} from './settingsHarness.js';

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

  test('shows when an account is estimated to run out', async ({ page }) => {
    await page.goto(SETTINGS);
    await expect(page.getByTestId('account-claude-code-a1')).toBeVisible();
    const now = Date.now();
    await reading(page, {
      session: {
        status: 'allowed',
        utilization: 0.6,
        resetsAt: now + 3 * 3_600_000,
        runsOutAt: now + 40 * 60_000,
      },
      week: { status: 'allowed', utilization: 0.4, resetsAt: now + 3 * 86_400_000 },
    });
    await expect(page.getByTestId('account-usage-session-claude-code-a1')).toContainText(
      'runs out ~',
    );
    await expect(page.getByTestId('account-usage-week-claude-code-a1')).not.toContainText(
      'runs out',
    );
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
    await expect(overage).toContainText('not available on this plan');
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

// Claude on Amazon Bedrock and the Auto column (spec/10 § Choosing an account,
// § Settings; spec/14 § Credit sources).
test.describe('settings — Auto and Amazon Bedrock accounts', () => {
  const month = new Date().toISOString().slice(0, 7);
  const bedrock = (hostId: string, awsProfile: string, awsRegion: string) => ({
    hostId,
    awsProfile,
    awsRegion,
    regionPrefix: 'auto',
    monthlyCapUsd: 100,
    spentUsd: 18.42,
    spentMonth: month,
  });
  const ACCOUNTS = {
    claude: [
      { id: 'a1', label: 'Personal', connected: true, email: 'me@example.com' },
      { id: 'a2', label: 'Max', connected: true, email: 'max@example.com' },
      {
        id: 'b1',
        label: 'Work Bedrock',
        connected: true,
        auto: false,
        bedrock: bedrock('d1', 'work-bedrock', 'eu-west-2'),
      },
      {
        id: 'b2',
        label: 'Client X',
        connected: false,
        auto: false,
        bedrock: bedrock('d2', 'client-x', 'us-east-1'),
      },
    ],
  };
  async function hosts(page: import('@playwright/test').Page): Promise<void> {
    await reportHost(page, {
      hostName: 'mac-mini',
      awsProfiles: [
        { name: 'default' },
        { name: 'work-bedrock', region: 'eu-west-2' },
        { name: 'client-x', region: 'us-east-1' },
      ],
    });
    await addSecondHost(page, { hostName: 'hetzner', awsProfiles: [] });
  }

  test('one list: Auto | Account, Bedrock rows last with their host, profile, region and spend', async ({
    page,
  }) => {
    await stubSettingsApi(page, { secrets: ACCOUNTS });
    await page.goto(SETTINGS);
    await hosts(page);
    await expect(page.getByTestId('accounts-head-claude-code')).toHaveText('AutoAccount');
    const rows = page.locator('[data-testid^="accounts-rank-claude-code-item-"]');
    await expect(rows).toHaveCount(4);
    await expect(page.getByTestId('account-auto-claude-code-a1')).toBeChecked();
    await expect(page.getByTestId('account-auto-claude-code-b1')).not.toBeChecked();
    await expect(page.getByTestId('accounts-rank-claude-code-handle-b1')).toHaveCount(0);
    await expect(page.getByTestId('account-claude-code-b1').locator('.set-rank')).toHaveCount(0);
    await expect(page.getByTestId('account-bedrock-claude-code-b1-host')).toHaveText(
      'Hostmac-mini',
    );
    await expect(page.getByTestId('account-bedrock-claude-code-b1-spent')).toHaveText(
      'Spent$18.42 of $100 cap · estimated',
    );
    await expect(page.getByTestId('account-bedrock-claude-code-b1-monthly')).toContainText('18%');
    await expect(page.getByTestId('account-bedrock-claude-code-b2-status')).toHaveText(
      'StatusAWS sign-in expired',
    );
    // The value column lines up with the bar, past the label column.
    const label = (await page
      .getByTestId('account-bedrock-claude-code-b1-host')
      .locator('.set-bar-label')
      .boundingBox())!;
    const value = (await page
      .getByTestId('account-bedrock-claude-code-b1-host')
      .locator('.acct-val')
      .boundingBox())!;
    expect(value.x).toBeGreaterThan(label.x + label.width);
    expect(Math.abs(value.y - label.y)).toBeLessThan(3);
  });

  test('a host reporting the profile signed out shows it expired', async ({ page }) => {
    await stubSettingsApi(page, { secrets: ACCOUNTS });
    await page.goto(SETTINGS);
    await hosts(page);
    await expect(page.getByTestId('account-bedrock-claude-code-b1-spent')).toBeVisible();
    await setHostAccount(page, {
      hostId: 'd1',
      backendId: 'claude-code',
      connected: false,
      accounts: [
        { id: 'b1', label: 'Work Bedrock', connected: false, error: 'AWS sign-in expired' },
      ],
    });
    await expect(page.getByTestId('account-bedrock-claude-code-b1-status')).toHaveText(
      'StatusAWS sign-in expired',
    );
  });

  test('ticking Auto writes auto for the account', async ({ page }) => {
    const server = await stubSettingsApi(page, { secrets: ACCOUNTS });
    await page.goto(SETTINGS);
    // The box follows the committed state, so a click is a write, not a toggle.
    await page.getByTestId('account-auto-claude-code-b1').click();
    await expect
      .poll(() => server.writes.find((w) => w.method === 'PATCH'))
      .toEqual({ method: 'PATCH', path: '/api/accounts/claude-code/b1', body: { auto: true } });
  });

  test('Add account → Amazon Bedrock: the form adds the account on the chosen host', async ({
    page,
  }) => {
    const server = await stubSettingsApi(page, { secrets: ACCOUNTS });
    await page.goto(SETTINGS);
    await hosts(page);
    await page.getByTestId('add-claude-account').click();
    await expect(page.getByTestId('add-claude-menu').getByRole('menuitem')).toHaveText([
      'Claude subscription',
      'Amazon Bedrock',
    ]);
    await page.getByTestId('add-claude-bedrock').click();
    const form = page.getByTestId('bedrock-form');
    await expect(form).toBeVisible();
    await expect(page.getByTestId('add-claude-account')).toHaveCount(0);
    await page.getByTestId('bedrock-name').fill('Team Bedrock');
    await page.getByTestId('bedrock-host-d1').click();
    await expect(page.getByTestId('bedrock-profile').getByRole('button')).toHaveText([
      'default',
      'work-bedrock',
      'client-x',
    ]);
    await page.getByTestId('bedrock-profile-client-x').click();
    await expect(page.getByTestId('bedrock-region')).toHaveValue('us-east-1');
    await expect(page.getByTestId('bedrock-prefix').getByRole('button')).toHaveText([
      'Auto (US)',
      'EU',
      'US',
      'APAC',
      'Japan',
      'Australia',
      'Global',
    ]);
    await page.getByTestId('bedrock-cap').fill('$40');
    await page.getByTestId('bedrock-submit').click();
    await expect
      .poll(() => server.writes.find((w) => w.method === 'POST'))
      .toEqual({
        method: 'POST',
        path: '/api/accounts/claude-code',
        body: {
          bedrock: {
            label: 'Team Bedrock',
            hostId: 'd1',
            awsProfile: 'client-x',
            awsRegion: 'us-east-1',
            regionPrefix: 'auto',
            monthlyCapUsd: 40,
            auto: false,
          },
        },
      });
    await expect(form).toHaveCount(0);
    await expect(page.getByTestId('add-claude-account')).toBeVisible();
  });

  test('a refused add keeps the form and says the server’s words', async ({ page }) => {
    await stubSettingsApi(page, {
      secrets: ACCOUNTS,
      answer: (w) =>
        w.method === 'POST'
          ? { status: 409, body: { error: 'host_offline', message: 'mac-mini is offline' } }
          : undefined,
    });
    await page.goto(SETTINGS);
    await hosts(page);
    await page.getByTestId('add-claude-account').click();
    await page.getByTestId('add-claude-bedrock').click();
    await page.getByTestId('bedrock-name').fill('Team');
    await page.getByTestId('bedrock-host-d1').click();
    await page.getByTestId('bedrock-profile-default').click();
    await page.getByTestId('bedrock-region').fill('eu-west-1');
    await page.getByTestId('bedrock-cap').fill('10');
    await page.getByTestId('bedrock-submit').click();
    await expect(page.getByText(/mac-mini is offline/)).toBeVisible();
    await expect(page.getByTestId('bedrock-form')).toBeVisible();
  });

  test('⋯ → Edit opens the form filled in; Save sends only the change', async ({ page }) => {
    const server = await stubSettingsApi(page, { secrets: ACCOUNTS });
    await page.goto(SETTINGS);
    await hosts(page);
    await page.getByTestId('account-menu-claude-code-b1').click();
    await expect(
      page.getByTestId('account-menu-claude-code-b1-open').getByRole('menuitem'),
    ).toHaveText(['Edit', 'Remove']);
    await page.getByTestId('account-edit-claude-code-b1').click();
    await expect(page.getByTestId('bedrock-name')).toHaveValue('Work Bedrock');
    await expect(page.getByTestId('bedrock-cap')).toHaveValue('$100');
    await page.getByTestId('bedrock-cap').fill('150');
    await page.getByTestId('bedrock-submit').click();
    await expect
      .poll(() => server.writes.find((w) => w.method === 'PATCH'))
      .toEqual({
        method: 'PATCH',
        path: '/api/accounts/claude-code/b1',
        body: { monthlyCapUsd: 150 },
      });
  });

  test('Add account → Claude subscription offers the sign-in and the setup token', async ({
    page,
  }) => {
    await stubSettingsApi(page, { secrets: ACCOUNTS });
    await page.goto(SETTINGS);
    await page.getByTestId('add-claude-account').click();
    await page.getByTestId('add-claude-subscription').click();
    await expect(page.getByTestId('claude-signin-start')).toBeVisible();
    await expect(page.getByTestId('add-claude-setup-token')).toBeVisible();
    await page.getByTestId('add-claude-cancel').click();
    await expect(page.getByTestId('add-claude-account')).toBeVisible();
  });
});

test.describe('settings — Chats: account for titles and status', () => {
  test('Automatic and every Claude account; the choice is written as backgroundAccount', async ({
    page,
  }) => {
    const server = await stubSettingsApi(page, {
      secrets: {
        claude: [
          { id: 'a1', label: 'Personal', connected: true },
          { id: 'a2', label: 'Max', connected: true },
        ],
      },
    });
    await page.goto(settingsUrl('chats'));
    const select = page.getByTestId('background-account-select');
    await expect(select.locator('option')).toHaveText(['Automatic', 'Personal', 'Max']);
    await expect(select).toHaveValue('auto');
    await select.selectOption('a2');
    await expect.poll(() => server.patches).toContainEqual({ backgroundAccount: 'a2' });
  });
});
