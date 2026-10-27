# Releasing Patch

Open a PR; when its tests pass it merges itself, and the merge is the release.
`main` is protected: no direct pushes, and the `tests` check must be green.

0. **Tests** (`.github/workflows/test.yml`) run the full gate
   (`scripts/verify.mjs`, four shards) on every PR and every push to `main`.
   `pr-automerge.yml` turns on auto-merge for each PR (the merge queue sets the method);
   `pr-conflicts.yml` labels a PR `needs-rebase` and comments when main moves
   under it, for the chat that owns it to rebase and force-push.
1. **GitHub Actions** (`.github/workflows/release.yml`) builds every surface
   alongside the tests and waits for that commit's `tests` check: the
   server and web release, the Linux and macOS hosts, the signed and notarised
   desktop app, the APK and the phone's over-the-air update. When all of it
   builds, it is published as the prerelease `dev-<version>`.
2. **Each server** follows a channel and checks GitHub every two minutes
   (`packages/server/src/release-mirror.ts`). A new release is mirrored into the
   server's `downloads/`, and the server installs its own part of it
   (`self-update.ts`): the release's installer runs as a transient systemd unit,
   swaps `current`, restarts the server and waits for `/api/healthz`.
3. **Hosts, the desktop app and the phone** update from their server, as they
   always have: a host is told to update as it reconnects, the desktop app
   checks the feed, and the phone checks `/api/mobile/updates` for its signed
   over-the-air update — or, when a release needs a new APK, gets one push
   and installs it in place (spec/11 § Mobile updates).

A push reaches every device in roughly the build time (~25 min) plus two.

## Channels

```sh
patch-server channel dev       # every build of main
patch-server channel stable    # only promoted releases (the default)
patch-server channel off       # follow nothing
```

To mark a dev build stable — the same files, re-published, no rebuild:

```sh
node scripts/promote.mjs 1.1.42    # or no argument for the newest dev build
```

Versions are `<major>.<minor>.<commit count>` (`scripts/version.mjs`); bump
`version` in the root `package.json` for a new headline number.

## Where to look

| Question                      | Look at                                                                     |
| ----------------------------- | --------------------------------------------------------------------------- |
| Did it build?                 | `gh run list -R tomchambers2/patch`                                         |
| Is it published?              | `gh release list -R tomchambers2/patch`                                     |
| Did my server pick it up?     | `release mirror` / `self-update` lines in `~/.patch-server/logs/server.log` |
| Did the install work?         | `journalctl --user -u patch-server-update-*`                                |
| What is each surface running? | Settings → Updates                                                          |

## Pushing

Every push is public. The pre-push hook (`scripts/push-guard.mjs`) refuses
anything secret-shaped in the files a push changes.

## Secrets

The release workflow's secrets are listed at the top of `release.yml`. Copies of
every signing key are in the operator's password manager; losing the Android
keystore or the artifact signing key means every installed copy refuses
updates.

## The server install

The server runs from an installed **release**, never from a git checkout.
Everything live is in `~/.patch-server`:

| Path                  | What                                                           |
| --------------------- | -------------------------------------------------------------- |
| `versions/<release>/` | the current release and the two before it, for a hand rollback |
| `current`             | → the running release; the unit runs `current/patch-server`    |
| `data/`               | the server's state, including `release-channel`                |
| `downloads/`          | the update channel: host artifacts, APK, desktop feed          |
| `updates/`            | the release the server last unpacked to install                |
| `server.env`          | config + secrets (the unit's `EnvironmentFile`)                |
| `logs/server.log`     | the server's output                                            |

To roll back by hand, set the channel to `off` (or the next mirror check
reinstalls the newer release), point `current` at an older release and restart:

```sh
patch-server channel off
ln -sfn ~/.patch-server/versions/<release> ~/.patch-server/current
systemctl --user restart patch-server
```
