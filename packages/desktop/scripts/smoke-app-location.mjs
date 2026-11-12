#!/usr/bin/env node
// Where the packaged Mac app lives, checked on the real thing (spec/05 §
// Desktop first run, § Keep running). For a disposable Mac (a CI runner): it
// moves apps into /Applications and registers login items.
//
//   node scripts/smoke-app-location.mjs move <Patch.app>
//       Opened from outside Applications on a first run, the setup asks to
//       move it. "Move" puts it in /Applications, this copy quits, and the
//       moved copy opens.
//
//   node scripts/smoke-app-location.mjs login-item <Patch.app> [<old Patch.app>]
//       Opened with a remembered "This computer" setup, the app's login item
//       is registered from <Patch.app>, as macOS's own background-items
//       database records it, and no longer from <old Patch.app>.
//
// PATCH_SMOKE_SHOTS, when set, is a directory for screenshots.
// NO FALLBACK: anything that does not happen in time fails the run, with the
// app's own output.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const [mode, bundleArg, oldArg] = process.argv.slice(2);
if (!['move', 'login-item'].includes(mode) || !bundleArg) {
  console.error('usage: smoke-app-location.mjs move|login-item <Patch.app> [<old Patch.app>]');
  process.exit(64);
}
const bundle = resolve(bundleArg);
const APP_ID = 'io.github.tomchambers2.patch';
const shots = process.env.PATCH_SMOKE_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const log = (m) => console.log(`[smoke-app-location] ${m}`);

const port = await new Promise((ok, no) => {
  const s = createServer();
  s.once('error', no);
  s.listen(0, '127.0.0.1', () => {
    const { port: p } = s.address();
    s.close(() => ok(p));
  });
});

let output = '';
const app = spawn(join(bundle, 'Contents/MacOS/Patch'), [`--remote-debugging-port=${port}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', (d) => (output += d));
app.stderr.on('data', (d) => (output += d));
let exited = null;
app.on('exit', (code, signal) => (exited = { code, signal }));

function fail(message) {
  console.error(`[smoke-app-location] FAIL: ${message}`);
  console.error(`--- the app's output ---\n${output.slice(-6000)}`);
  if (!exited) app.kill('SIGKILL');
  process.exit(1);
}

async function until(what, timeoutMs, probe, { exitOk = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited && !exitOk)
      fail(`the app exited (${JSON.stringify(exited)}) while waiting for ${what}`);
    const got = await probe().catch(() => null);
    if (got) return got;
    if (Date.now() > deadline) fail(`no ${what} within ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Patch processes running from a bundle, by pid. */
function runningFrom(path) {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((l) => l.includes(`${path}/Contents/MacOS/Patch`))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

await until('DevTools endpoint', 60_000, async () =>
  (await fetch(`http://127.0.0.1:${port}/json/version`)).ok ? true : null,
);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const pages = () => browser.contexts().flatMap((c) => c.pages());

if (mode === 'move') {
  const target = '/Applications/Patch.app';
  if (existsSync(target))
    fail(`${target} is already there; this needs a Mac without Patch installed`);
  const setup = await until('first-run window', 60_000, async () =>
    pages().find((p) => p.url().includes('/setup.html')),
  );
  await setup.getByTestId('move').waitFor({ state: 'visible', timeout: 15_000 });
  log(`asked: "${(await setup.locator('#move h1').textContent())?.trim()}"`);
  if (await setup.getByTestId('choose-local').isVisible())
    fail('the first-run question shows before the move is answered');
  if (shots) await setup.screenshot({ path: join(shots, '0-move.png') });
  await setup.getByTestId('move-yes').click();
  await until('this copy to quit after moving', 60_000, async () => exited, { exitOk: true });
  log(`this copy quit: ${JSON.stringify(exited)}`);
  if (!existsSync(join(target, 'Contents/MacOS/Patch'))) fail(`nothing at ${target} after Move`);
  log(`moved to ${target}`);
  const pids = await until(
    'the moved copy to open',
    60_000,
    async () => {
      const p = runningFrom(target);
      return p.length > 0 ? p : null;
    },
    { exitOk: true },
  );
  log(`the moved copy is running: pid ${pids.join(', ')}`);
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  await until('the moved copy to stop', 30_000, async () => runningFrom(target).length === 0, {
    exitOk: true,
  });
  process.exit(0);
}

// login-item: Patch itself, served by this computer, then what macOS holds.
const main = await until('Patch served by this computer', 120_000, async () =>
  pages().find((p) => /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url())),
);
log(`Patch is at ${new URL(main.url()).origin}`);
if (shots)
  await main.screenshot({
    path: join(shots, `login-item-${bundle.split('/').slice(-2, -1)[0]}.png`),
  });

/** The login items macOS holds for Patch: each one's URL and disposition. */
function patchLoginItems() {
  const dump = execFileSync('sudo', ['-n', 'sfltool', 'dumpbtm'], { encoding: 'utf8' });
  return dump
    .split(/\n\s*#\d+:\s*\n/)
    .filter((block) => block.includes(APP_ID))
    .map((block) => ({
      url: /URL:\s*(\S+)/.exec(block)?.[1] ?? '',
      disposition: /Disposition:\s*(.*)/.exec(block)?.[1] ?? '',
      block: block.trim(),
    }))
    .filter((i) => i.url.startsWith('file://'));
}
const want = `file://${encodeURI(bundle)}/`;
const items = await until(`a login item for ${bundle}`, 30_000, async () => {
  const found = patchLoginItems();
  return found.some((i) => i.url === want && /\benabled\b/.test(i.disposition)) ? found : null;
});
for (const i of items) log(`macOS holds: ${i.url} [${i.disposition}]`);
if (oldArg) {
  const old = `file://${encodeURI(resolve(oldArg))}/`;
  const stale = items.filter((i) => i.url === old && /\benabled\b/.test(i.disposition));
  if (stale.length > 0)
    fail(`the login item still opens ${old}:\n${stale.map((s) => s.block).join('\n')}`);
  log(`no login item opens ${old} any more`);
}
app.kill('SIGTERM');
await until('the app to stop', 30_000, async () => exited, { exitOk: true });
process.exit(0);
