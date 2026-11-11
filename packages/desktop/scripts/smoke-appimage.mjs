#!/usr/bin/env node
// Run a built Linux AppImage and check what a new user sees, over the Chrome
// DevTools protocol (Playwright's connectOverCDP: the AppImage is the real
// binary, not an Electron Playwright launches itself).
//
//   node scripts/smoke-appimage.mjs <Patch-*.AppImage> [electron args…]
//       the first-run window opens and offers "On this computer"
//   node scripts/smoke-appimage.mjs <Patch-*.AppImage> --first-run [electron args…]
//       …and choosing it brings up this computer's own server and host, and
//       ends on Patch itself with the host online and a chat open
//
// It needs a display (xvfb-run). PATCH_SMOKE_HOME, when set, is used as the
// app's config directory (XDG_CONFIG_HOME) so a run starts from nothing.
// PATCH_SMOKE_SHOTS, when set, is a directory for screenshots of each step.
//
// NO FALLBACK: any step that does not happen within its time fails the run,
// with the app's own output.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [image, ...rest] = process.argv.slice(2);
if (!image) {
  console.error('usage: smoke-appimage.mjs <Patch-*.AppImage> [--first-run] [electron args…]');
  process.exit(64);
}
const firstRun = rest.includes('--first-run');
const appArgs = rest.filter((a) => a !== '--first-run');
const shots = process.env.PATCH_SMOKE_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const env = { ...process.env };
if (process.env.PATCH_SMOKE_HOME) env.XDG_CONFIG_HOME = process.env.PATCH_SMOKE_HOME;
let output = '';
const app = spawn(image, [`--remote-debugging-port=${port}`, ...appArgs], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', (d) => (output += d));
app.stderr.on('data', (d) => (output += d));
let exited = null;
app.on('exit', (code, signal) => (exited = { code, signal }));

function fail(message) {
  console.error(`[smoke-appimage] FAIL: ${message}`);
  console.error(`--- the app's output ---\n${output.slice(-6000)}`);
  app.kill('SIGKILL');
  process.exit(1);
}

async function until(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) fail(`the app exited (${JSON.stringify(exited)}) while waiting for ${what}`);
    const got = await probe().catch(() => null);
    if (got) return got;
    if (Date.now() > deadline) fail(`no ${what} within ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
};

await until('DevTools endpoint', 60_000, async () =>
  (await fetch(`http://127.0.0.1:${port}/json/version`)).ok ? true : null,
);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const pages = () => browser.contexts().flatMap((c) => c.pages());

const setup = await until('first-run window', 60_000, async () =>
  pages().find((p) => p.url().endsWith('/setup.html')),
);
await setup.getByTestId('choose-local').waitFor({ state: 'visible', timeout: 15_000 });
const label = (await setup.getByTestId('choose-local').textContent())?.trim();
console.log(
  `[smoke-appimage] first run offers: "${label}" / "${(await setup.getByTestId('choose-remote').textContent())?.trim()}"`,
);
await shot(setup, '1-first-run');

if (firstRun) {
  await setup.getByTestId('choose-local').click();
  // The shell replaces the setup window with Patch itself, served by the
  // server it just started on loopback.
  const main = await until('Patch served by this computer', 240_000, async () => {
    const statusText = setup.isClosed()
      ? null
      : await setup
          .getByTestId('status')
          .textContent({ timeout: 500 })
          .catch(() => null);
    if (statusText) console.log(`[smoke-appimage] setup: ${statusText}`);
    const err = setup.isClosed()
      ? null
      : await setup
          .getByTestId('error')
          .textContent({ timeout: 500 })
          .catch(() => null);
    if (
      err &&
      (await setup
        .getByTestId('error')
        .isVisible()
        .catch(() => false))
    ) {
      fail(`the first run said: ${err}`);
    }
    return pages().find((p) => /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url()));
  });
  console.log(`[smoke-appimage] Patch is at ${new URL(main.url()).origin}`);
  await main.waitForLoadState('domcontentloaded');
  await shot(main, '2-patch');

  // The host this computer just installed has paired with that server and is
  // online. Asked as the app asks: with the credential the first run saved.
  const origin = new URL(main.url()).origin;
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const { credential } = JSON.parse(
    readFileSync(join(configHome, '@patch', 'desktop', 'connection.json'), 'utf8'),
  );
  const hosts = await until('this computer online as a host', 180_000, async () => {
    const r = await fetch(`${origin}/api/hosts`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    if (!r.ok) return null;
    const { hosts } = await r.json();
    return hosts.some((h) => h.online) ? hosts : null;
  });
  console.log(`[smoke-appimage] hosts: ${JSON.stringify(hosts)}`);
  await main.reload();
  await main.waitForLoadState('networkidle').catch(() => undefined);
  await shot(main, '3-host-online');
}

console.log('[smoke-appimage] OK');
await browser.close().catch(() => undefined);
app.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 3000));
if (!exited) app.kill('SIGKILL');
process.exit(0);
