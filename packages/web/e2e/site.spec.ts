// The public website (site/, patchhq.dev): a static page, opened from disk.
// The Mac download being the disk image with its size, the network diagram
// and features, and the Get-started steps matching the app.

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
  { name: 'desktop', width: 1280, height: 800, diagram: '.net-wide' },
  { name: 'phone', width: 390, height: 844, diagram: '.net-tall' },
]) {
  test.describe(`site at ${viewport.name} width`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('offers the dmg with its size, shows the network and the features, and the steps match the app', async ({
      page,
    }) => {
      await onMac(page);
      await stubRelease(page, ASSETS);
      await page.goto(SITE);

      await expect(page.getByTestId('oss')).toHaveText('Free and open source · GitHub');

      const primary = page.locator('.hero [data-download]');
      await expect(primary).toHaveAttribute('href', `${LATEST}Patch-mac-arm64.dmg`);
      await expect(primary).toHaveText('Download for Mac389 MB');
      await expect(page.locator('.hero [data-no-build]')).toBeHidden();

      // One diagram per width: the wide one on a desktop, the tall one on a phone.
      await expect(page.locator(viewport.diagram)).toBeVisible();
      await expect(page.locator('.net svg:visible')).toHaveCount(1);

      await expect(page.locator('.feature h2')).toHaveText([
        'Any provider, any account',
        'Every machine, one list',
        'Jobs you can shape',
        'Built-in design tools',
        'Nothing hidden',
        'Built for heavy use',
      ]);
      await expect(page.locator('.deep h3')).toHaveCount(7);
      await expect(page.locator('.detail-grid details')).toHaveCount(10);

      // A quiet Download every couple of sections, all pointing at the same build.
      const strips = page.locator('.cta-strip [data-download]');
      await expect(strips).toHaveCount(4);
      for (const a of await strips.all()) {
        await expect(a).toHaveAttribute('href', `${LATEST}Patch-mac-arm64.dmg`);
      }

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

      await expect(page.locator('.steps h3')).toHaveText([
        'Choose where Patch runs',
        'Connect your AI accounts',
        'Add your phone and other machines',
      ]);
      await expect(page.locator('.foot')).toContainText('AGPL licence');

      // Nothing runs off the side of the page.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);

      // Every screenshot loads, at the size this width asks for.
      const broken = await page.evaluate(async () => {
        const imgs = [...document.querySelectorAll<HTMLImageElement>('.shot img')];
        for (const img of imgs) {
          img.loading = 'eager';
          await img.decode().catch(() => {});
        }
        return imgs.filter((img) => img.naturalWidth === 0).map((img) => img.currentSrc);
      });
      expect(broken).toEqual([]);
    });
  });
}

test('"and more" opens the providers: what runs today, and what is coming', async ({ page }) => {
  await page.goto(SITE);
  const more = page.locator('.hero [data-more]');
  const panel = page.getByTestId('providers');
  await expect(panel).toBeHidden();
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.providers-group').first().locator('strong')).toHaveText([
    'Claude Code',
    'Codex',
  ]);
  const coming = panel.locator('.providers-coming');
  await expect(coming.locator('h3')).toHaveText('Coming');
  await expect(coming).toContainText('Gemini');
  await expect(coming).toContainText('OpenRouter');
  await more.click();
  await expect(panel).toBeHidden();
});

test('each detail opens in place, and See everything shows the whole list', async ({ page }) => {
  await page.goto(SITE);
  const queue = page.locator('.detail-grid details', { hasText: 'Queue messages' });
  await expect(queue.locator('.detail-more')).toBeHidden();
  await queue.locator('summary').click();
  await expect(queue.locator('.detail-more')).toContainText('after its current step');

  const all = page.getByTestId('everything');
  await expect(all).toBeHidden();
  await page.locator('[data-see-all]').click();
  await expect(all).toBeVisible();
  await expect(all.locator('.ev-group h3')).toHaveCount(8);
  // What the site leaves out stays out.
  await expect(all).not.toContainText(/manager|voice|meeting|browser|terminal|computer use|share/i);
  await expect(page.locator('[data-see-all]')).toHaveText('Show less');
});

test('a clip loads and plays once it is on screen, and pauses off it', async ({ page }) => {
  await page.goto(SITE);
  const clip = page.locator('video[data-video="pad"]');
  await expect(clip).toHaveAttribute('poster', 'vid/pad-light-poster.webp');
  // Nothing is fetched before it is near the screen.
  expect(await clip.evaluate((v: HTMLVideoElement) => v.currentSrc)).toBe('');
  await clip.scrollIntoViewIfNeeded();
  await expect
    .poll(() => clip.evaluate((v: HTMLVideoElement) => v.currentSrc))
    .toMatch(/pad-light\.mp4$/);
  await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});

test('a phone gets the phone cut of each clip', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SITE);
  const clip = page.locator('video[data-video="pad"]');
  await expect(clip).toHaveAttribute('poster', 'vid/pad-light-phone-poster.webp');
  await clip.scrollIntoViewIfNeeded();
  await expect
    .poll(() => clip.evaluate((v: HTMLVideoElement) => v.currentSrc))
    .toMatch(/pad-light-phone\.mp4$/);
});

test('dark mode gets the dark recordings', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(SITE);
  await expect(page.locator('video[data-video="switch"]')).toHaveAttribute(
    'poster',
    'vid/switch-dark-poster.webp',
  );
});

test('with reduced motion the clips stay on their posters', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(SITE);
  const clip = page.locator('video[data-video="jobs"]');
  await clip.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await expect(clip).toHaveAttribute('poster', 'vid/jobs-light-poster.webp');
  expect(await clip.evaluate((v: HTMLVideoElement) => v.currentSrc)).toBe('');
  expect(await clip.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});

test('a phone visitor gets Get started in place of a download', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile',
    });
  });
  await stubRelease(page, ASSETS);
  await page.goto(SITE);
  await expect(page.locator('.hero [data-download]')).toBeHidden();
  await expect(page.locator('.hero [data-no-build]')).toBeVisible();
  // The strips through the page do the same, without a second Get started.
  await expect(page.locator('.cta-strip [data-no-build]').first()).toBeVisible();
  await expect(page.locator('.cta-strip [data-build-only]').first()).toBeHidden();
});

test('with reduced motion the diagram is still, without its pulses', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(SITE);
  await expect(page.locator('.net-wide .net-pulses')).toBeHidden();
  await expect(page.locator('.net-wide .net-hub')).toBeVisible();
});

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
