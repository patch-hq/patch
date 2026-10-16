import { test, expect } from '@playwright/test';

// spec/10 § Sign-in by approval, in a real browser against the real boot path:
// no credential stored, so the sign-in screen asks the (stubbed) server, the
// person types the code the other device showed, and the app takes the
// credential it gets back.

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}
const CREDENTIAL = `${b64url({ alg: 'EdDSA' })}.${b64url({ surface_id: 'web-e2e' })}.sig`;

test('asks, takes the code typed from the other device, and stores the credential', async ({
  page,
}) => {
  let approved = false;
  let redeemed: unknown = null;
  await page.route('**/api/auth/signin/request', (route) =>
    route.fulfill({ json: { id: 'r1', secret: 's1', expiresAt: Date.now() + 300_000 } }),
  );
  await page.route('**/api/auth/signin/r1/state**', (route) =>
    route.fulfill({ json: { state: approved ? 'approved' : 'pending' } }),
  );
  await page.route('**/api/auth/signin/r1/redeem', async (route) => {
    redeemed = route.request().postDataJSON();
    const code = (redeemed as { code: string }).code;
    if (code !== '123456') {
      await route.fulfill({ status: 403, json: { error: 'wrong_code' } });
      return;
    }
    await route.fulfill({ json: { credential: CREDENTIAL } });
  });
  // Whatever the booted app asks for afterwards is not under test.
  await page.route(
    (url) => url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/signin/'),
    (route) => route.fulfill({ status: 500, json: { error: 'not under test' } }),
  );

  await page.goto('/app/');
  await expect(page.getByTestId('signin-waiting')).toBeVisible();
  await expect(page.getByTestId('pairing-screen')).toContainText('Allow this sign-in');

  const input = page.getByTestId('signin-code-input');
  await input.fill('000000');
  await page.getByTestId('signin-redeem').click();
  await expect(page.getByTestId('signin-code-error')).toContainText('not right');

  approved = true;
  await input.fill('123456');
  await page.getByTestId('signin-redeem').click();
  await expect(page.getByTestId('pairing-screen')).toHaveCount(0);
  expect(redeemed).toEqual({ secret: 's1', code: '123456' });
  expect(await page.evaluate(() => localStorage.getItem('patch.credential.v1'))).toBe(CREDENTIAL);
});

test('a denied request says so and can be asked again', async ({ page }) => {
  let asks = 0;
  await page.route('**/api/auth/signin/request', (route) => {
    asks += 1;
    return route.fulfill({
      json: { id: `r${asks}`, secret: 's', expiresAt: Date.now() + 300_000 },
    });
  });
  await page.route('**/api/auth/signin/*/state**', (route) =>
    route.fulfill({ json: { state: 'denied' } }),
  );
  await page.goto('/app/');
  await expect(page.getByTestId('signin-ended')).toContainText('denied', { timeout: 10_000 });
  await page.getByTestId('signin-retry').click();
  await expect.poll(() => asks).toBe(2);
});
