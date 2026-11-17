// The desktop app's first-run page (packages/desktop/src/setup/setup.html,
// spec/05 § Desktop first run): the one question, "On this Mac" or "On my
// server", with the shell's bridge (`window.patchSetup`) stood in for by a
// recorder so the page can be driven on its own, in a real browser.

import { expect, test, type Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = `file://${join(dirname(fileURLToPath(import.meta.url)), '../../desktop/src/setup/setup.html')}`;

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w['__chosen'] = [];
    w['patchSetup'] = {
      defaultName: () => Promise.resolve('Test Mac'),
      choose: (c: unknown) => (w['__chosen'] as unknown[]).push(c),
      onProgress: (cb: (m: string) => void) => (w['__progress'] = cb),
      onFail: (cb: (m: string) => void) => (w['__fail'] = cb),
    };
  });
  await page.goto(PAGE);
}

// "This computer" asks for a name first; Continue sends the choice.
async function chooseLocal(page: Page): Promise<void> {
  await page.getByTestId('choose-local').click();
  await expect(page.getByTestId('computer-name')).toHaveValue('Test Mac');
  await page.getByTestId('start').click();
}

const chosen = (page: Page): Promise<unknown[]> =>
  page.evaluate(() => (window as never as { __chosen: unknown[] }).__chosen);

test.describe('first run', () => {
  test('asks one question with two answers, and nothing else', async ({ page }) => {
    await open(page);
    await expect(
      page.getByRole('heading', { name: 'Where should your agents run?' }),
    ).toBeVisible();
    await expect(page.getByTestId('choose-intro')).toContainText('Patch runs your AI agents');
    await expect(page.getByTestId('choose-local')).toContainText('This computer');
    await expect(page.getByTestId('choose-local')).toContainText('Patch runs here');
    await expect(page.getByTestId('choose-remote')).toContainText('My own server');
    await expect(page.getByTestId('join-form')).toBeHidden();
    await expect(page.getByTestId('error')).toBeHidden();
  });

  test('the name is editable, trimmed and required', async ({ page }) => {
    await open(page);
    await page.getByTestId('choose-local').click();
    await page.getByTestId('computer-name').fill('   ');
    await page.getByTestId('start').click();
    await expect(page.getByTestId('error')).toContainText('Give this computer a name');
    expect(await chosen(page)).toEqual([]);
    await page.getByTestId('computer-name').fill('  Studio  ');
    await page.getByTestId('start').click();
    expect(await chosen(page)).toEqual([{ kind: 'local', name: 'Studio' }]);
  });

  test('"On this Mac" makes the choice, locks the page, and shows what the shell reports', async ({
    page,
  }) => {
    await open(page);
    await chooseLocal(page);
    expect(await chosen(page)).toEqual([{ kind: 'local', name: 'Test Mac' }]);
    await expect(page.getByTestId('start')).toBeDisabled();
    await page.evaluate(() =>
      (window as never as { __progress(m: string): void }).__progress('server'),
    );
    const steps = page.getByTestId('steps').locator('li');
    await expect(steps).toHaveText([
      'Starting Patch',
      'Creating your account',
      'Setting up this computer',
      'Connecting',
    ]);
    await expect(steps.nth(0)).toHaveAttribute('data-state', 'active');
    await page.evaluate(() =>
      (window as never as { __progress(m: string): void }).__progress('host'),
    );
    await expect(steps.nth(0)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(2)).toHaveAttribute('data-state', 'active');
    await expect(steps.nth(3)).toHaveAttribute('data-state', 'pending');
  });

  test('a failed step is marked, the error is plain, and Try again returns to the choice', async ({
    page,
  }) => {
    await open(page);
    await chooseLocal(page);
    await page.evaluate(() => {
      const w = window as never as { __progress(m: string): void; __fail(m: string): void };
      w.__progress('host');
      w.__fail('Installing the host failed (1):\ncurl: (7)');
    });
    const steps = page.getByTestId('steps').locator('li');
    await expect(steps.nth(2)).toHaveAttribute('data-state', 'failed');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'done');
    await expect(page.getByTestId('error')).toContainText('curl: (7)');
    await page.getByTestId('retry').click();
    await expect(page.getByTestId('steps')).toBeHidden();
    await expect(page.getByTestId('choose-local')).toBeEnabled();
  });

  test('a failure is shown, the page unlocks, and it can be tried again', async ({ page }) => {
    await open(page);
    await chooseLocal(page);
    await page.evaluate(() =>
      (window as never as { __fail(m: string): void }).__fail(
        'Installing the host failed (1):\ncurl: (7)',
      ),
    );
    await expect(page.getByTestId('error')).toContainText('curl: (7)');
    await expect(page.getByTestId('start')).toBeEnabled();
    await page.getByTestId('start').click();
    expect(await chosen(page)).toEqual([
      { kind: 'local', name: 'Test Mac' },
      { kind: 'local', name: 'Test Mac' },
    ]);
    await expect(page.getByTestId('error')).toBeHidden();
  });

  test('"On my server" asks for the pairing code and sends it as typed, trimmed', async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId('choose-remote').click();
    await expect(page.getByTestId('join-form')).toBeVisible();
    await expect(page.getByTestId('pairing-code')).toBeFocused();
    await page.getByTestId('pairing-code').fill('  patch-pair://patch.example.com?nonce=abc \n');
    await page.getByTestId('connect').click();
    expect(await chosen(page)).toEqual([
      { kind: 'remote', input: 'patch-pair://patch.example.com?nonce=abc' },
    ]);
  });

  test('"Connect to an existing Patch" is its own choice and sends the pasted code', async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId('choose-existing').click();
    await expect(page.getByRole('heading', { name: 'Connect to an existing Patch' })).toBeVisible();
    await page.getByTestId('pairing-code').fill('patch-pair://?nonce=abc&relay=wss%3A%2F%2Fr');
    await page.getByTestId('connect').click();
    expect(await chosen(page)).toEqual([
      { kind: 'remote', input: 'patch-pair://?nonce=abc&relay=wss%3A%2F%2Fr' },
    ]);
  });

  test('an empty code is turned back on the page without bothering the shell', async ({ page }) => {
    await open(page);
    await page.getByTestId('choose-remote').click();
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('error')).toContainText('Paste the pairing code');
    expect(await chosen(page)).toEqual([]);
  });

  test('Back returns to the question', async ({ page }) => {
    await open(page);
    await page.getByTestId('choose-remote').click();
    await page.getByTestId('back').click();
    await expect(page.getByTestId('choose-local')).toBeVisible();
    await expect(page.getByTestId('join-form')).toBeHidden();
  });

  test('a rejected code leaves the form open to correct', async ({ page }) => {
    await open(page);
    await page.getByTestId('choose-remote').click();
    await page.getByTestId('pairing-code').fill('patch-pair://x?nonce=old');
    await page.getByTestId('connect').click();
    await page.evaluate(() =>
      (window as never as { __fail(m: string): void }).__fail('pairing nonce expired'),
    );
    await expect(page.getByTestId('error')).toHaveText('pairing nonce expired');
    await expect(page.getByTestId('join-form')).toBeVisible();
    await expect(page.getByTestId('pairing-code')).toBeEnabled();
    await expect(page.getByTestId('pairing-code')).toHaveValue('patch-pair://x?nonce=old');
  });
});
