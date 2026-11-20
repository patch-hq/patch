import { test, expect } from '@playwright/test';

// A typed folder that does not exist on the host is offered for creation, and a
// send never goes out for one that is missing.
const NEW = '/app/dev-harness.html?chat=new';
const TYPED = '/home/tom/my-first-patch';
const SHOTS = process.env['NF_SHOTS'];

test('typing a missing path offers Create, and creating selects it', async ({ page }) => {
  let exists = false;
  const created: string[] = [];
  await page.route('**/api/folders/browse**', (r) => {
    const dir = new URL(r.request().url()).searchParams.get('dir');
    if (dir === TYPED && !exists) {
      return r.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'folder_not_found', message: 'nope' }),
      });
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hostId: 'd1',
        dir: dir ?? null,
        parent: dir ? '/home/tom' : null,
        entries: dir ? [] : [{ name: 'portfolio', path: '/home/tom/projects/portfolio' }],
      }),
    });
  });
  await page.route('**/api/folders/create**', (r) => {
    created.push(new URL(r.request().url()).searchParams.get('dir') ?? '');
    exists = true;
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hostId: 'd1', dir: TYPED, parent: '/home/tom', entries: [] }),
    });
  });
  await page.goto(NEW);
  await page.getByTestId('new-chat-folder-pill').click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-picker.png` });
  await page.getByTestId('new-chat-folder').fill(TYPED);
  const create = page.getByTestId('folder-create');
  await expect(create).toContainText(TYPED);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-create-offered.png` });
  await create.click();
  await expect(page.getByTestId('folder-popup')).toHaveCount(0);
  expect(created).toEqual([TYPED]);
  await expect(page.getByTestId('new-chat-folder-path')).toHaveText(TYPED);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-created.png` });
});

test('sending to a missing typed path does not send and points at Create', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/folders/browse**', (r) => {
    const dir = new URL(r.request().url()).searchParams.get('dir');
    if (dir === TYPED) {
      return r.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'folder_not_found', message: 'nope' }),
      });
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hostId: 'd1', dir: null, parent: null, entries: [] }),
    });
  });
  await page.route('**/api/chats', (r) => {
    if (r.request().method() === 'POST') posts += 1;
    return r.fulfill({ status: 500, body: '{}' });
  });
  await page.goto(NEW);
  await page.getByTestId('new-chat-folder-pill').click();
  await page.getByTestId('new-chat-folder').fill(TYPED);
  await page.keyboard.press('Enter');
  const composer = page.getByTestId('composer-input');
  await composer.fill('hello');
  await composer.press('Enter');
  await expect(page.locator('.error-toast .msg')).toContainText('doesn’t exist yet');
  await expect(page.getByTestId('folder-create')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${process.env['NF_SHOTS']}/4-send-blocked.png` });
  expect(posts).toBe(0);
});
