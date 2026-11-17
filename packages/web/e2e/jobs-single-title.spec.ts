import { test, expect } from '@playwright/test';

const JOB = {
  id: 'j1',
  name: 'Patch Updates',
  enabled: true,
  trigger: { type: 'todoist' },
  filter: null,
  action: { type: 'continue', hostId: 'd1', folder: '/x', skill: 'app-update', key: 'k' },
  createdAt: 1,
  updatedAt: 1,
};

test('Jobs names itself once — by its tab — and keeps a compact toolbar', async ({ page }) => {
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [JOB] }),
    }),
  );
  await page.goto('/app/dev-harness.html?route=/jobs');
  await expect(page.getByTestId('jobs-route')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('group-title')).toHaveCount(0);
  await expect(page.locator('.jobs-route .route-head h1')).toHaveCount(0);
  await expect(page.getByTestId('jobs-new')).toBeVisible();
  const head = await page.locator('.jobs-route .route-head').boundingBox();
  expect(head!.height).toBeLessThan(70);
  await page.screenshot({ path: process.env.SHOT ?? '/tmp/jobs-single-title.png' });
});
