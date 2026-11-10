import { test, expect } from '@playwright/test';

// Task 2: "no back button on edit schedule"
// The job editor (new-job and edit-job) must have a back/cancel button
// that navigates to /jobs without requiring a save.

// Bug report 23 Sep 2026: "patch job back page only goes back to jobs
// instead of where you actually where". Opened via a chat's "Open job" row
// (chat_job_open_link fixture — dev-harness.tsx), Back must return to that
// chat rather than always landing on the jobs list (spec/14 § Jobs view).
const CHAT_WITH_JOB_LINK = '/app/dev-harness.html?chat=chat_job_open_link';
const CHAT_FIXTURE_MESSAGE = 'watch the 36 bus and tell me when it leaves';

const LINKED_JOB = {
  id: 'job_bus_watch',
  name: 'Bus watch',
  enabled: true,
  filter: null,
  trigger: { type: 'cron', expression: '*/5 7-22 * * *', timezone: 'Europe/London' },
  action: {
    type: 'spawn',
    hostId: 'd1',
    folder: '/home/tom/projects/bus',
    prompt: 'watch the bus',
  },
};

async function stubJobEditorApis(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/folders', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hosts: [{ hostId: 'd1', roots: ['/home/tom/projects/bus'], recent: [] }],
      }),
    }),
  );
  await page.route('**/api/skills**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ skills: [] }),
    }),
  );
  await page.route('**/api/models**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models: [] }),
    }),
  );
  // Reverse registration order (Playwright): the broad list stub goes first
  // or it swallows the single-job GET below.
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [LINKED_JOB] }),
    }),
  );
  await page.route(`**/api/jobs/${LINKED_JOB.id}/runs**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [] }),
    }),
  );
  await page.route(`**/api/jobs/${LINKED_JOB.id}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(LINKED_JOB),
    }),
  );
}

test.describe('job editor — opened from a chat', () => {
  // "Open job" opens the job in a tab of its own, beside the chat, so there is
  // no history to step back through: the chat is still open where it was.
  test('opened from a chat, the job opens in a new tab and the chat stays open', async ({
    page,
  }) => {
    await stubJobEditorApis(page);
    await page.goto(CHAT_WITH_JOB_LINK);
    await expect(page.getByText(CHAT_FIXTURE_MESSAGE)).toBeVisible();

    await page.getByTestId('tool-call-job-link').click();
    await expect(page.getByTestId('job-editor')).toBeVisible();
    await expect(page.getByTestId('job-name')).toHaveValue(LINKED_JOB.name);

    await expect(page.getByTestId('chat-head')).toHaveCount(1);
    await expect(page.getByTestId('jobs-route')).toHaveCount(0);
  });

  // Saving still writes the job; the chat it was opened from is left alone.
  test('opened from a chat, saving writes the job and leaves the chat open', async ({ page }) => {
    await stubJobEditorApis(page);
    await page.goto(CHAT_WITH_JOB_LINK);
    await expect(page.getByText(CHAT_FIXTURE_MESSAGE)).toBeVisible();

    await page.getByTestId('tool-call-job-link').click();
    await expect(page.getByTestId('job-name')).toHaveValue(LINKED_JOB.name);
    await page.getByTestId('job-name').fill('Bus watch (weekdays)');

    const saved = page.waitForRequest(
      (r) => r.method() === 'PATCH' && r.url().endsWith(`/api/jobs/${LINKED_JOB.id}`),
    );
    await page.getByTestId('job-save').click();
    await saved;

    await expect(page.getByTestId('chat-head')).toHaveCount(1);
  });
});
