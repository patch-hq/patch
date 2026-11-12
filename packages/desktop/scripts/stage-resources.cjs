// Stage what the packaged app carries so "On this computer" can run a Patch server
// and a host with nothing installed and nothing downloaded (spec/05 § Desktop first
// run): the server release, and the host build for the platform being packaged
// (darwin-arm64 for the Mac app, linux-x64 for the AppImage). electron-builder
// copies build/staged/{server,host} into the app's resources.
//
// NO FALLBACK: an app packaged without either would ship a first-run choice that
// cannot be honoured, so a missing host build or a failed server build stops
// the packaging here, with what to run.
//
//   node scripts/stage-resources.cjs [--target=linux-x64]   (default: this machine)
//
// Exported for the test: stage({ repoRoot, desktopDir, buildServer, target }).

const { cpSync, existsSync, mkdirSync, readdirSync, rmSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/** The host target the app is packaged for, as the host builds name it (`darwin-arm64`). */
function targetFor(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/** The host files the app needs: the manifest, the installer, and the build for `target`. */
const wanted = (name, target = 'darwin-arm64') =>
  !/\.tar\.gz(\.sig)?$/.test(name) || name.includes(`-${target}.`);

function stage({ repoRoot, desktopDir, buildServer, target = targetFor() }) {
  const staged = path.join(desktopDir, 'build', 'staged');
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });

  const hostOut = path.join(repoRoot, 'dist', 'host');
  if (!existsSync(path.join(hostOut, 'host-latest.json'))) {
    throw new Error(
      `No host build at ${hostOut}. Run \`pnpm build:host\` first: the app carries the host it sets up on this computer.`,
    );
  }
  mkdirSync(path.join(staged, 'host'));
  let carried = 0;
  for (const name of readdirSync(hostOut)) {
    if (!wanted(name, target)) continue;
    cpSync(path.join(hostOut, name), path.join(staged, 'host', name), { recursive: true });
    if (name.endsWith(`-${target}.tar.gz`)) carried++;
  }
  // The local server hands this to `curl …/api/daemon/install.sh | sh`; without
  // it the host install answers 404 and the first run cannot finish.
  if (!existsSync(path.join(staged, 'host', 'install.sh'))) {
    throw new Error(`${hostOut} has no install.sh (the host installer build-host.mjs puts there).`);
  }
  if (carried === 0) {
    throw new Error(`${hostOut} has no ${target} host build; the app would have no host to install.`);
  }

  const release = buildServer(path.join(staged, 'server-build'));
  cpSync(release, path.join(staged, 'server'), { recursive: true, verbatimSymlinks: true });
  rmSync(path.join(staged, 'server-build'), { recursive: true, force: true });
  return staged;
}

function buildServerRelease(out) {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  execFileSync('node', [path.join(repoRoot, 'scripts', 'build-server.mjs'), `--out=${out}`, '--no-tarball'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  const dirs = readdirSync(out).filter((n) => n.startsWith('patch-server-'));
  if (dirs.length !== 1) throw new Error(`expected one patch-server-* release in ${out}, found ${dirs.length}`);
  return path.join(out, dirs[0]);
}

module.exports = { stage, wanted, targetFor };

if (require.main === module) {
  const desktopDir = path.resolve(__dirname, '..');
  const repoRoot = path.resolve(desktopDir, '..', '..');
  const flag = process.argv.find((a) => a.startsWith('--target='));
  const target = flag ? flag.slice('--target='.length) : targetFor();
  console.log(
    `[stage] ${target}: staged into ${stage({ repoRoot, desktopDir, buildServer: buildServerRelease, target })}`,
  );
}
