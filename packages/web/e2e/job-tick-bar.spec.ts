import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness) for the scheduled-job tick bar: a chat that a
// recurring job re-prompts shows a persistent bar under the header, stacked with
// the wake bar, plus a `Job · next …` chip in the header. `chat_job_ticks` is
// served a cron */5 job whose next fire is ~2m 14s out.
const HARNESS = '/app/dev-harness.html?chat=chat_job_ticks';

test.describe('job tick bar', () => {
  test('shows name, cadence and a live countdown', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('job-tick-bar')).toBeVisible();
    await expect(page.getByTestId('job-tick-name')).toHaveText('Resume Cadence Delivery');
    await expect(page.getByTestId('job-tick-schedule')).toHaveText('every 5m');
    const countdown = page.getByTestId('job-tick-countdown');
    await expect(countdown).toHaveText(/next 2m \d+s/);
    const first = await countdown.textContent();
    await expect.poll(async () => countdown.textContent(), { timeout: 5000 }).not.toBe(first);
  });

  test('header chip counts down and the bar sits under the header with the wake bar', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('job-tick-chip')).toHaveText(/Job · next 2m \d+s/);
    const header = (await page.getByTestId('chat-head').boundingBox())!;
    const job = (await page.getByTestId('job-tick-bar').boundingBox())!;
    const wake = (await page.getByTestId('wake-bar').boundingBox())!;
    const stream = (await page.getByTestId('chat-stream').boundingBox())!;
    expect(job.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
    expect(wake.y).toBeGreaterThanOrEqual(job.y + job.height - 1);
    expect(wake.y + wake.height).toBeLessThanOrEqual(stream.y + 1);
    // Nothing is added above the composer.
    await expect(page.getByTestId('job-tick-progress')).toHaveCount(1);
  });

  test('on a narrow screen the name truncates and the countdown stays visible', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(HARNESS);
    const bar = (await page.getByTestId('job-tick-bar').boundingBox())!;
    const countdown = (await page.getByTestId('job-tick-countdown').boundingBox())!;
    const schedule = (await page.getByTestId('job-tick-schedule').boundingBox())!;
    expect(countdown.x + countdown.width).toBeLessThanOrEqual(bar.x + bar.width + 1);
    expect(schedule.x + schedule.width).toBeLessThanOrEqual(countdown.x + 1);
  });

  test('a chat no job targets shows neither bar nor chip', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await expect(page.getByTestId('chat-main')).toBeVisible();
    await expect(page.getByTestId('job-tick-bar')).toHaveCount(0);
    await expect(page.getByTestId('job-tick-chip')).toHaveCount(0);
  });
});
