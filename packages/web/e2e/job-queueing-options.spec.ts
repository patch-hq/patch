import { test, expect, type Page } from '@playwright/test';

// The job editor offers every job option, not only the common ones: queueing
// (queue / per-subject queue / append), one-off and wake host (spec/08).
// Set SHOT_DIR to also write a screenshot of each state for design review.

const FOLDER = '/home/tom/projects/portfolio';
const JOB_ID = 'j_queueing_options';
const EDIT_JOB = `/app/dev-harness.html?route=/jobs/${JOB_ID}`;

const BASE = {
  id: JOB_ID,
  name: 'App Updates',
  enabled: true,
  trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
  filter: null,
  action: { type: 'continue', hostId: 'd1', folder: FOLDER, skill: 'app-update' },
  createdAt: 1,
  updatedAt: 1,
};

async function stub(page: Page, job: Record<string, unknown>): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/folders**', (r) =>
    r.fulfill(json({ hosts: [{ hostId: 'd1', roots: [FOLDER], recent: [] }] })),
  );
  await page.route('**/api/skills**', (r) =>
    r.fulfill(json({ skills: ['app-update'], paths: {} })),
  );
  await page.route('**/api/models**', (r) => r.fulfill(json({ models: [] })));
  await page.route('**/api/jobs**', (r) => r.fulfill(json({ jobs: [job] })));
  await page.route(`**/api/jobs/${JOB_ID}`, (r) => r.fulfill(json(job)));
  await page.route(`**/api/jobs/${JOB_ID}/runs**`, (r) => r.fulfill(json({ runs: [] })));
  await page.route(`**/api/jobs/${JOB_ID}/queue**`, (r) =>
    r.fulfill(json({ concurrency: 1, inFlight: [], queued: [] })),
  );
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env['SHOT_DIR'];
  if (!dir) return;
  await page.getByTestId('group-concurrency').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

test.describe('job editor — queueing, one-off, wake host', () => {
  test('parallel by default; queue mode reveals limit and per-subject key', async ({ page }) => {
    await stub(page, BASE);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue('App Updates', { timeout: 15_000 });
    await expect(page.getByTestId('job-queue-mode')).toHaveValue('parallel');
    await expect(page.getByTestId('job-concurrency')).toHaveCount(0);
    await shot(page, '1-parallel');

    await page.getByTestId('job-queue-mode').selectOption('queue');
    await expect(page.getByTestId('job-concurrency')).toBeVisible();
    await page.getByTestId('job-queue-key').fill('{{payload.event_data.id}}');
    await shot(page, '2-queue');
  });

  test('append shows its resets and warns when the action is not continue', async ({ page }) => {
    await stub(page, { ...BASE, queueing: { mode: 'append', idleTimeoutMs: 3_600_000 } });
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-append-idle')).toHaveValue('60', { timeout: 15_000 });
    await expect(page.getByTestId('job-append-needs-continue')).toHaveCount(0);
    await shot(page, '3-append');

    await stub(page, {
      ...BASE,
      action: { type: 'spawn', hostId: 'd1', folder: FOLDER, skill: 'app-update' },
      queueing: { mode: 'append' },
    });
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-append-needs-continue')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('job-save')).toBeDisabled();
    await shot(page, '4-append-wrong-action');
  });

  test('lifecycle: one-off for any trigger, wake host for cron only', async ({ page }) => {
    await stub(page, { ...BASE, oneOff: true, wakeHost: true });
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-one-off')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('job-wake-host')).toBeVisible();
    await shot(page, '5-lifecycle-cron');

    await stub(page, { ...BASE, trigger: { type: 'todoist' } });
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-one-off')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('job-wake-host')).toHaveCount(0);
  });
});
