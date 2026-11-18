# Deployment and installation

The server is deployed once by the operator, on an always-on box
(§ Server installation) or on a Mac as a background service (§ Server on a
Mac). A host is installed on each machine, from a signed binary artifact, onto
a machine that has only an OS on it (§ Host installation).

## Host sizing

≈4 dedicated cores, 16 GB RAM with hosted STT.

The voice configuration is Groq for Whisper STT + Kokoro local for TTS. Whisper's CPU load is offloaded to Groq for ~$3–5/month; Kokoro TTS runs on the host using ~1–2 cores during synthesis.

Resource budget on that sizing under typical load:

| Component                 | RAM                      | CPU peak                   | CPU sustained     |
| ------------------------- | ------------------------ | -------------------------- | ----------------- |
| patch-daemon (Node)       | ~500 MB                  | 1–2 cores                  | low               |
| patch-server (Node)       | ~200 MB                  | <1 core                    | low               |
| Agent backend + tools     | ~1 GB per active session | bursty                     | low between turns |
| Kokoro TTS                | ~600 MB                  | 1–2 cores during synthesis | idle              |
| Silero VAD (for barge-in) | <100 MB                  | <1%                        | <1%               |

Whisper STT runs on Groq (no local CPU cost). 4 cores easily handle the rest with headroom for concurrent voice sessions.

### Self-hosting Whisper

Set the speech setting to `local` (Settings, or `patch settings set speech-backend local`) and size the host at ≈8 dedicated cores, 32 GB RAM. `faster-whisper medium.en` runs real-time on 8 cores, ~1 GB RAM, 4–6 cores during transcription. Total time-to-first-audio is ~400ms slower than Groq.

That sizing covers a host running voice. A host on remote STT with no TTS
components installed needs headroom for Node and the agent's own work.

## Topology

One server; one host per host. The server and a host commonly share a
host, and deploy and update independently.

```
   ┌─────────────────────────────────────┐
   │  patch-server (deployed)     :443   │  Caddy → :3970
   │  relay · registry · webhooks        │  the only public component
   └───────▲──────────────────────▲──────┘
           │ outbound WS          │ outbound WS
  ┌────────┴─────────┐   ┌────────┴──────────────┐
  │ HOST: rented box │   │ HOST: laptop (behind  │
  │ (often the same  │   │ NAT — no inbound      │
  │  host as the  │   │ address needed)       │
  │  server)         │   │                       │
  │  patch-daemon    │   │  patch-daemon         │
  │   agent backend  │   │   agent backend       │
  │   Silero VAD     │   │   Silero VAD          │
  │   Kokoro (TTS)   │   │   (Kokoro/Whisper     │
  │   FULL HOST      │   │    optional per host) │
  │   ACCESS         │   │   FULL HOST ACCESS    │
  └────────┬─────────┘   └───────────────────────┘
           │ HTTP streaming
           ▼
     ┌─────────────────┐
     │   Groq cloud    │  Whisper large-v3-turbo
     │   (STT only)    │  ~$0.04/hour, ~50–100ms latency
     └─────────────────┘
```

Hosts dial out to the server, so a host behind NAT and without a fixed address
runs one as well as a rented box does. A server without a public address of its
own is reached by surfaces through a relay (§ Relay).

## Server installation

The server requires one long-lived process, a persistent data directory, TLS
termination, and a publicly reachable URL for webhook and push ingress. It is
built as a release and installed, the same way for every operator. The running server is never a git checkout:
nothing done to source (a build, `git stash -u`, `git clean`) can reach what is
live.

Pads (`14-design-web.md` § Pads) draw pictures of changes and card thumbnails in a headless Chromium on the server host, so the host needs one installed for the server's user (`npx playwright install chromium`). A Send or a thumbnail on a host without it fails with that reason; nothing else depends on it.

`pnpm build:server` builds one directory and a
tarball of it:

```
patch-server-<release>/
  patch-server        launcher — what the systemd unit runs
  install             installer
  server.env.example  config template
  server/             the server's dist + production node_modules (pure JS)
  web/                the SPA it serves at /app
  build-info.json     release, version, gitSha, builtAt, serverSha, web
```

The server and the SPA it serves are one release, so they cannot drift apart.
It is pure JavaScript and runs on any OS/arch with Node 20 or newer.

`<release>/install [--home DIR]` lays out the install home (default
`~/.patch-server`):

```
~/.patch-server/
  versions/<release>/   the current release and the two before it (rollback)
  current               -> versions/<release>, swapped atomically
  data/                 the server's state (registry, jobs, attachments, …)
  downloads/            the update channel: host artifacts, APK, desktop feed
  server.env            config + secrets, mode 600 — the unit's EnvironmentFile
  logs/server.log
```

A first install writes `server.env` from the template and carries straight on:
nothing in it is required (`01-server.md` § Starting with no settings).
`--public-url` records where devices reach the server, which the pairing code
and the host-install command carry. An install copies the release into
`versions/`, swaps `current`, writes and restarts the `patch-server` systemd
unit (a launchd agent on macOS, § Server on a Mac), and waits until `/api/healthz` reports the release's commit — failing
loudly, with the log tail, if it does not. `--system` writes a system unit
running as `--user` instead of a user unit; `--no-service` stops after the
layout, for machines without a service manager. The launcher points the server at `data/`,
`downloads/` and the release's own `web/` itself; `server.env` cannot move them.

`<home>/current/patch-server pair` asks the running server for a pairing code
and prints it as a QR and as text. The first run on a fresh server also makes
the account, keeping the credential it was given in `data/admin.credential`
(0600) to open the next pairing window.

### One command

On a fresh Linux box with systemd, `install.sh` — published beside the release
tarball, its checksum and a copy of the tarball under a name that never
changes — installs a server with HTTPS:

```
curl -fsSL https://<server>/api/server-release/install.sh | sudo sh [-s -- --domain NAME] [--email ADDR]
```

It makes a `patch` user, installs the release into `/var/lib/patch-server` as a
system service, provisions Node 22 into that home when the box has no Node 20+,
and runs Caddy (`patch-caddy.service`, its own binary, nothing shared with a
Caddy the box already has) as the TLS front: a Let's Encrypt certificate for
`--domain`, or with none for `<ip>.sslip.io`, a name that resolves to the box's
own address so there is nothing to register. Ports 80 and 443 must be free and
reachable. It then waits for the certificate, makes the account and prints the
first pairing code, and leaves `patch-server` on the path for the next
(`patch-server pair`). Running it again upgrades.

Every download is checked against its published checksum before anything
installs, and a failure at any step stops it with the reason. `--no-https`
serves plain HTTP on `:3970` for a LAN or an existing proxy; `--user-mode`
installs for the current user with no root and no HTTPS, to try it out.

Put a TLS reverse proxy in front of `PORT` (Caddy, nginx), sending `/device/*`
to the host's port and everything else — `/audio/*` included — to the server, which relays each voice session to the host that owns the chat (`07-voice-app.md` § Reaching a non-Manager host's audio WSS).

Instead of a port, the server can listen on a Unix socket (`PATCH_SOCKET`, an
absolute path; the port stays the default). Nothing that clears ports can find
or kill a socket. It cannot be combined with a relay, which tunnels to a TCP
port. The installer offers it with `--socket [PATH]` (default
`/run/patch/server.sock`, HTTPS installs only): systemd creates the directory,
Caddy joins the server's group and proxies with `reverse_proxy unix//run/...`,
and `patch-server pair` follows `PATCH_SOCKET`.

## Server on a Mac

On a Mac the server is its own launchd service, like the host (`02-host.md`
§ Desktop app and the local host). Choosing "This computer" in the desktop
app's first run (`05-surfaces.md` § Desktop first run) installs the server
release the app carries into an install home laid out as in § Server
installation, registers it as a launchd agent for the user, and starts it.
The desktop app is only a window onto it: quitting the app leaves the server
running, and opening the app again connects to the running server. The server
runs while the Mac is awake; it stops when the user turns it off (Settings →
Hosts), when the Mac sleeps and when it shuts down, and starts again at login
and on wake. A newer desktop app installs the server release it carries and
restarts the service onto it.

The agent is `io.github.patch-hq.server`, registered from
`~/Library/LaunchAgents`, running the install home's `current/patch-server`
with the app's own Node on a loopback port chosen once and kept. The home is the
app's `server` folder (`data/`, `downloads/`, `logs/`, `versions/`, `current`).
Turning the server off in Settings → Hosts stops the agent and disables its
label, so it stays off through logins until the app is opened again, which
enables it and starts it. A desktop install from before the agent, whose app
started the server as its own child process, is migrated on its next launch:
the child is stopped once, the same folder becomes the agent's home, and nothing
in `data/` moves.

## Moving the server

The server's data folder is self-contained (`01-server.md` § Data folder), so
moving the server to another machine is carrying that folder across: stop the
server, copy the folder into the new machine's install home, install the
server there (§ Server installation, § Server on a Mac) and start it. It comes
up as the same server, with the same accounts, chats, credentials and relay
channel. Hosts and devices that reach it through its relay channel follow it
at once; those that reach it by address follow once that address points at
the new machine. The old copy is not started again: two servers running from
one folder's contents would each accept hosts' outboxes.

## Relay

`patch-relay` is the relay of `10-auth.md` § Relay: one small Node process with
no state and nothing to configure but `PORT` (default 8787). It is run behind a
TLS reverse proxy that passes WebSocket upgrades (`reverse_proxy 127.0.0.1:8787`
in Caddy), and the address people use is its `wss://` address. A server uses a
relay when `PATCH_RELAY_URL` names one; a server the desktop app installs on a
Mac uses the project's hosted relay unless that is set. Anyone may run their own and point
their servers at it.

The project's hosted relay is `wss://relay.patchhq.dev`: the same protocol as a
Cloudflare Worker with one Durable Object per channel.
Its sockets hibernate, so a connected but quiet channel costs nothing, and it
runs on Cloudflare's free plan. The release workflow deploys it from `main` when
the relay's code changes. One set of behaviour tests
runs against the Node relay, against the Worker under `wrangler dev`, and against
the live address.

## Host installation

The host is built as a per-OS/arch binary artifact and installed; the runtime
model and first-run contract are in `02-host.md` § Runtime and installation.

The artifact holds one bundled JS file (the host and its pure-JS dependencies),
a pinned Node runtime, the platform's native addons — currently
`onnxruntime-node` for Silero VAD — and `silero_vad.onnx` itself, the one model
weight inside the artifact, at ~2 MB. Targets are macOS arm64 and Linux
x64/arm64. macOS x64 is not a target: `onnxruntime-node` ships no darwin-x64
binary, and every artifact carries VAD rather than making it an optional
download, so the target cannot be built. Requirements on the result:

- It installs and runs on a host carrying only an OS.
- It is signed with the project's signing identity, which is what the self-update path verifies against.
- It reports its version, which drives the stale-host indicator in Settings →
  Hosts and the host's self-update against the server's manifest.

The agent backend, the large voice weights (Kokoro TTS, local Whisper) and Python
stay outside the artifact and are provisioned on the host (`02-host.md`). Voice
is optional at install, but the first meeting on a host with no speech set up
prompts the user to add a speech API key or download these models
(`02-host.md` § Speech set-up).
Carrying them would put CPU-torch, a spaCy model and a multi-GB weights set into
every install on every host, ahead of any use of voice. Those two components
install into a host-local components directory, with a Python environment the
host provisions at that point (`18-tech-stack.md`). Silero VAD's weights are
the exception the size test allows in: ~2 MB, needed by every host, so they ride
in the artifact (`02-host.md` § Installation).

Updating never waits unboundedly. Each network step of a host self-update (the
manifest check, the artifact download) is limited to 2 minutes, extraction to 2
minutes and the installer to 5 minutes; a step that overruns ends the attempt
with a message naming what timed out, and the update can be requested again.
The desktop
shell's update check is likewise limited to 2 minutes and runs one at a time;
overrunning is recorded as a failed check, never as up to date. An attempt that
could stall forever blocks every later request, because requests join the
attempt in flight.

## Replacing a host

A chat lives on one host for its whole life, and chats are never moved between
hosts automatically. Replacing a host is the deliberate step by which a new
machine takes over an old host's chats: Settings → Hosts → ⋯ on the old host →
Replace with…, which guides it through:

1. Install a host on the new machine (§ Host installation), if it has none.
2. Carry the old host's project folders and its provider session files across
   unchanged, to the same paths. The guide lists every folder the old host's
   chats use and where each provider keeps its session files on it.
3. Confirm. The new host checks that every listed folder is present and says
   which are missing; the user fixes them or confirms without them.

On confirming, the server rebinds every chat of the old host to the new one,
hands it the messages held for the old host, and removes the old host from the
account. The new host continues each chat from the server's high-water mark
(`01-server.md` § Responsibilities); a chat whose provider session
did not come across stays readable and cannot continue with the model's memory
(`04-chats-and-folders.md` § History).

## Env

`~/.patch-server/server.env` on the server host (written by the installer, never
committed). Everything in it is optional (`01-server.md` § Starting with no
settings):

```
# Where devices reach this server, for the addresses it hands out.
PATCH_PUBLIC_URL=https://patch.<your-domain>
# User timezone. The default zone the CLI puts on a cron trigger it creates; a job
# carries its own zone thereafter (see 08-triggers-and-jobs.md).
TZ=Europe/London

# Providers
TODOIST_WEBHOOK_SECRET=...

# Push (Android) — nothing to set here. The server posts to Expo's push API,
# which takes no server-side credential; the FCM V1 credentials that actually
# reach the device are a one-time upload to the EAS project (see § Mobile updates).

# Voice
# The speech engine is the in-app `speechBackend` setting, not an env var.
GROQ_API_KEY=...             # or set it in Settings → Providers
# GEMINI_API_KEY / OPENAI_REALTIME_API_KEY — hosted voice. Optional here:
# provider keys can be set from Settings → Providers instead (shared by every
# host, stored on the server), which wins over the environment
# (02-host.md § Provider keys).
# Voice model files are downloaded by the host on demand into its own
# host-local components directory, which the host resolves itself
# (02-host.md § Optional components).

# Agent backend credential (host)
# Optional. This host's own login, like `claude login`: adopted as the first
# shared account when the server holds none, and offered for adoption from
# Settings otherwise. The shared accounts on the server are what turns use.
# See 10-auth.md.
CLAUDE_CODE_OAUTH_TOKEN=...
```

`GROQ_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are read by the
host, so they are set in the environment of each host's service rather than in
the server's env — or, for the provider keys, from Settings → Providers, which
stores them on the server and sends them to every host. The rest are the
server's.

## Deploy guide

Canonical source is `main`. Deploying the server means building a release and
installing it (§ Server installation):

```sh
pnpm build:server                                   # → dist/server/patch-server-<release>/
dist/server/patch-server-<release>/install          # installs into ~/.patch-server
```

A server following a release channel does exactly that for itself, with each
release it mirrors.

The desktop app, the Android app and the host are builds, not
deployments — artifacts a person installs:

```sh
pnpm build:desktop   # Mac app → /Applications (signed release needs Apple creds); carries the server release and this Mac's host build
pnpm build:android   # APK — no server address is built in
pnpm build:host    # host artifacts per OS/arch → published for install + self-update
```

The host artifacts are published to the server, which serves them with a
version manifest: that one channel feeds both a new host's install command and
every existing host's self-update (`02-host.md`).

Nothing host-specific is committed. Getting a build to a particular place — a
remote box, a phone — is host-specific and lives in a git-ignored
`scripts/local/`.

The rules that must hold, wherever it runs:

- a server deploy completes without touching any host. Hosts dial out and
  reconnect with backoff (`12-error-and-offline.md`), so a server restart drops
  every host's link and each host restores itself. Chats in flight keep
  running, hosts resend what the server had not acknowledged
  (`01-server.md` § Host outbox), and nothing is marked failed because
  the link dropped.
- server and host versions are independent. The wire protocol is the
  compatibility contract: the server states the host version range it supports,
  and a host outside that range is shown as needing an update.
- web is part of the server release, so a server deploy always carries the
  current UI. A UI-only deploy assembles a release around the RUNNING release's
  server, so it never ships a new server
  version, and restarts the server onto it.
- SPA cache headers make new deploys land immediately. The server serves
  `/app/index.html` (and the SPA-fallback routes) with `Cache-Control: no-store`
  — the HTML is NEVER cached, so any load/reload fetches the current document,
  which references the current content-hashed bundles. The hashed build assets
  (`/app/assets/*`) are served `Cache-Control: public, max-age=31536000,
immutable` — safe to cache forever because a rebuild changes their filename.
  This is what lets a surface pick up a deploy on an ordinary reload, with no
  force-reload. See `14-design-web.md` § Live updates for the in-app watcher
  that makes the reload automatic.
- mobile: native vs JS. A native change (new module, permission, icon,
  `app.config` plugin, `version` bump) needs a fresh APK; a JS-only change
  ships over the air (§ Mobile updates) with no reinstall.
- verify, don't trust exit 0. Poll `GET /api/healthz` until `gitSha` matches
  HEAD (fail loudly on timeout); assert the published APK URL returns 200. NO
  FALLBACK — any failed step aborts.

### Updates in lockstep

Server and hosts must run one version, because the wire protocol can change
between versions. A release therefore costs each host one drop, not two:

- When the server sees a mirrored release newer than itself, it sends every
  connected host (and each host that connects while the release is waiting)
  `host.stage {version}`. The host downloads and verifies that build and keeps
  it staged, without installing. A host with auto-update off ignores it.
- When the server restarts into that release, its going-away notice carries the
  target version (`server restarting into <version>`). A host with exactly that
  version staged installs it at once, from the staged copy, without contacting
  the server (which is down). The server and the host come back together.
- A host without it staged (offline, failed download) updates on reconnect: the server sees it behind and sends `host.update`.
- The swap does not wait for running turns: every turn and other piece of
  host work survives a host restart (`02-host.md` § Host restarts).
- A failed stage is logged as an error and the host falls to the reconnect
  update; it is never hidden.
- Staged builds live in `<patchHome>/staged/<version>`; those at or below the
  running version are removed on start.

### One update switch

One account-wide switch, Update automatically, decides whether any part of
Patch moves to a new release: the server, every host and the desktop app.
Updating one part on its own while the switch is off is a bug.

- On: releases are mirrored and installed as they appear, the server first and
  the hosts behind it (§ Updates in lockstep). The user sees nothing except one prompt in the window.
- Off: the release mirror only notes which release is on offer
  (`release-available.json`); it downloads nothing, so nothing a host or the
  desktop app reads from the server moves, and the server does not install
  itself. Settings → Updates shows the version, the one available, and one
  button, Update everything (`POST /api/update-all`). That lifts the hold for
  one release: the server mirrors and installs it, then tells every host to
  update. The hold returns once the server and every online host are on it, or
  after two hours if that never happens.
- `GET /api/version` reports `release: { available, autoUpdate, updating }`.
- The window has one prompt, never two: "A new version of Patch is ready." with
  one Restart button. It appears when the desktop app has a build staged or the
  page has a newer deploy, and pressing it does whatever is needed: relaunch
  the app into its staged build, or reload the page. Hosts and the server never
  prompt. A restart that fails says so and says what to do.

## Mobile updates (Android)

The phone updates the way the hosts and the desktop app do: from the server it
is paired to, which mirrors the GitHub release on the channel it follows. Nothing
reaches a phone that is not in a release, and a stable server's phones get only
stable code.

- Two kinds of update. A JS-only change ships over the air: no new APK, no
  reinstall. A native change (new module, permission, `app.config` plugin)
  bumps the app's `runtimeVersion` and needs a new APK,
  which the phone installs in place (below). An over-the-air update is only
  ever offered to a phone on its own runtime, so JS can never land on native
  code it needs and does not have.
- Built and signed in CI. The release workflow runs
  `expo export` for android (with this
  commit's version stamps, checked present in the bundle), then an Expo Updates
  manifest naming every file by its URL on the GitHub release, signed with
  `PATCH_UPDATE_SIGNING_KEY`. The bundle and its assets become release files
  (`mobile-update-<md5>.<ext>`) beside `mobile-update.json`, the signed manifest.
  Promoting a release re-publishes the same files, so the signature still holds.
- Served by the server. The release mirror copies `mobile-update.json` (and not
  the files it names, which stay on the release). `GET /api/mobile/updates` is
  the update check (Expo Updates protocol v1, unauthenticated like the APK
  download): the signed manifest, relayed byte for byte with its
  `expo-signature`, to a phone on the same runtime; `204` to a phone on another
  runtime or already running it; `404` when nothing is published. The server
  cannot change what a phone runs — the manifest pins every file by hash and
  the app refuses a manifest not signed by the key behind its certificate —
  only whether it is offered.
- Pointed at by the app. The APK has no server address built in, so the app
  hands the paired server's `/api/mobile/updates` to expo-updates at runtime
  (`setUpdateURLAndRequestHeadersOverride`, which needs
  `disableAntiBrickingMeasures`; code signing is what makes that safe, and
  expo-updates still rolls back an update that crashes on launch). The
  override takes effect from the next launch, and nothing checks before a
  launch is using it: there is no native check on launch
  (`checkAutomatically: 'NEVER'`), and the app checks only once the override
  was in place when the launch began. A phone
  reached through the relay cannot use it — native code has no relay
  connection — and moves on by installing APKs; Settings → Updates says so.
- Checking. The app checks at launch, every 30 minutes and on every return to
  the foreground, and only downloads. NO automatic reload: expo-updates
  launches a downloaded bundle at the next cold start. The one reload is the user's: Settings →
  Updates → "Restart to update".
- A new APK. `android-latest.json` carries the APK's `runtimeVersion`. When it
  differs from the last one announced, the server sends the phone one silent
  push (`kind: 'app-update'`, never held back by presence), linking the APK on
  the release; it records what it announced on disk, since it restarts itself
  to install the release that carries the news. A tap downloads the APK inside
  the app and opens Android's installer (`expo-intent-launcher`,
  `REQUEST_INSTALL_PACKAGES`); Android asks the user to confirm, as it does for
  anything installed outside a store. The chat list shows an
  "Install Patch <version>" banner, and Settings → Updates an Install row,
  whenever the published APK is newer and on another runtime.
- Downloaded ahead of time. As soon as the app reads a published APK that needs
  installing (on launch, every half hour, on return to the foreground), it
  downloads it in the background into the cache (written as `.part`, renamed
  when whole) and posts one local notification per version, "Patch <version> is
  ready to install". Tapping it, or Install, opens Android's installer on the
  staged file with no further download. A failed background download is shown
  as an error and retried on the next read.
- The signing key. `PATCH_UPDATE_SIGNING_KEY` is in the password manager
  (`patch-update-signing-key`); its certificate ships in
  the app, valid to 2056. Losing the key means no
  installed app accepts another over-the-air update until it installs an APK
  carrying a new certificate.
- Push credentials, not updates. Notifications still go through Expo's push
  API, and that is the one thing the EAS project is for: the Firebase
  project's FCM V1 service-account key is uploaded to it once by the app
  publisher (`eas credentials`), which is what lets Expo deliver to the device.
  `google-services.json` stays committed so the native build links to that
  Firebase project; neither credential is read by the server.

## Version reporting

Patch ships four independently-deployable layers down unrelated delivery paths:
the server and web SPA (one installed release), the host (a per-OS artifact
each host self-updates to), the desktop shell (a packaged
Electron app on each Mac), and the Android app (APK + OTA). Any of them can be
left behind by a delivery that only touched the others, and the host layer can
differ from host to host.

Rules.

- Every layer is stamped. One source of truth yields
  `<major>.<minor>.<commit count>` plus a short git sha and build instant. The
  patch component is the commit count, so versions increase monotonically without
  manual bookkeeping — a hard requirement for electron-updater, which compares
  semver, not shas. The web build emits `dist/version.json`; the desktop build
  emits `dist/build-info.json`; the server release carries them in
  `build-info.json`; the host carries the
  same three stamped into its artifact and reports them on `host.host`; the APK
  inlines `EXPO_PUBLIC_PATCH_*`.
- Clients report themselves. The WS `hello` carries `clientVersion` plus
  optional `clientGitSha` / `clientBuiltAt`, recorded into presence. This is the
  only way to answer "what is my phone actually running?" — a published APK says
  nothing about whether a device installed it. For an OTA launch the mobile client
  reports the OTA bundle's creation time, not the APK's, so JS-only drift is
  visible too.
- `GET /api/version` (authed) reports every layer, each linked device, and any
  drift between them, with a remedy per item. It re-reads the mounted web-dist
  and downloads dir per request, so a check reflects the box as it is now.
  `/api/healthz` stays the public, minimal LB probe.
- Settings → Updates states whether Patch is up to date and offers a single
  Update control when it is not, plus Check now, the auto-update toggle and
  when it last checked. A Versions group states, for the Patch app (desktop
  shell only) and the server, the installed version and the latest available one
  ("Installed 0.1.317 · Latest 0.1.320"); each host row likewise shows its
  installed version and, when it is behind, the latest (the server's version —
  hosts run in lockstep with it). The page shows no shas, drift detail or developer
  commands. Patch works out what is behind (hosts, drift, the app, the APK) and
  the one Update acts on it. Running chats never hold a host's update, so a host row has no waiting state and no
  force control. A failed read or failed shell check reads as
  "Couldn't check", never as up to date. `GET /api/version` still carries the
  full per-layer report for diagnostics.
- Unknown reads as unknown. An unstamped, missing or unreadable layer is
  reported as such. A malformed report is rejected at the client boundary so a partial response reaches the panel's error state
  instead of rendering as "all layers agree".
- A delivery that leaves the server inconsistent fails. Every path that
  changes what the server serves ends by asserting its own `/api/healthz` and `/app/version.json` report the same commit.
- The shell's updater must be able to explain itself. It
  names each condition that makes updates
  impossible — unpackaged build, no `app-update.yml` (a `--dir` build), a `0.0.0`
  version that always compares as newer, an adhoc signature macOS won't let
  Squirrel apply — and the panel shows it. Every check outcome, failures included,
  is recorded with a timestamp and persisted, so "nothing new" and "couldn't
  check" read as distinct states.
- A downloaded build is applied through the window's one prompt (§ One update
  switch). The close gesture that merely hides the main window
  (`05-surfaces.md` § Window chrome) must not absorb the relaunch, or the
  install reads as the window closing while the old build keeps running.
- A refused install is reported, never swallowed: an install that throws (a
  signature Squirrel won't apply) is recorded as a check failure verbatim on
  Settings → Updates and leaves the app running rather than half-quit.

Surface. Settings → Updates,
also reachable from the tray's right-click menu. Shows the up-to-date status,
last-checked, a Check now button and one Update control.

Desktop update feed. `electron-builder.yml` publishes with the `generic`
provider to `<public-url>/api/desktop/`; the release puts
`latest-mac.yml` + the `.zip` (+ `.blockmap`) and a `desktop-latest.json`
provenance sidecar into the box's downloads dir, served by the server's public
`/api/desktop/:name` route.

## Desktop code signing

The shell is signed with the project's signing identity rather than an Apple
Developer ID. Signing is what makes the update path work: the updater refuses to
apply an update to an adhoc-signed app, and it requires only that an update carry
the same certificate. Notarisation stays off, and builds are installed by direct
copy so nothing is quarantined. A publish refuses to proceed when the identity is
missing or the built bundle is adhoc.

Certificate setup and the failure modes around it are in `docs/desktop-packaging.md`.

## Backup

- `secrets.key` in the data directory is the key to `secrets.json`. The server makes it on first start and nothing needs setting; the two must travel together, so restore them as a pair (01-server.md § Settings).
- `~/.patch-server/data` is the server's only stateful directory (`01-server.md` § Data folder), Patch's record of every chat included. Snapshot it off-host nightly (the reference deployment uses restic).
- Provider session files and project folders live on each host. Each host is backed up on its own; a server snapshot does not carry them, and a chat whose provider session is lost stays readable from the server's record.

## Website

The public website, https://patchhq.dev, is a static site in the repository,
published to GitHub Pages whenever it changes on main. Its download links point at the fixed asset names on the latest stable
release (`releases/latest/download/<name>`), so it never needs editing for a
release. The apex and `www` are DNS-only records on Cloudflare pointing at
GitHub Pages, which issues the certificate. Screenshots are the real web app,
captured from the dev harness.

## Cross-refs

- Server config knobs: `01-server.md`
- Host commands: `02-host.md`
