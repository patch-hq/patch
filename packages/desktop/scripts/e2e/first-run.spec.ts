// The packaged app's first run on a computer with nothing on it (spec/05 §
// Desktop first run, § Keep running): a fresh data folder, a fresh home folder
// and a bare PATH — no Homebrew, no Node, no Claude Code, never signed in.
//
// "My own server" runs anywhere: it pairs with a throwaway server started from
// the release the app itself carries.
//
// "This computer" installs a host as a login service, and the service has one
// label per user account, in the account's own home (Electron's home on macOS
// is the account's, whatever HOME says), so on a computer that already runs
// Patch it would replace that Patch's host. It runs only where PATCH_E2E_THIS_COMPUTER=1 says
// the computer is disposable (the CI Mac).

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

const APP =
  process.env['PATCH_DESKTOP_APP'] ??
  resolve(__dirname, '../../release/mac-arm64/Patch.app/Contents/MacOS/Patch');
const RESOURCES = resolve(APP, '../../Resources');
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const SHOTS = process.env['PATCH_E2E_SHOTS'];
const ACCOUNT_HOME = userInfo().homedir;

test.beforeAll(() => {
  if (!existsSync(APP)) {
    throw new Error(`No packaged app at ${APP}. Build it: node scripts/dist.cjs --dir`);
  }
});

function blankComputer(): { home: string; userData: string } {
  const root = mkdtempSync(join(tmpdir(), 'patch-blank-'));
  const home = join(root, 'home');
  mkdirSync(home);
  return { home, userData: join(root, 'user-data') };
}

let launches = 0;
async function launch(c: { home: string; userData: string }): Promise<ElectronApplication> {
  const app = await electron.launch({
    executablePath: APP,
    env: {
      HOME: c.home,
      PATH: BARE_PATH,
      USER: process.env['USER'] ?? 'patch',
      TMPDIR: tmpdir(),
      // A quiet instance: its own data, nothing on screen, no tray or hotkeys.
      PATCH_USER_DATA_DIR: c.userData,
      ...(process.env['PATCH_RELAY_URL']
        ? { PATCH_RELAY_URL: process.env['PATCH_RELAY_URL'] }
        : {}),
    },
    timeout: 5 * 60_000,
  });
  // What the app itself says, kept beside the screenshots for a failure to be read from.
  if (SHOTS) {
    const file = join(SHOTS, `app-${++launches}.log`);
    const keep = (d: Buffer): void => appendFileSync(file, d);
    app.process().stdout?.on('data', keep);
    app.process().stderr?.on('data', keep);
  }
  return app;
}

/** The host's and the server's own logs from a blank computer, for a failure to be read from. */
function keepLogs(c: { home: string; userData: string }, name: string): void {
  if (!SHOTS) return;
  for (const [from, to] of [
    // Only where this run installed the host: elsewhere it is another Patch's.
    ...(name === 'this-computer'
      ? ([[join(ACCOUNT_HOME, '.patch', 'logs'), `${name}-host-logs`]] as const)
      : []),
    [join(c.userData, 'server', 'logs'), `${name}-server-logs`],
  ] as const) {
    if (existsSync(from)) cpSync(from, join(SHOTS, to), { recursive: true });
  }
}

/** The app's window whose address matches, once it has one. */
async function windowAt(app: ElectronApplication, match: RegExp, timeout = 60_000): Promise<Page> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = app.windows().find((w) => match.test(w.url()));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `No window at ${match} within ${timeout / 1000}s; open: ${app
      .windows()
      .map((w) => w.url())
      .join(', ')}`,
  );
}

/** Quit as Quit Patch does, and wait for the process to be gone. */
async function quit(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  if (proc.exitCode !== null) return;
  const gone = new Promise<void>((r) => proc.once('exit', () => r()));
  // The page closes under the call as the app goes, so its answer may never come.
  void app
    .evaluate(({ app: a }) => {
      (a as unknown as { isQuitting: boolean }).isQuitting = true;
      a.quit();
    })
    .catch(() => undefined);
  await Promise.race([
    gone,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Patch did not quit within 30s')), 30_000),
    ),
  ]);
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

/** A Patch server of its own, from the release the app carries, and a pairing code for it. */
async function throwawayServer(): Promise<{ code: string; stop: () => void; origin: string }> {
  const home = mkdtempSync(join(tmpdir(), 'patch-own-server-'));
  for (const d of ['data', 'downloads', 'logs']) mkdirSync(join(home, d));
  const port = await freePort();
  writeFileSync(join(home, 'server.env'), `PORT=${port}\nHOST=127.0.0.1\n`);
  const env = {
    PATH: BARE_PATH,
    HOME: home,
    PATCH_SERVER_HOME: home,
    PATCH_NODE: APP,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(port),
    HOST: '127.0.0.1',
  };
  const launcher = join(RESOURCES, 'server', 'patch-server');
  const child: ChildProcess = spawn('/bin/sh', [launcher], { env, stdio: 'ignore' });
  const origin = `http://127.0.0.1:${port}`;
  await expect
    .poll(async () => (await fetch(`${origin}/api/healthz`).catch(() => null))?.ok ?? false, {
      timeout: 60_000,
    })
    .toBe(true);
  const out = execFileSync('/bin/sh', [launcher, 'pair', '--url', origin], {
    env,
    encoding: 'utf8',
  });
  const code = /patch-pair:\/\/\S+/.exec(out)?.[0];
  if (!code) throw new Error(`patch-server pair printed no code:\n${out}`);
  return { code, origin, stop: () => child.kill('SIGTERM') };
}

/** Walk the welcome steps that are the same on both paths. */
async function permissionsAndModel(page: Page): Promise<void> {
  await expect(page.getByTestId('welcome-permissions')).toBeVisible();
  await page.getByTestId('welcome-mode-default').click();
  await expect(page.getByTestId('welcome-mode-default')).toHaveClass(/checked/);
  await shot(page, 'permissions');
  await page.getByTestId('welcome-next').click();
  await expect(page.getByTestId('welcome-model')).toBeVisible();
  await shot(page, 'model');
  await page.getByTestId('welcome-next').click();
}

test('my own server: pairs by code, runs the welcome steps, and is remembered', async () => {
  const server = await throwawayServer();
  const computer = blankComputer();
  try {
    let app = await launch(computer);
    const setup = await windowAt(app, /setup\.html/);
    await expect(
      setup.getByRole('heading', { name: 'Where should your agents run?' }),
    ).toBeVisible();
    await shot(setup, 'where');
    await setup.getByTestId('choose-remote').click();
    await setup.getByTestId('pairing-code').fill(server.code);
    await shot(setup, 'pairing-code');
    await setup.getByTestId('connect').click();

    const welcome = await windowAt(app, /\/app\/welcome\?machine=server/);
    await expect(welcome.getByTestId('welcome-providers')).toBeVisible();
    // The credential was taken from the address, never left in it.
    expect(welcome.url()).not.toContain('credential=');
    await shot(welcome, 'providers');
    await welcome.getByTestId('welcome-skip').click();
    await permissionsAndModel(welcome);
    // No keep-running step: this computer does not run Patch.
    await expect(welcome.getByTestId('welcome-phone')).toBeVisible();
    await expect(welcome.getByTestId('welcome-qr')).toBeVisible();
    await shot(welcome, 'phone');
    await welcome.getByTestId('welcome-next').click();
    await expect(welcome).not.toHaveURL(/welcome/);

    // The permission mode chosen was written to the server's shared settings.
    const shared = await welcome.evaluate(async () => {
      const cred = Object.entries(localStorage).find(([k]) => /credential/i.test(k))?.[1];
      const r = await fetch('/api/settings/shared', {
        headers: { authorization: `Bearer ${cred}` },
      });
      return (await r.json()) as { settings: { permissionModeDefault: string } };
    });
    expect(shared.settings.permissionModeDefault).toBe('default');
    expect(existsSync(join(computer.userData, 'connection.json'))).toBe(true);
    expect(existsSync(join(computer.userData, 'keep-running.json'))).toBe(false);
    await quit(app);

    // The next launch goes straight in: no question, no welcome.
    app = await launch(computer);
    const main = await windowAt(app, /\/app\//);
    await expect(main).not.toHaveURL(/welcome|setup\.html/);
    await quit(app);
  } finally {
    keepLogs(computer, 'own-server');
    server.stop();
  }
});

test('the question can be declined: closing it quits, and nothing is remembered', async () => {
  const computer = blankComputer();
  const app = await launch(computer);
  const setup = await windowAt(app, /setup\.html/);
  const exited = new Promise((r) => app.process().once('exit', r));
  await setup.close();
  await exited;
  expect(existsSync(join(computer.userData, 'connection.json'))).toBe(false);
});

test('this computer: its own server and host, Claude Code and Codex installed, kept running', async () => {
  test.skip(
    process.env['PATCH_E2E_THIS_COMPUTER'] !== '1',
    'Installs a host as a login service, replacing any Patch host on this computer. Set PATCH_E2E_THIS_COMPUTER=1 on a disposable computer.',
  );
  const computer = blankComputer();
  try {
    await thisComputer(computer);
  } finally {
    keepLogs(computer, 'this-computer');
  }
});

async function thisComputer(computer: { home: string; userData: string }): Promise<void> {
  const app = await launch(computer);
  const setup = await windowAt(app, /setup\.html/);
  await setup.getByTestId('choose-local').click();

  const welcome = await windowAt(app, /\/app\/welcome\?machine=local/, 10 * 60_000);
  await expect(welcome.getByTestId('welcome-providers')).toBeVisible();

  // Claude Code arrives on a computer that had none, by its own installer.
  // Electron's home on macOS is the account's own, whatever HOME says, so the
  // host and the Claude Code it installs live there (another reason this path
  // only runs on a disposable computer).
  const claude = join(ACCOUNT_HOME, '.local', 'bin', 'claude');
  await expect.poll(() => existsSync(claude), { timeout: 10 * 60_000 }).toBe(true);
  await expect(welcome.getByTestId('welcome-claude-install-failed')).toHaveCount(0);
  expect(
    execFileSync(claude, ['--version'], {
      encoding: 'utf8',
      env: { PATH: BARE_PATH, HOME: ACCOUNT_HOME },
    }),
  ).toMatch(/Claude Code/);

  // Claude sign-in starts in the browser with no terminal: a claude.ai address.
  const signin = await welcome.evaluate(async () => {
    const cred = Object.entries(localStorage).find(([k]) => /credential/i.test(k))?.[1];
    const r = await fetch('/api/accounts/claude-code/signin', {
      method: 'POST',
      headers: { authorization: `Bearer ${cred}` },
    });
    return (await r.json()) as { url: string };
  });
  expect(new URL(signin.url).hostname).toBe('claude.com');

  // ChatGPT sign-in runs Codex, installed with no npm: it reaches the device code.
  await welcome.getByTestId('chatgpt-signin').click();
  await expect(welcome.getByTestId('chatgpt-login-pending')).toBeVisible({ timeout: 5 * 60_000 });
  await shot(welcome, 'chatgpt-pending');
  await welcome.getByRole('button', { name: 'Cancel sign-in' }).click();

  await welcome.getByTestId('welcome-skip').click();
  await permissionsAndModel(welcome);

  // Keep running: both on by default, remembered.
  await expect(welcome.getByTestId('welcome-keep-running')).toBeVisible();
  await expect(welcome.getByTestId('welcome-open-at-login').locator('input')).toBeChecked();
  await expect(welcome.getByTestId('welcome-keep-awake').locator('input')).toBeChecked();
  await shot(welcome, 'keep-running');
  expect(JSON.parse(readFileSync(join(computer.userData, 'keep-running.json'), 'utf8'))).toEqual({
    openAtLogin: true,
    keepAwake: true,
  });
  await welcome.getByTestId('welcome-next').click();
  await expect(welcome.getByTestId('welcome-phone')).toBeVisible();
  await welcome.getByTestId('welcome-next').click();

  // Closing every window leaves the server answering: the phone can still reach it.
  const origin = new URL(welcome.url()).origin;
  for (const w of app.windows()) await w.close();
  await new Promise((r) => setTimeout(r, 2000));
  expect(app.process().exitCode).toBeNull();
  expect((await fetch(`${origin}/api/healthz`)).ok).toBe(true);
  await quit(app);
}
