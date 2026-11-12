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
  readlinkSync,
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
    timeout: 90_000,
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
async function quit(app: ElectronApplication, userData: string): Promise<void> {
  const proc = app.process();
  const finished = new Promise<void>((r) => {
    if (proc.exitCode !== null) return r();
    proc.once('exit', () => r());
    // The app has done all its quitting and is only held open by the test's
    // own debugger connection: Node waits for it to detach.
    proc.stderr?.on('data', (d: Buffer) => {
      if (d.toString().includes('Waiting for the debugger to disconnect')) r();
    });
  });
  // The page closes under the call as the app goes, so its answer may never come.
  void app
    .evaluate(({ app: a }) => {
      (a as unknown as { isQuitting: boolean }).isQuitting = true;
      a.quit();
    })
    .catch(() => undefined);
  await Promise.race([
    finished,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Patch did not quit within 30s')), 30_000),
    ),
  ]);
  // Whatever still holds the profile is the debugger-held husk: end it, and wait
  // until the process named in Chromium's lock is gone, or the next launch of
  // this profile sees "already running" and steps aside.
  const holder = (): number | null => {
    try {
      const pid = Number(readlinkSync(join(userData, 'SingletonLock')).split('-').pop());
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  };
  if (proc.exitCode === null) proc.kill('SIGKILL');
  const deadline = Date.now() + 15_000;
  for (let pid = holder(); pid !== null; pid = holder()) {
    if (Date.now() > deadline) throw new Error(`process ${pid} still holds ${userData}`);
    process.kill(pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Launch the app as a person does, with a debugging port, and return the
 * addresses of its windows once it has one at the app; then quit it.
 */
async function plainLaunch(c: { home: string; userData: string }): Promise<string[]> {
  const port = await freePort();
  const child = spawn(APP, [`--remote-debugging-port=${port}`], {
    env: {
      HOME: c.home,
      PATH: BARE_PATH,
      USER: process.env['USER'] ?? 'patch',
      TMPDIR: tmpdir(),
      PATCH_USER_DATA_DIR: c.userData,
    },
    stdio: 'ignore',
  });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  try {
    let pages: string[] = [];
    await expect
      .poll(
        async () => {
          const r = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
          if (!r?.ok) return false;
          pages = ((await r.json()) as Array<{ type: string; url: string }>)
            .filter((t) => t.type === 'page')
            .map((t) => t.url);
          return pages.some((u) => /\/app\//.test(u));
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    return pages;
  } finally {
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
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

/**
 * Skip the AI step as a newcomer might: it says once what that costs, then
 * carries on.
 */
async function skipAi(page: Page): Promise<void> {
  await page.getByTestId('welcome-skip').click();
  await expect(page.getByTestId('welcome-skip-note')).toHaveText(
    'Chats won’t run until you connect an AI. You can do it later from the banner in any chat.',
  );
  await shot(page, 'providers-skipped');
  await page.getByTestId('welcome-next').click();
}

/** Walk the welcome steps that are the same on both paths, with no AI connected. */
async function permissions(page: Page): Promise<void> {
  await expect(page.getByTestId('welcome-permissions')).toBeVisible();
  // The mode that asks first is called what it does, not "Default".
  await expect(page.getByTestId('welcome-mode-default')).toContainText('Ask');
  await page.getByTestId('welcome-mode-default').click();
  await expect(page.getByTestId('welcome-mode-default')).toHaveClass(/checked/);
  await shot(page, 'permissions');
  await page.getByTestId('welcome-next').click();
  // No AI, no models to choose between: the model step is not asked.
  await expect(page.getByTestId('welcome-model')).toHaveCount(0);
}

/** The phone step: the app download first, then on its own the pairing code. */
async function phone(page: Page): Promise<void> {
  await expect(page.getByTestId('welcome-phone')).toHaveAttribute('data-phase', 'app');
  await expect(page.getByTestId('welcome-apk-qr')).toHaveAttribute(
    'data-payload',
    'https://github.com/patch-hq/patch/releases/latest/download/Patch-android.apk',
  );
  await expect(page.getByTestId('welcome-qr')).toHaveCount(0);
  await shot(page, 'phone-app');
  await page.getByTestId('welcome-next').click();
  await expect(page.getByTestId('welcome-qr')).toBeVisible();
  await expect(page.getByTestId('welcome-apk-qr')).toHaveCount(0);
  await shot(page, 'phone-pair');
  await page.getByTestId('welcome-next').click();
}

/** What a newcomer's sidebar holds: nothing empty or unexplained. */
async function newcomerSidebar(page: Page): Promise<void> {
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.getByTestId('channels-toggle')).toHaveCount(0);
  await expect(page.getByTestId('sb-lifecycle')).toHaveCount(0);
}

/**
 * The first minutes in the app with no AI connected: nothing asks for meeting
 * permissions, the composer says why it can't send, and every "Sign in" goes
 * straight to signing in.
 */
async function firstChat(page: Page): Promise<void> {
  // Setup ends on a new chat, ready to type into — not on the Manager.
  await expect(page).toHaveURL(/\/chats\/new/);
  await expect(page.getByTestId('composer-input')).toBeVisible();
  const notice = page.getByTestId('composer-signed-out');
  await expect(notice).toHaveText(/Sign in to Claude to send messages\./);
  const banner = page.getByTestId('claude-disconnected-banner');
  await expect(banner).toBeVisible();
  // Meeting permissions wait until a meeting is started.
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('meeting-setup')).toHaveCount(0);
  await shot(page, 'new-chat');
  await notice.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/connect/);
  await expect(page.getByTestId('claude-signin-start')).toBeVisible();
  await shot(page, 'connect');
  await page.getByTestId('connect-close').click();
  await expect(page).toHaveURL(/\/chats\/new/);
  await banner.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/connect/);
  await page.getByTestId('connect-close').click();
  await expect(page).toHaveURL(/\/chats\/new/);
}

test('my own server: pairs by code, runs the welcome steps, and is remembered', async () => {
  const server = await throwawayServer();
  const computer = blankComputer();
  try {
    const app = await launch(computer);
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
    await skipAi(welcome);
    await permissions(welcome);
    // No keep-running step: this computer does not run Patch.
    await expect(welcome.getByTestId('welcome-keep-running')).toHaveCount(0);
    await phone(welcome);
    await expect(welcome).not.toHaveURL(/welcome/);
    await firstChat(welcome);
    await newcomerSidebar(welcome);

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
    await quit(app, computer.userData);

    // The next launch goes straight in: no question, no welcome. Started as a
    // plain process and read over its debugging port: Playwright's Electron
    // launcher does not return for a second launch of a profile that opens
    // its window at once, though the app is up (seen on CI and here).
    const pages = await plainLaunch(computer);
    expect(pages.some((u) => /\/app\//.test(u))).toBe(true);
    expect(pages.filter((u) => /welcome|setup\.html/.test(u))).toEqual([]);
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

  await skipAi(welcome);
  await permissions(welcome);

  // A brand-new host has a project folder for its first chat, named as the
  // person's own starting folder rather than after Patch.
  expect(existsSync(join(ACCOUNT_HOME, 'My first project'))).toBe(true);

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
  await phone(welcome);
  await firstChat(welcome);
  await newcomerSidebar(welcome);
  // With a host: the first chat's folder is the new starting folder, and the
  // model reads by the name setup used, never as an id.
  const first = welcome.getByTestId(`folder-quick-${join(ACCOUNT_HOME, 'My first project')}`);
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toHaveText('My first project');
  await expect(welcome.getByTestId('new-chat-setup')).not.toContainText('claude-');
  await shot(welcome, 'new-chat-this-computer');

  // The Manager says what it is, shows no empty Threads panel, and names the
  // model it starts on rather than "Choose a model…".
  await welcome.getByTestId('chat-row-thread_manager').click();
  await expect(welcome.getByTestId('empty-chat-line')).toHaveText(
    'Ask about any of your chats, or have it message them for you.',
  );
  await expect(welcome.getByTestId('threads-strip')).toHaveCount(0);
  await expect(welcome.getByTestId('chat-model')).not.toContainText('Choose a model');
  await shot(welcome, 'manager-this-computer');

  // Closing every window leaves the server answering: the phone can still reach it.
  const origin = new URL(welcome.url()).origin;
  for (const w of app.windows()) await w.close();
  await new Promise((r) => setTimeout(r, 2000));
  expect(app.process().exitCode).toBeNull();
  expect((await fetch(`${origin}/api/healthz`)).ok).toBe(true);
  await quit(app, computer.userData);
}
