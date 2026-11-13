// The public website (site/, patchhq.dev): a static page, opened from disk.
// What a first-time visitor needs before downloading, the Mac download being
// the disk image with its size, and the Get-started steps matching the app.

import { expect, test, type Page } from '@playwright/test';

const SITE = new URL('../../../site/index.html', import.meta.url).toString();
const LATEST = 'https://github.com/patch-hq/patch/releases/latest/download/';

/** The release GitHub's API reports, so the sizes are known. */
async function stubRelease(page: Page, assets: Array<{ name: string; size: number }>) {
  await page.route('https://api.github.com/repos/patch-hq/patch/releases/latest', (route) =>
    route.fulfill({ json: { tag_name: 'v1.1.1253', assets } }),
  );
}

/** A Mac visitor, whatever the test machine is. */
async function onMac(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(navigator, 'userAgentData', { get: () => undefined });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
  });
}

const ASSETS = [
  { name: 'Patch-mac-arm64.dmg', size: 389_100_215 },
  { name: 'Patch-mac-arm64.zip', size: 382_015_953 },
  { name: 'Patch-linux-x86_64.AppImage', size: 201_000_000 },
  { name: 'Patch-android.apk', size: 98_000_000 },
];

for (const viewport of [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`site at ${viewport.name} width`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('says what you need, offers the dmg with its size, and the steps match the app', async ({
      page,
    }) => {
      await onMac(page);
      await stubRelease(page, ASSETS);
      await page.goto(SITE);

      await expect(page.getByTestId('needs')).toHaveText(
        'Needs a Claude Pro, Max, Team or Enterprise plan, a ChatGPT plan or an OpenAI API key. Patch installs everything else. Free and open source (AGPL).',
      );
      await expect(page.getByTestId('needs')).toBeVisible();

      const primary = page.locator('.hero [data-download]');
      await expect(primary).toHaveAttribute('href', `${LATEST}Patch-mac-arm64.dmg`);
      await expect(primary).toHaveText('Download for Mac389 MB');

      const mac = page.locator('.platforms [data-os="mac"]');
      await expect(mac.locator('.p-meta')).toHaveText('Apple Silicon · 389 MB');
      await expect(mac.getByRole('link', { name: '.dmg' })).toHaveAttribute(
        'href',
        `${LATEST}Patch-mac-arm64.dmg`,
      );
      await expect(mac.getByRole('link', { name: '.zip' })).toHaveAttribute(
        'href',
        `${LATEST}Patch-mac-arm64.zip`,
      );

      const steps = page.locator('.steps h3');
      await expect(steps).toHaveText([
        'Download the app',
        'Make a few choices',
        'Scan the QR code',
      ]);
      await expect(page.locator('.steps')).not.toContainText('four questions');

      // Nothing runs off the side of the page.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
    });
  });
}

test('a failed size lookup leaves the sizes off and says so', async ({ page }) => {
  await onMac(page);
  await page.route('https://api.github.com/repos/patch-hq/patch/releases/latest', (route) =>
    route.fulfill({ status: 403, body: 'rate limited' }),
  );
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(SITE);
  await expect.poll(() => errors.join('\n')).toContain('download sizes unavailable');
  await expect(page.locator('.hero [data-download]')).toHaveText('Download for Mac');
  await expect(page.locator('.hero [data-download]')).toHaveAttribute(
    'href',
    `${LATEST}Patch-mac-arm64.dmg`,
  );
});

test('after Download, one line says what to do with the disk image', async ({ page }) => {
  await onMac(page);
  await stubRelease(page, ASSETS);
  // The file itself: answered as a download so the page stays put.
  await page.route(`${LATEST}**`, (route) =>
    route.fulfill({
      body: 'dmg',
      headers: { 'content-disposition': 'attachment; filename="Patch-mac-arm64.dmg"' },
    }),
  );
  await page.goto(SITE);
  const next = page.locator('.hero [data-next]');
  await expect(next).toBeHidden();
  const download = page.waitForEvent('download');
  await page.locator('.hero [data-download]').click();
  await download;
  await expect(next).toHaveText('Open the disk image and drag Patch to Applications.');
  await expect(next).toBeVisible();
  if (process.env['PATCH_SITE_SHOTS']) {
    await page.screenshot({ path: `${process.env['PATCH_SITE_SHOTS']}/site-download-next.png` });
  }
});
