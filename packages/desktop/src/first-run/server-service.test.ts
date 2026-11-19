import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, startLocalService } from './local-server.js';
import {
  SERVER_SERVICE_LABEL,
  layOutRelease,
  serverPlist,
  serverPlistPath,
  serviceControl,
  type Launchctl,
  type ServiceControl,
} from './server-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(here, '..', '..', '..', 'server', 'release', 'patch-server');
const scratch = () => mkdtempSync(join(tmpdir(), 'patch-svc-'));

function release(root: string, gitSha = 'abc1234', name = 'server-release'): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'server/dist'), { recursive: true });
  mkdirSync(join(dir, 'web'), { recursive: true });
  cpSync(LAUNCHER, join(dir, 'patch-server'));
  writeFileSync(join(dir, 'web/index.html'), '<html></html>');
  writeFileSync(
    join(dir, 'build-info.json'),
    JSON.stringify({
      release: `r-${gitSha}`,
      version: '1',
      gitSha,
      builtAt: 'x',
      serverSha: gitSha,
    }),
  );
  writeFileSync(
    join(dir, 'server/dist/index.js'),
    `require('node:http').createServer((q, r) => { r.setHeader('content-type','application/json'); r.end(JSON.stringify({ ok: true, gitSha: ${JSON.stringify(gitSha)} })); }).listen(Number(process.env.PORT), process.env.HOST);
process.on('SIGTERM', () => process.exit(0));`,
  );
  return dir;
}

const node = { execPath: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };

test('the agent runs the launcher from the install home and comes back whenever it stops', () => {
  const plist = serverPlist(
    { home: '/h/server', node, port: 21000, relayUrl: 'wss://r' },
    '/Users/a',
  );
  assert.match(plist, new RegExp(`<key>Label</key><string>${SERVER_SERVICE_LABEL}</string>`));
  assert.match(plist, /<string>\/h\/server\/current\/patch-server<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>PORT<\/key><string>21000<\/string>/);
  assert.match(plist, /<key>HOST<\/key><string>127.0.0.1<\/string>/);
  assert.match(plist, /<key>PATCH_SERVER_HOME<\/key><string>\/h\/server<\/string>/);
  assert.match(plist, /<key>PATCH_RELAY_URL<\/key><string>wss:\/\/r<\/string>/);
});

test('laying out a release swaps `current` and keeps only the newest three', () => {
  const root = scratch();
  const home = join(root, 'home');
  const shas = ['a1', 'b2', 'c3', 'd4'];
  for (const sha of shas) {
    const moved = layOutRelease(home, release(root, sha, `rel-${sha}`), `r-${sha}`);
    assert.equal(moved, true);
    assert.equal(readlinkSync(join(home, 'current')), `versions/r-${sha}`);
  }
  assert.equal(layOutRelease(home, join(root, 'rel-d4'), 'r-d4'), false);
  assert.equal(existsSync(join(home, 'versions/r-a1')), false);
  assert.equal(existsSync(join(home, 'versions/r-b2')), true);
});

/** A launchctl that records calls and answers as launchd would about one job. */
function fakeLaunchctl() {
  const calls: string[] = [];
  let loaded = false;
  const fn: Launchctl = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'print') return { ok: loaded, output: '' };
    if (args[0] === 'bootstrap') loaded = true;
    if (args[0] === 'bootout') loaded = false;
    return { ok: true, output: '' };
  };
  return { fn, calls };
}

test('installing registers the agent once, restarts it only when it changed, and turning it off disables it', async () => {
  const userHome = scratch();
  const lc = fakeLaunchctl();
  const svc = serviceControl({ userHome, uid: 501, launchctl: lc.fn });
  await svc.install('<plist a/>', false);
  assert.equal(readFileSync(serverPlistPath(userHome), 'utf8'), '<plist a/>');
  const t = `gui/501/${SERVER_SERVICE_LABEL}`;
  assert.deepEqual(lc.calls, [
    `enable ${t}`,
    `print ${t}`,
    `bootstrap gui/501 ${serverPlistPath(userHome)}`,
  ]);
  lc.calls.length = 0;
  await svc.install('<plist a/>', false);
  assert.ok(!lc.calls.some((c) => c.startsWith('bootstrap') || c.startsWith('bootout')));
  lc.calls.length = 0;
  await svc.install('<plist b/>', false);
  assert.ok(
    lc.calls.some((c) => c.startsWith('bootout')) &&
      lc.calls.some((c) => c.startsWith('bootstrap')),
  );
  lc.calls.length = 0;
  await svc.turnOff();
  assert.deepEqual(lc.calls, [`disable ${t}`, `print ${t}`, `bootout ${t}`]);
});

test('a reinstall does not bootstrap until launchd has finished removing the old agent', async () => {
  const calls: string[] = [];
  let loaded = false;
  let stillRemoving = 0;
  const lc: Launchctl = async (args) => {
    calls.push(args[0] ?? '');
    if (args[0] === 'print') {
      if (stillRemoving > 0) {
        stillRemoving--;
        return { ok: true, output: '' };
      }
      return { ok: loaded, output: '' };
    }
    if (args[0] === 'bootout') {
      loaded = false;
      stillRemoving = 3;
    }
    if (args[0] === 'bootstrap') {
      if (stillRemoving > 0)
        return { ok: false, output: 'Bootstrap failed: 5: Input/output error' };
      loaded = true;
    }
    return { ok: true, output: '' };
  };
  const svc = serviceControl({ userHome: scratch(), uid: 501, launchctl: lc });
  await svc.install('<plist a/>', false);
  await svc.install('<plist b/>', false);
  assert.equal(loaded, true);
});

test('a launchctl failure is an error, not a silent skip', async () => {
  const svc = serviceControl({
    userHome: scratch(),
    uid: 501,
    launchctl: async (a) => ({ ok: a[0] === 'print', output: 'boom' }),
  });
  await assert.rejects(svc.install('<p/>', false), /enable .* failed: boom/);
});

/** A ServiceControl standing in for launchd: it runs the installed launcher itself, detached from the "app". */
function launchdStandIn(
  home: string,
  port: number,
): { svc: ServiceControl; children: ChildProcess[] } {
  const children: ChildProcess[] = [];
  const svc: ServiceControl = {
    loaded: async () => children.length > 0,
    turnOff: async () => undefined,
    install: async () => {
      children.push(
        spawn('/bin/sh', [join(home, 'current', 'patch-server')], {
          stdio: 'ignore',
          env: {
            PATH: process.env['PATH'] ?? '/usr/bin:/bin',
            ELECTRON_RUN_AS_NODE: '1',
            PATCH_SERVER_HOME: home,
            PATCH_NODE: process.execPath,
            PORT: String(port),
            HOST: '127.0.0.1',
          },
        }),
      );
    },
  };
  return { svc, children };
}

test("the service starts from the home's own copy of the release and stop() leaves it running", async () => {
  const root = scratch();
  const home = join(root, 'server');
  const port = await freePort();
  const { svc, children } = launchdStandIn(home, port);
  try {
    const server = await startLocalService({
      releaseDir: release(root),
      home,
      port,
      node,
      userHome: root,
      service: svc,
    });
    assert.equal((await fetch(`${server.origin}/api/healthz`)).status, 200);
    await server.stop();
    assert.equal(
      (await fetch(`${server.origin}/api/healthz`)).status,
      200,
      'quitting the app leaves it running',
    );
    assert.ok(existsSync(join(home, 'versions/r-abc1234/patch-server')));
  } finally {
    for (const c of children) c.kill('SIGKILL');
  }
});

test('an app-started server from before the move is stopped so the agent can take its port', async () => {
  const root = scratch();
  const home = join(root, 'server');
  const port = await freePort();
  for (const d of ['data', 'downloads', 'logs']) mkdirSync(join(home, d), { recursive: true });
  const old = release(root, 'old0000', 'old-release');
  const child = spawn('/bin/sh', [join(old, 'patch-server')], {
    stdio: 'ignore',
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      ELECTRON_RUN_AS_NODE: '1',
      PATCH_SERVER_HOME: home,
      PATCH_NODE: process.execPath,
      PORT: String(port),
      HOST: '127.0.0.1',
    },
  });
  child.once('exit', () => undefined); // reaped, as the app's own child is
  writeFileSync(join(home, 'server.pid'), String(child.pid));
  const { svc, children } = launchdStandIn(home, port);
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/healthz`)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const server = await startLocalService({
      releaseDir: release(root, 'new1111', 'new-release'),
      home,
      port,
      node,
      userHome: root,
      service: svc,
    });
    const body = (await (await fetch(`${server.origin}/api/healthz`)).json()) as { gitSha: string };
    assert.equal(body.gitSha, 'new1111');
    assert.equal(existsSync(join(home, 'server.pid')), false);
  } finally {
    child.kill('SIGKILL');
    for (const c of children) c.kill('SIGKILL');
  }
});
