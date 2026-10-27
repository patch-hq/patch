import { test, expect } from '@playwright/test';

// Desktop polish of the Jobs list: the defaults disclosure lines up with the
// rows and reads like a section heading, job names outrank their detail lines,
// and the per-row actions are quiet buttons with real padding.

const JOB = {
  id: 'bus',
  name: 'bus-watch',
  enabled: true,
  trigger: { type: 'cron', expression: '57 8 * * 1-5' },
  filter: null,
  action: { type: 'spawn', hostId: 'd1', folder: '~/projects/nearest-bus', skill: 'bus-watch' },
  createdAt: 1,
  updatedAt: 1,
};

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.route('**/api/jobs/*/runs**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"runs":[]}' }),
  );
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [JOB] }),
    }),
  );
  await page.goto('/app/dev-harness.html?route=/jobs');
  await expect(page.getByTestId('job-bus')).toBeVisible();
});

test('defaults disclosure aligns with the rows and has no default marker', async ({ page }) => {
  const summary = page.getByTestId('job-defaults').locator('summary');
  const sBox = (await summary.boundingBox())!;
  const rBox = (await page.getByTestId('job-bus').boundingBox())!;
  expect(Math.abs(sBox.x - rBox.x)).toBeLessThanOrEqual(1);
  const style = await summary.evaluate((el) => {
    const s = getComputedStyle(el);
    const before = getComputedStyle(el, '::marker');
    return { display: s.display, transform: s.textTransform, marker: before.content };
  });
  expect(style.display).not.toBe('list-item');
  expect(style.transform).toBe('uppercase');
});

test('job name outranks its detail lines', async ({ page }) => {
  const name = await page.locator('.job-row .job-name').evaluate((el) => {
    const s = getComputedStyle(el);
    return { size: parseFloat(s.fontSize), weight: parseInt(s.fontWeight, 10) };
  });
  const detail = await page
    .getByTestId('job-trigger-bus')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(name.size).toBeGreaterThan(detail);
  expect(name.weight).toBeGreaterThanOrEqual(600);
});

test('row actions are quiet and padded', async ({ page }) => {
  for (const id of ['job-runs-toggle-bus', 'job-archive-bus', 'job-delete-bus']) {
    const s = await page.getByTestId(id).evaluate((el) => {
      const c = getComputedStyle(el);
      return { border: c.borderTopColor, pad: parseFloat(c.paddingTop) };
    });
    expect(s.border, id).toBe('rgba(0, 0, 0, 0)');
    expect(s.pad, id).toBeGreaterThanOrEqual(6);
  }
  const run = await page
    .getByTestId('job-run-now-bus')
    .evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
  expect(run).toBeGreaterThanOrEqual(6);
});
