import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real Sidebar, stubbed API): a failed job run
// (broken gate, dispatch error) is announced through the notification bell, not
// as an error block in the sidebar. The spec serves the alerts itself, so the
// sidebar would show them if it still polled.
const HARNESS = '/app/dev-harness.html';

test.describe('Failed job runs', () => {
  test('draw no block in the sidebar', async ({ page }) => {
    let polled = 0;
    await page.route('**/api/job-alerts', (route) => {
      polled += 1;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          alerts: [
            {
              jobId: 'j_01M3KNCY1VJNMMWMHFA56H0V98',
              jobName: 'Photo triage',
              status: 'gate-error',
              ts: 1760860700000,
              reason: "The job's gate broke, so the job did not run: gate exited 2",
              fix: "Fix the gate script, then check the job's run log.",
              detail: 'gate exited 2',
            },
          ],
        }),
      });
    });
    await page.goto(HARNESS);
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('job-alerts')).toHaveCount(0);
    await expect(page.getByTestId('job-alert')).toHaveCount(0);
    expect(polled).toBe(0);
  });
});
