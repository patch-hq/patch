import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listenForClaudeSignIn, startClaudeSignIn } from '../../auth/src/claude-signin.js';

// Claude sign-in from a signed-out browser profile. A stand-in claude.ai models
// the OAuth server: an authorize request with no session is sent to its login,
// and after login it resumes the ORIGINAL request, redirecting to the
// redirect_uri with the code. The real loopback listener from @patch/auth
// receives it. (The live claude.ai sits behind a bot check headless browsers
// cannot pass, so the live site cannot be driven from here.)

let fakeClaude: Server;
let base: string;

test.beforeAll(async () => {
  fakeClaude = createServer();
  await new Promise<void>((r) => fakeClaude.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fakeClaude.address() as AddressInfo).port}`;
});
test.afterAll(() => fakeClaude.close());

test('a signed-out browser goes through login and the code still reaches the server', async ({
  browser,
}) => {
  fakeClaude.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const signedIn = (req.headers.cookie ?? '').includes('session=ok');
    if (url.pathname === '/authorize' && !signedIn) {
      res.writeHead(302, { location: `/login?next=${encodeURIComponent(req.url ?? '/')}` }).end();
    } else if (url.pathname === '/authorize') {
      const to = new URL(url.searchParams.get('redirect_uri')!);
      to.searchParams.set('code', 'the-code');
      to.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: to.toString() }).end();
    } else if (url.pathname === '/login' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<form method="post" action="/login?next=${encodeURIComponent(url.searchParams.get('next') ?? '/')}"><button id="login">Sign in</button></form>`,
      );
    } else if (url.pathname === '/login') {
      res.writeHead(302, {
        'set-cookie': 'session=ok; Path=/',
        location: url.searchParams.get('next') ?? '/',
      });
      res.end();
    } else res.writeHead(404).end();
  });

  const state = 'state-1';
  const listener = await listenForClaudeSignIn(state);
  const started = startClaudeSignIn(undefined, {
    loopbackRedirect: listener.redirectUri,
    state,
  });
  const authorize = new URL(started.url);
  authorize.protocol = 'http:';
  authorize.host = new URL(base).host;
  authorize.pathname = '/authorize';

  // A brand-new context is a signed-out profile: no cookies, no storage.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(authorize.toString(), { waitUntil: 'commit' }).catch(() => undefined);
  await page.locator('#login').click();
  await expect.poll(async () => page.url()).toContain('/callback');
  await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible();
  expect(await listener.result).toEqual({ code: 'the-code' });
  await context.close();
});
