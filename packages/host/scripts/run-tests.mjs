// Host test entry point. The real-Chromium suites open visible windows and
// take focus when run on a desktop, so off Linux they run in a container on a
// virtual display instead. On Linux (CI, servers) everything runs in one pass.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BROWSER_TESTS = ['test/browser.test.ts', 'test/browser-tunnel.test.ts'];
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgDir, '../..');
const extraArgs = process.argv.slice(2);

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, stdio: 'inherit' }).status ?? 1;
}

if (process.platform === 'linux') {
  process.exit(run('pnpm', ['exec', 'vitest', 'run', ...extraArgs], pkgDir));
}

const hostStatus = run(
  'pnpm',
  ['exec', 'vitest', 'run', ...BROWSER_TESTS.flatMap((f) => ['--exclude', f]), ...extraArgs],
  pkgDir,
);

const image = 'patch-host-browser-tests';
let containerStatus = run(
  'docker',
  ['build', '-q', '-f', 'packages/host/Dockerfile.browser-tests', '-t', image, '.'],
  repoRoot,
);
if (containerStatus === 0) {
  containerStatus = run('docker', ['run', '--rm', '--init', image], repoRoot);
} else {
  console.error('run-tests: docker build failed; the browser tests did not run.');
}

process.exit(hostStatus || containerStatus);
