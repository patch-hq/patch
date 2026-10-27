import { test, expect } from '@playwright/test';

const FOLDER = '/home/tom/projects/portfolio';
const JOB_ID = 'j_01KZSAG4ZNEZCNVA5AA3T4QHCA';

// The real job, in the shape it is stored in: a KEYED `ensure` — one durable
// chat per Todoist task — with the very long name that collides with the back
// button.
const JOB = {
  id: JOB_ID,
  name: 'Patch Updates (Todoist adds + moves/edits + comments → one thread per task)',
  enabled: true,
  trigger: { type: 'todoist' },
  filter: null,
  action: {
    type: 'continue',
    hostId: 'd1',
    folder: FOLDER,
    skill: 'app-update',
    key: '{{payload.event_data.id}}',
  },
  createdAt: 1,
  updatedAt: 1,
};

const EDIT_JOB = `/app/dev-harness.html?route=/jobs/${JOB_ID}`;

/** Every PATCH body the page sends, in order. */
type Saved = Array<Record<string, unknown>>;

async function stub(page: import('@playwright/test').Page, saved: Saved): Promise<void> {
  await page.route('**/api/folders**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hosts: [{ hostId: 'd1', roots: [FOLDER], recent: [] }] }),
    }),
  );
  await page.route('**/api/skills**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ skills: ['app-update'], paths: {} }),
    }),
  );
  await page.route('**/api/models**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models: [] }),
    }),
  );
  // Registered broadest-FIRST: playwright checks handlers in reverse
  // registration order, so the list route added last would swallow
  // `/api/jobs/:id` and the editor would render with no job at all.
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [JOB] }),
    }),
  );
  await page.route(`**/api/jobs/${JOB_ID}`, (route) => {
    if (route.request().method() === 'PATCH') {
      saved.push(JSON.parse(route.request().postData() ?? '{}'));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...JOB, updatedAt: 2 }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(JOB),
    });
  });
  await page.route(`**/api/jobs/${JOB_ID}/runs**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [] }),
    }),
  );
}

test.describe('job editor — layout polish', () => {
  test('title sits left beside the back controls, as on the Jobs list', async ({ page }) => {
    await stub(page, []);
    await page.goto('/app/dev-harness.html?route=/jobs/new');
    await expect(page.locator('.job-editor .route-head h1')).toHaveText('New job', {
      timeout: 15_000,
    });
    const h1 = await page.locator('.job-editor .route-head h1').boundingBox();
    const nav = await page.locator('.job-editor .route-head').boundingBox();
    expect(h1!.x - nav!.x).toBeLessThan(120);
  });

  test('collapsed Advanced leaves no large gap before Trigger', async ({ page }) => {
    await stub(page, []);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue(JOB.name, { timeout: 15_000 });
    const adv = await page.getByTestId('job-advanced-toggle').boundingBox();
    const trig = await page
      .locator('[data-testid="group-trigger"] .form-group-title')
      .boundingBox();
    expect(trig!.y - (adv!.y + adv!.height)).toBeLessThan(40);
  });

  test('text in inputs and selects starts at the same x', async ({ page }) => {
    await stub(page, []);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue(JOB.name, { timeout: 15_000 });
    const start = (sel: string) =>
      page
        .locator(sel)
        .first()
        .evaluate((el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          // Chrome insets an <input>'s text 2px and a <select>'s 4px beyond padding.
          const inner = el.tagName === 'SELECT' ? 4 : 2;
          return r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) + inner;
        });
    const input = await start('.job-editor input[data-testid="job-name"]');
    const select = await start('.job-editor select');
    expect(Math.abs(input - select)).toBeLessThanOrEqual(0.5);
  });
});
