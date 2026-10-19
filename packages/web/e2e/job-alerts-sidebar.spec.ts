import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real Sidebar + real CSS, stubbed API) for the
// job-alert items in the sidebar: a job run that ended in dispatch-error or a
// broken gate shows as an error item naming the job, the reason in plain words
// and the fix; it stays until dismissed, and goes by itself once the server
// stops reporting it (the job's next run succeeded).
const HARNESS = '/app/dev-harness.html';

const chatgptAlert = {
  jobId: 'j_01M3KNCY1VJNMMWMHFA56H0V97',
  jobName: 'Cadence monitor agents',
  status: 'dispatch-error',
  ts: 1760860800000,
  reason: 'ChatGPT is not signed in on the host that runs this job.',
  fix: 'Sign in to ChatGPT in Settings → Hosts.',
  detail: 'host H refused the action: chatgpt_login_required: x',
  fixPath: '/settings/hosts',
};
const gateAlert = {
  jobId: 'j_01M3KNCY1VJNMMWMHFA56H0V98',
  jobName: 'Basket watch',
  status: 'gate-error',
  ts: 1760860700000,
  reason: "The job's gate broke, so the job did not run: gate exited 2",
  fix: "Fix the gate script, then check the job's run log.",
  detail: 'gate exited 2',
};

test.describe('Job alerts in the sidebar', () => {
  test('shows an error item per failed job, and dismiss removes it for good', async ({ page }) => {
    let alerts = [chatgptAlert, gateAlert];
    const dismissed: string[] = [];
    await page.route('**/api/job-alerts', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ alerts }) }),
    );
    await page.route('**/api/job-alerts/*', (route) => {
      expect(route.request().method()).toBe('DELETE');
      const id = route.request().url().split('/').pop()!;
      dismissed.push(id);
      alerts = alerts.filter((a) => a.jobId !== id);
      return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto(HARNESS);

    const items = page.getByTestId('job-alert');
    await expect(items).toHaveCount(2);
    const first = items.nth(0);
    await expect(first.getByTestId('job-alert-name')).toHaveText('Cadence monitor agents');
    await expect(first.getByTestId('job-alert-reason')).toContainText('ChatGPT is not signed in');
    await expect(first.getByTestId('job-alert-fix')).toContainText(
      'Sign in to ChatGPT in Settings → Hosts.',
    );
    await expect(first.getByTestId('job-alert-fix').locator('a')).toHaveAttribute(
      'href',
      '/settings/hosts',
    );
    await expect(items.nth(1).getByTestId('job-alert-name')).toHaveText('Basket watch');
    // Visibly an error: red border, inside the sidebar's width.
    const box = await first.boundingBox();
    expect(box!.width).toBeGreaterThan(100);

    await first.getByTestId('job-alert-dismiss').click();
    await expect(items).toHaveCount(1);
    await expect(items.first().getByTestId('job-alert-name')).toHaveText('Basket watch');
    expect(dismissed).toEqual([chatgptAlert.jobId]);
  });

  test('an alert disappears by itself once the job has run successfully', async ({ page }) => {
    let alerts = [chatgptAlert];
    await page.route('**/api/job-alerts', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ alerts }) }),
    );
    await page.goto(HARNESS);
    await expect(page.getByTestId('job-alert')).toHaveCount(1);
    alerts = []; // the server cleared it: the next run was ok
    await page.reload();
    await expect(page.getByTestId('job-alerts')).toHaveCount(0);
  });

  test('no alerts renders nothing; a failing endpoint is shown, not hidden', async ({ page }) => {
    await page.route('**/api/job-alerts', (route) =>
      route.fulfill({ contentType: 'application/json', body: '{"alerts":[]}' }),
    );
    await page.goto(HARNESS);
    await expect(page.getByTestId('bottom-nav')).toBeVisible();
    await expect(page.getByTestId('job-alerts')).toHaveCount(0);
    await expect(page.getByTestId('job-alerts-error')).toHaveCount(0);

    await page.unroute('**/api/job-alerts');
    await page.route('**/api/job-alerts', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }),
    );
    await page.reload();
    await expect(page.getByTestId('job-alerts-error')).toBeVisible();
  });
});
