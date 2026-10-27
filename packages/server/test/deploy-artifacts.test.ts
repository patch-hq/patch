// Group H1 (spec/11-deployment.md): the production deploy artifacts encode a
// hard contract that the spec calls out explicitly. These are static files
// (no YAML parser in the dep tree on purpose — the contract is about exact
// content), so we assert them by reading the checked-in files and matching the
// structural invariants:
//
//   - (docker-compose.yml removed: dc38968 moved server+host to systemd, and
//     the Caddy-only remainder existed solely to serve an in-repo production
//     site block prod never used -- prod Caddy lives on the box at /etc/caddy.)
//     patch-server runs as a native systemd user service from an installed
//     RELEASE (scripts/build-server.mjs), never from a git checkout.
//   - packages/server/release/patch-server: the launcher. Points the server at
//     the install home's data/downloads and the release's own web/, stamps the
//     build from the release's build-info.json, and never sets
//     ANTHROPIC_API_KEY (spec/10-auth.md "Claude OAuth — non-negotiable").
//   - packages/server/release/install: the installer every deploy runs.
//   - ANTHROPIC_API_KEY MUST NOT be assigned in any production deploy artifact.
//   - Caddyfile: reverse-proxies /api + /ws to patch-server:3000 and serves the
//     SPA at /app.
//   - release.yml publishes a release only when every surface built; each server
//     installs it with the release's own installer (src/self-update.ts);
//     `build:desktop` / `build:android` produce the app artifacts.
//   - backup.sh + install-backup-cron.sh: restic nightly cron on /data.
//   - fetch-models.sh: present/missing-aware model fetch with --check.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

const caddyfile = read('Caddyfile');
const launcher = read('packages/server/release/patch-server');
const installer = read('packages/server/release/install');

describe('H1 deploy artifacts — the server release launcher', () => {
  // What the systemd unit execs. The unit is written by the installer, outside
  // the repo; the launcher and installer are the version-controlled contract.
  it('runs the release it sits in, resolved through symlinks', () => {
    expect(launcher).toMatch(/pwd -P/);
    expect(launcher).toMatch(/\$\{REL\}\/server\/dist\/index\.js/);
  });

  it('points the server at the install home, never a checkout', () => {
    expect(launcher).toMatch(/PATCH_DATA_DIR="\$\{PATCH_SERVER_HOME\}\/data"/);
    expect(launcher).toMatch(/PATCH_DOWNLOADS_DIR="\$\{PATCH_SERVER_HOME\}\/downloads"/);
    expect(launcher).toMatch(/PATCH_WEB_DIST="\$\{REL\}\/web"/);
    expect(launcher.replace(/^\s*#.*$/gm, '')).not.toMatch(/deploy\//);
  });

  it('stamps the build from the release, not from git', () => {
    expect(launcher).toMatch(/build-info\.json/);
    expect(launcher).toMatch(/PATCH_VERSION=/);
    expect(launcher).toMatch(/PATCH_GIT_SHA=/);
    const code = launcher.replace(/^\s*#.*$/gm, '');
    expect(code).not.toMatch(/\bgit\b/);
  });

  it('never sets ANTHROPIC_API_KEY (spec/10 OAuth)', () => {
    // Claude Code auth is OAuth; the host additionally strips the key at
    // query() time. The server's env must not reintroduce it.
    expect(launcher).not.toMatch(/^\s*(export\s+)?ANTHROPIC_API_KEY\s*=/m);
    expect(installer).not.toMatch(/ANTHROPIC_API_KEY/);
  });
});

// The Caddyfile now configures ONLY the local test stack. Production routing
// lives on the Hetzner host at /etc/caddy/Caddyfile, outside this repo, so
// there is nothing here to assert about it -- and asserting the old in-repo
// `patch.tomchambers.me` block was actively harmful: it described a narrower
// set of proxied paths than prod really serves, and was read as prod routing
// when diagnosing the Google OAuth redirect_uri_mismatch.
describe('H1 deploy artifacts — Caddyfile (test stack)', () => {
  it('reverse-proxies /api and /ws to the test stack server', () => {
    expect(caddyfile).toMatch(/handle \/api\/\*[\s\S]*?reverse_proxy server:3000/);
    expect(caddyfile).toMatch(/handle \/ws[\s\S]*?reverse_proxy server:3000/);
  });

  it('serves the SPA at /app via the test stack server', () => {
    expect(caddyfile).toMatch(/handle \/app\*[\s\S]*?reverse_proxy server:3000/);
  });

  it('does not reintroduce an in-repo production site block', () => {
    // The hostname may appear in comments (the header explains where prod
    // actually lives); what must not come back is a real site block for it, or
    // the patch-server upstream that only the removed prod block used.
    expect(caddyfile).not.toMatch(/^[^#\n]*patch\.tomchambers\.me/m);
    expect(caddyfile).not.toMatch(/reverse_proxy\s+patch-server:/);
  });
});

describe('H1 deploy artifacts — deploy command + backup scripts', () => {
  it('a release is every surface or none, and a server installs it with its own installer', () => {
    // Releases are built by .github/workflows/release.yml and installed by each
    // server (src/self-update.ts) — the same installer a self-hoster runs.
    const workflow = read('.github/workflows/release.yml');
    // Nothing is published unless every surface built and this commit's test
    // run (test.yml) passed; the tests are not re-run here, they run alongside...
    expect(workflow).toMatch(/needs: \[tests, server, host, mac, android, mobile-update\]/);
    expect(workflow).not.toMatch(/PATCH_BROWSER_SHARD/);
    const tests = read('.github/workflows/test.yml');
    // ...on every push to main and every PR, as four shards behind one required check,
    expect(tests).toMatch(/pull_request:/);
    expect(tests).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(tests).toMatch(/shard: \['1\/4', '2\/4', '3\/4', '4\/4'\]/);
    expect(tests).toMatch(/\n  tests:\n[\s\S]*?needs: \[verify\]/);
    // with PRs merged by themselves once green, and conflicts handed back.
    expect(read('.github/workflows/pr-automerge.yml')).toMatch(/gh pr merge --auto/);
    // The merge queue sets the method and refuses -d/--delete-branch.
    expect(read('.github/workflows/pr-automerge.yml')).not.toMatch(
      /--delete-branch|--rebase|\s-d\s/,
    );
    expect(read('.github/workflows/pr-conflicts.yml')).toMatch(/needs-rebase/);
    // ...and the phone's over-the-air update is one of those surfaces: release
    // files the servers mirror, never published anywhere else first
    // (spec/11 § Mobile updates).
    expect(workflow).toMatch(/mobile-update:[\s\S]*?build-mobile-update\.mjs/);
    expect(workflow).not.toMatch(/EXPO_TOKEN|eas-cli|eas update/);
    // No second way to ship: the old box-and-Mac deploy is gone.
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts.deploy).toBeUndefined();
    expect(scripts['deploy:server']).toBeUndefined();

    const selfUpdate = read('packages/server/src/self-update.ts');
    expect(selfUpdate).toMatch(/'install'/);
    expect(installer).toMatch(/\$\{SYSTEMCTL\} restart patch-server/);
    expect(installer).toMatch(/SYSTEMCTL="systemctl --user"/);
    // It must verify what it installed rather than assume the restart worked.
    expect(installer).toMatch(/api\/healthz/);
  });

  it('exposes the app builds (desktop + android) as package scripts', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['build:desktop'] ?? '').toMatch(/@patch\/desktop/);
    expect(scripts['build:android'] ?? '').toMatch(/assembleRelease/);
  });

  it('backup.sh runs restic against the data dir and requires repo + password', () => {
    const backup = read('deploy/backup.sh');
    expect(backup).toMatch(/set -euo pipefail/);
    expect(backup).toMatch(/RESTIC_REPOSITORY/);
    expect(backup).toMatch(/RESTIC_PASSWORD/);
    expect(backup).toMatch(/restic backup/);
  });

  it('install-backup-cron.sh installs a NIGHTLY cron (runs once a day)', () => {
    const cron = read('deploy/install-backup-cron.sh');
    expect(cron).toMatch(/crontab/);
    // Default schedule is a single daily fire: "M H * * *".
    const m = cron.match(/PATCH_BACKUP_SCHEDULE:-([^}]+)\}/);
    expect(m).not.toBeNull();
    const schedule = m![1]!.trim();
    const fields = schedule.split(/\s+/);
    expect(fields).toHaveLength(5);
    // day-of-month, month, day-of-week all wildcards → fires every day (nightly).
    expect(fields[2]).toBe('*');
    expect(fields[3]).toBe('*');
    expect(fields[4]).toBe('*');
  });

  it('fetch-models.sh is present/missing aware (has a --check mode)', () => {
    const fetch = read('scripts/fetch-models.sh');
    expect(fetch).toMatch(/--check/);
    expect(fetch).toMatch(/kokoro/i);
    expect(fetch).toMatch(/medium\.en/);
  });
});

// The build context is what `docker build` copies into the builder before a
// single instruction runs. On the box, `deploy/downloads` holds every published
// host tarball, APK and desktop build — 2.7 GB and growing — and `COPY . .`
// duplicated all of it into the image layer, filling the disk and failing
// `pnpm ship server` with "no space left on device". Nothing in the build needs
// them: they are artifacts the box SERVES, not inputs it builds from.
describe('the docker build context', () => {
  const dockerignore = read('.dockerignore');

  it('excludes the published artifacts the box serves', () => {
    expect(dockerignore).toMatch(/^deploy\/downloads$/m);
  });

  it('still excludes the runtime data the containers write', () => {
    expect(dockerignore).toMatch(/^deploy\/data$/m);
    expect(dockerignore).toMatch(/^node_modules$/m);
  });
});

// spec/07 § Reaching a host's audio WSS: `/audio/:sessionId` is served
// by the SERVER, which relays it to the chat's own host. Proxying it straight
// to the local host's :3003 (what this installer and prod's Caddy once did)
// sends a session for a chat on another machine to a host that has never
// heard of it: "session_not_found: chat not found: <id>". `/device/*` is the
// one path that does belong to the local host.
describe('H1 deploy artifacts — the installer Caddyfile routes the audio plane', () => {
  const printed = execFileSync(
    'sh',
    [
      join(repoRoot, 'packages/server/release/install-server.sh'),
      '--print-caddyfile',
      '--domain',
      'patch.example.test',
    ],
    { encoding: 'utf8' },
  );

  it('sends /audio/* to the server, which relays it to the owning host', () => {
    expect(printed).not.toMatch(/\/audio\/\*[^\n]*\n[^\n]*reverse_proxy @\w+ 127\.0\.0\.1:3003/);
    const audioMatcher = printed.match(/@(\w+) path ([^\n]*)/g) ?? [];
    for (const line of audioMatcher) expect(line).not.toContain('/audio/');
  });

  it('still sends /device/* to the local host', () => {
    expect(printed).toMatch(/@\w+ path \/device\/\*\n\treverse_proxy @\w+ 127\.0\.0\.1:3003/);
  });
});
