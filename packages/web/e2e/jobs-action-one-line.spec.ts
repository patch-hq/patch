import { test, expect } from '@playwright/test';

// A spawn job with a long prompt and a deep folder path put the action line on
// two or three rows, breaking mid-path ("/home/claude-" / "dev/projects/...").
// The action line is one row, truncated with an ellipsis.

const JOBS_ROUTE = '/app/dev-harness.html?route=/jobs';

const LONG = {
  id: 'settle',
  name: 'Settle: narrate',
  enabled: true,
  queued: 0,
  trigger: { type: 'webhook', scheme: 'none' },
  filter: null,
  action: {
    type: 'spawn',
    hostId: 'd1',
    folder: '/home/claude-dev/projects/portfolio',
    prompt:
      'Settle narration. You write the log of what Ruby has been doing across the whole house today',
  },
  latestRun: null,
  createdAt: 1,
  updatedAt: 1,
};

for (const width of [390, 900, 1400]) {
  test(`job action line is one truncated row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route('**/api/jobs/*/runs**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"runs":[]}' }),
    );
    await page.route('**/api/jobs**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobs: [LONG] }),
      }),
    );
    await page.goto(JOBS_ROUTE);
    const action = page.getByTestId('job-action-settle');
    await expect(action).toBeVisible();
    const h = (await action.boundingBox())!.height;
    expect(h).toBeLessThan(26);
    const row = (await page.getByTestId('job-settle').boundingBox())!;
    const box = (await action.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(row.x + row.width + 0.5);
  });
}
