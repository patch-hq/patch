import { test, expect, type Page } from '@playwright/test';

// Jobs page at phone width (412px): the sidebar expand button must not cover
// the back arrow, cards stay compact, the head's fields form an even grid, and
// the defaults disclosure shares the content indent.

const mkJob = (id: string, name: string) => ({
  id,
  name,
  enabled: true,
  queued: 0,
  trigger: { type: 'cron', expression: '0 8 * * *', timezone: 'Europe/London' },
  filter: null,
  action: {
    type: 'spawn',
    hostId: 'd1',
    folder: '/home/x/projects/p',
    prompt: 'Life coach prompt',
  },
  latestRun: null,
  createdAt: 1,
  updatedAt: 1,
});

async function open(page: Page, route: string): Promise<void> {
  await page.setViewportSize({ width: 412, height: 900 });
  await page.route('**/api/jobs/*/runs**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"runs":[]}' }),
  );
  await page.route('**/api/jobs**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobs: [mkJob('a', 'Life coach daily'), mkJob('b', 'Life coach during the day')],
      }),
    }),
  );
  await page.route('**/api/jobs/a', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mkJob('a', 'Life coach daily')),
    }),
  );
  await page.route('**/api/models**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"models":[]}' }),
  );
  await page.goto(`/app/dev-harness.html?route=${route}`);
}

test.describe('jobs page at 412px', () => {
  test('expand button does not overlap the back arrow (list)', async ({ page }) => {
    await open(page, '/jobs');
    const expand = (await page.getByTestId('sidebar-expand').boundingBox())!;
    const back = (await page.getByRole('button', { name: /back/i }).first().boundingBox())!;
    expect(back.x).toBeGreaterThanOrEqual(expand.x + expand.width);
  });

  test('expand button does not overlap the back arrow (editor)', async ({ page }) => {
    await open(page, '/jobs/a');
    await expect(page.getByTestId('sidebar-expand')).toBeVisible();
    const expand = (await page.getByTestId('sidebar-expand').boundingBox())!;
    const back = (await page.getByRole('button', { name: /back/i }).first().boundingBox())!;
    expect(back.x).toBeGreaterThanOrEqual(expand.x + expand.width);
  });

  test('cards are compact: three or more fit in a screen', async ({ page }) => {
    await open(page, '/jobs');
    const card = (await page.getByTestId('job-a').boundingBox())!;
    expect(card.height).toBeLessThan(135);
  });

  test('action line is dropped from the card', async ({ page }) => {
    await open(page, '/jobs');
    await expect(page.getByTestId('job-a')).toBeVisible();
    await expect(page.getByTestId('job-action-a')).toBeHidden();
  });

  test('head fields form an even grid', async ({ page }) => {
    await open(page, '/jobs');
    const boxes = await Promise.all(
      ['jobs-sort', 'jobs-filter-status', 'jobs-filter-trigger'].map(
        async (t) => (await page.getByTestId(t).boundingBox())!,
      ),
    );
    expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(1);
    expect(Math.abs(boxes[0]!.width - boxes[1]!.width)).toBeLessThan(2);
    expect(Math.abs(boxes[1]!.width - boxes[2]!.width)).toBeLessThan(2);
    const search = (await page.getByTestId('jobs-search').boundingBox())!;
    const right = boxes[2]!.x + boxes[2]!.width;
    expect(Math.abs(search.x + search.width - right)).toBeLessThan(2);
  });

  test('defaults disclosure is aligned with the content indent', async ({ page }) => {
    await open(page, '/jobs');
    const summary = (await page.getByTestId('job-defaults').locator('summary').boundingBox())!;
    const card = (await page.getByTestId('job-a').boundingBox())!;
    expect(summary.x).toBeGreaterThanOrEqual(card.x - 1);
  });
});
