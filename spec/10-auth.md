# Auth and Trust

## Identity layers

Patch has three overlapping identity concerns:

1. User identity — who owns this account.
2. Agent-backend auth — the credential each provisioned backend does LLM work with, against your own plan or account.
3. Surface / host trust — which clients can connect to the server and what they're allowed to do.

## User identity

The account is identified by an Ed25519 public key. The first surface to enrol generates the account keypair and registers its public key with the server, creating the account.

The server is the credential authority. It holds a signing key and issues every surface a per-surface bearer credential — an EdDSA-JWT (RFC 8037) bound to the account, the surface id, and the surface kind. A surface presents its credential to connect; the server verifies it with its signing key. The `jose` library handles JWTs across Node and browser (WebCrypto).

Every surface is equal: each holds its own revocable credential, and any linked surface can link another.

## Backend credentials

A provider is signed in once in Patch and is then available on every host, including hosts added or reconnected later. A backend authenticates against the user's own subscription or account rather than a Patch-held key. Each provider holds an ordered list of named accounts. Accounts, their order and each provider's account strategy are shared settings, held on the server (`01-server.md` § Settings); credentials are stored there encrypted at rest and handed to hosts over their host link. No account names a host and no host has accounts of its own.

- The server alone renews credentials. It serialises renewal and persists each rotated refresh token before handing out the new access credential. Hosts receive access credentials only, never a refresh token: a rotating refresh token held on two machines is spent by whichever renews first and breaks the other. A renewal that fails puts the account in broken with the provider's message.
- Claude Code runs on a sign-in account's OAuth token, passed to the Agent SDK as `CLAUDE_CODE_OAUTH_TOKEN`, or on an Anthropic API key account (`sk-ant-api…`; a sign-in token is `sk-ant-oat…`), passed as `ANTHROPIC_API_KEY`, never both. Whatever `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` the host's own environment holds is stripped first, so the account chosen is always the one that runs.
- An Anthropic API key is validated against `/v1/models` with `x-api-key`, is labelled "Claude API (paid)", takes part in the account order like any other account, and is never probed for usage (it has no subscription windows and a probe would be a paid call). Its row shows "API key" and offers Replace key in place of Sign in again.
- Codex runs with authentication managed by Patch: the host gives each account's isolated Codex runtime profile the access token from the server, and when Codex asks for a fresh one the host gets it from the server. Codex never renews on its own.
- An ACP agent (`02-host.md` § ACP agents) signs in with an API key: an ACP account is the agent it is for, a label and the key, held in the shared secrets like every other credential, ordered per agent, and handed to every host. Each turn picks among the agent's accounts like any other provider's (§ Choosing an account), with one strategy for all ACP agents (`accountStrategy.acp`, priority when unset); with no usage readings, soonest-reset and least-used keep the stored order. An account the agent refuses with a limit or as signed out is skipped: a limit refused before any of the agent's tools ran runs the turn again on the next account at once (§ Limits), and one refused after a tool ran fails visibly rather than repeat the tool. ACP limits state no reset, so a skipped account stays skipped until it is given a new key, or until no other is left, when the first is tried again so the turn fails with its own refusal. An ACP chat can be locked to one of its agent's accounts like any other chat (§ Choosing an account; the chat's account menu on every surface lists that agent's accounts only). An ACP account is never probed for usage (ACP carries none). Its state comes from what its agent says on each host, reported as that host's `host.account` for the `acp` backend: a limit is a refusal (limited, with no reset), a missing sign-in or a key the provider rejects is signed out, and a turn the agent completed on the account is a reading taken then, which lifts a limit that stated no reset. A new key clears what was said about the old one. The chat status reads this state like any other account's (`12-error-and-offline.md` § Limits and sign-in): a turn that failed on a limited account is Failed with `limit_no_reset` (or `limited` with a reset), never out of credit. An agent that takes no key (no `apiKeyEnv`) has no accounts and runs on its own sign-in on each host.
- OpenAI API keys are separately billed sources. API models have ids `openai/api/<model>`, are labelled "OpenAI API (paid)" and are selected explicitly; ChatGPT subscription limits never move a chat onto an API account. No billed generation runs during credential validation.
- A login already on a host (Claude Code's own `claudeAiOauth` login in env `CLAUDE_CODE_OAUTH_TOKEN`, `~/.claude/.credentials.json` or the macOS Keychain; an existing Codex login) is never used silently. It can be adopted: the host sends it to the server, which stores it as a shared account. Adopting a Codex login and later removing it takes away Patch's access without signing the owner out of Codex. A host that held accounts of its own before it first connected sends them once on that connect (`01-server.md` § Settings).

Each host reports, per provider, whether it can run it (the backend is provisioned and its credential check passes) and which models it offers (`02-host.md` § Provider adapters). Whether a chat can run is answered from the account's state on the server and its host's report, never from a host's view of the account: an offline host, or one that has not applied the latest settings, does not make an account look signed out; it receives the account on reconnect and a message sent meanwhile is held for it (`01-server.md`). Until the shared state has loaded nothing is blocked.

### Account states

Each account has exactly one state, derived from the provider's own signals as the adapter reports them (refusals, structured limit fields, usage readings):

- Ready.
- Near limit — usable, with a pool past its provider's warning level or estimated to run out soon.
- Limited until a reset time — a temporary limit with the reset the provider stated. A pool at 98% or more of a still-future reset counts as limited (readings round; Claude has refused at 99%). A limit that states no reset is limited until a usage reading shows credit.
- Out — billing or credit that needs the user (no plan, a balance at zero, a spend cap the user must raise).
- Signed out — the credential is absent, expired or refused, including a token revoked while its stored expiry says otherwise.
- Broken — anything else the provider reports wrong with the account, shown in the provider's words.

The server holds each account's state, so a restart of the server or a host never makes a known-limited account eligible. Unknown usage is not ready credit and not a limit: an account with no reading yet is used. Out and signed out stop every turn that would run on that account and ask the user; they are never retried. A chat waiting on either shows waiting for sign-in or failed with the reason (`12-error-and-offline.md` § Limits and sign-in), with Sign in, Add account or the provider's billing page as its action. Signing in again, adding an account or a reading showing credit makes the waiting work runnable at once.

A chat's model selects its provider; changing an account never changes a chat's provider or model.

### Choosing an account

Every turn orders the provider's accounts by the provider's account strategy and runs on the first that is ready or near limit. A limited account is skipped, not retried; it is first in the order again when it returns.

- `priority` — the stored order, first to last.
- `round-robin` — each turn starts on the account after the one the last turn started on. Asking where a turn would start does not move it on; only a turn starting does.
- `soonest-reset` — the account whose weekly window resets first, so allowance about to expire is used. An account with no reading goes after every account that has one.
- `least-used` — the account using the least of its limits, read as the higher of its session and weekly use. An account with no reading goes last.

A chat, and the chat a job creates, can name an account, which locks it there: its turns run only on that account. A lock is changed or removed from the chat's account menu; Automatic (no account named) follows the strategy. A locked chat does not move a round-robin on. An account the provider does not have is refused when named; one later removed is ignored and the chat follows the strategy.

Each turn records the account it ran on; a failure and a usage reading are attributed to that account, never to the chat. The chat's state names the account of its latest turn and surfaces show it beside the model. When a turn runs on a different account from the previous turn because that one became limited, the chat gets a visible line naming both accounts and when the limited one returns, in the reader's own time. A move that is the strategy working is not news and writes no line.

Two accounts in the same Claude organisation are one pool of credit: they become limited together, and the chat says so.

One-shot calls that are not turns (a title, a status summary, the model catalogue) choose accounts the same way and, having no next turn, walk the remaining accounts within the call. A one-shot no account can answer resolves to nothing and its caller leaves what it would have set unchanged; one that fails for any other reason fails with the provider's words, so "the model had nothing to say" and "this call did not happen" stay distinct.

### Limits

A turn pauses only when no account it may use has credit: every account of the provider for an Automatic chat, its own account for a locked one. The pause is visible, with the reset time, as the chat status paused until a reset (`12-error-and-offline.md`). The user's chosen behaviour then applies, a shared setting (Settings → Agent behaviour) that each pause also offers as actions for that chat:

- Resume at reset — the owed turn runs when an account it may use has credit again, whichever account and however it returned: a stated reset passing, an account added or signed in again, or a reading finding credit.
- Another account of the same provider — a locked chat runs this turn on another ready account and returns to its own when that resets; the lock is not rewritten. Offered only where another account is ready, and only for providers whose adapter can resume the session on another account.
- Switch provider — a new chat on another provider, linked to this one (`04-chats-and-folders.md` § Provider switches). Offered only where that provider has a ready account and the chat's host can run it.

The setting is `limitBehaviour` (`resume_at_reset`, `other_account`, `switch_provider`), one shared value on every surface. It replaced account failover that was always on and a separate on/off for resuming at the reset (`autoResumeRateLimit`); a settings file from before it reads on as `other_account` (exactly what on did) and off as `switch_provider` (nothing runs until the user chooses). The server keeps the old key in step for hosts and surfaces older than the setting. What a paused chat will do next is sent with its state (`limitNext`), so every surface says it in the card or bar.

Out of credit and signed out are not limits and are never retried, whatever the setting. A refusal that states no reset is treated as out: the turn stays owed with no timer and the chat says nothing runs until the user continues. When credit is later seen on an account it may use (a key added or signed in again, a reading finding credit, a reset passing), the chat is told so (`creditReturned`) and its card or bar offers Continue; the host does not send the turn itself.

A pause is never retried on a timer before its reset. Only transient errors retry automatically, each attempt shown (`12-error-and-offline.md`). A turn owed for longer than the resume cutoff stays shown as owed for the user to send again rather than running into a changed world.

When every account of a provider is limited, every chat on that provider shows a warning banner naming the accounts and the first to return, counting down. It is a warning, not an error, and clears on its own. It shows only when certain: not while any account has no reading, not while any account is usable, and not when there is no account (the sign-in banner covers that).

### Signing in

Every surface signs in to every provider, with no terminal and nothing installed; the CLI does the same through `patch accounts` (`17-cli.md` § Commands). The sign-in runs on the server, which keeps every secret it involves (PKCE verifiers, device codes, tokens); no secret reaches a surface. Each sign-in reports progress, cancellation and failure, and is complete only when the server has verified the account. A sign-in always creates a new account, except Sign in again on an existing row, which replaces its credential and keeps its id, label and position. An account already connected cannot be added twice.

- Claude. The server answers with a claude.ai address; the person opens it in any browser, signs in, and pastes back the code the page shows. When the browser is on the server's own machine (the request came over loopback, not relayed by a proxy or tunnel) the sign-in is a loopback redirect instead, the way Claude Code's own login works: the server listens on `http://localhost:<free port>/callback`, claude.ai sends the code straight there, and the surface waits and is told when the account is added, with nothing pasted. The server exchanges it for the year-long, inference-only token `claude setup-token` produces (same client, scope, redirect and lifetime). A started sign-in waits 15 minutes and finishes once; an expired or finished one is refused and started again. A code carrying another sign-in's state is refused without calling Claude; a code Claude refuses is reported in Claude's words; Claude unreachable is reported as that and the code can be tried again. Pasting a `claude setup-token` token is offered beside it.
- ChatGPT. A browser sign-in, or a device code: the server shows a code and an address that any other device opens to approve, which is how a headless host's owner signs in. An OpenAI API key is pasted.
- An ACP agent. An API key is pasted (Settings → AI accounts on web and mobile, `patch accounts acp sign-in` in the CLI, `POST /api/accounts/acp/<agent>`; Replace key on a row gives that account a new key and keeps its id, label and position). Where the agent names a key check (`apiKeyCheck`; Gemini CLI uses the Gemini key check, one free read-only request) the server runs it first: a refused key is `credential_rejected` and an unreachable provider `credential_unreachable`, and neither stores anything. A key for an agent with no check is stored and the agent's own answer on its next probe or turn says whether it works. The same key twice for one agent is refused, naming the row. ACP's own sign-in methods (`authenticate`) run inside the agent on the host it was started on and leave the login in the agent's own files there, so they cannot be stored on the server or carried to other hosts, and ACP has no device-code flow; Patch does not offer them, and an agent signed in that way on a host simply reports ready there.
- Adopting a host's existing login (§ Backend credentials) is a REST and CLI operation, not a Settings control.

Every credential is validated by the server before anything is stored. One Claude account is one row: each Claude credential records the Anthropic organisation it authenticates as, read from the `anthropic-organization-id` header on the validating call. A credential whose organisation matches a stored account is refused, naming that row; Sign in again on the same row with the same organisation is a rotation. An organisation that could not be established is "not known", never "different", so the credential is still stored.

#### Validating a pasted token

A pasted Claude token is checked against Anthropic's API (GET /v1/models) with the OAuth bearer and `anthropic-beta: oauth-2025-04-20` headers the host uses for model-catalogue reads.

- `200 OK` → the token is valid; the store write proceeds.
- `401`/`403` → Anthropic refused the token; nothing is written. The reply is `credential_rejected` naming why, shown inline on the row.
- Any other outcome (network error, unexpected status) → inconclusive; nothing is written, and the reply is `credential_unreachable`. "We could not check" and "the token is bad" are distinguishable, but neither stores a token nobody has confirmed.

Anthropic's profile endpoint refuses `claude setup-token` tokens, so an account added by paste shows no email until a host's next credential check resolves one from the OAuth claims and sends it to the server.

### Settings

Settings lists every provider the same way, from one list of providers in which each declares its name, its strategy setting, which limit windows it reports and in what order, where its extra-usage add-on is managed, whether a token can be pasted, and how an account is added. A new provider is a new entry, never a change to the page. Under each provider: its strategy control, its accounts in order, and its sign-in actions. Every surface with a Settings screen — web, desktop and mobile (`15-design-mobile.md` § Settings tab) — shows the same state and offers the same controls, read from `GET /api/accounts/:backendId` and kept live by `settings.changed` (`03-wire-protocol.md` § Settings).

- Each account row shows its label, its email, its state and, behind a ⋯ that opens a small panel floating beside the row, its actions, each with one line saying what it does: `Sign in again` replaces the stored login with a fresh one; `Sign out` keeps the row and forgets the login; `Remove` forgets the account everywhere. Sign out and Remove are confirmed, since each takes the account away from every chat on every host. No row names a host.
- Under the rows, the provider's sign-in actions (§ Signing in), each creating a new row. There is no "active" or "default" account; the order is the only ranking.
- Connect, add, sign out, remove, relabel and reorder are REST calls to the server (`01-server.md` § Endpoints). A change is settled when the server has committed it; the reply carries the new list. Whether each host has applied it shows on its Settings → Hosts row; an offline host does not block a change.

Each provider's own settings are exposed under that provider for the user to choose — session retention and auto-delete among them (`04-chats-and-folders.md`) — a shared setting each host writes into the provider's own configuration. Each provider declares which of its settings are exposed, with their range and the default the provider applies when its configuration holds none; a provider that declares none shows no group unless it carries a note saying why, which Settings shows in the group in place of rows. Claude Code declares `cleanupPeriodDays`, how many idle days it keeps a session's files (a whole number from 1 to 3650, default 30). Codex declares none, having no session retention or auto-delete setting (it keeps every session until it is deleted with Codex itself; its `[history]` settings are about prompt recall, not sessions), and its group says so. This is the one place session retention is set: Settings → Chats has no cleanup setting of its own. Only a chosen value is stored on the server, which refuses an undeclared setting or a value out of range. A host writes a chosen value into the provider's configuration (for Claude Code, `settings.json`, every other key kept) only when the file does not already hold it, and writes nothing for a setting nobody chose. A configuration that cannot be edited is left as it is and the host reports why. Settings shows the chosen value, else the value a host's own configuration holds, named by host, else the provider's default, and says which of the three it is; a configuration that cannot be read is said so rather than shown as the default. Patch shows what the provider has set and does not override it.

### Usage

Usage shows how close each account is to its provider's limits and when they reset. The reading is taken, not overheard: an in-turn reading rides on a query, so an account with no credit could never produce one. For Claude the host asks Anthropic directly, per account, from the `anthropic-ratelimit-unified-*` response headers, which arrive on a 429 as well as a 200 (the probe is one `max_tokens: 1` Haiku call; a 429 costs nothing). In-turn `rate_limit_event`s are folded in when they arrive. Probing is every 10 minutes far from a limit, every 3 minutes at 75% of the session or a run-out within 90 minutes, every minute at 90% or a run-out within 30 minutes, on demand (`host.backend_usage_refresh`), and immediately after a turn meets a limit. Readings go to the server, which holds the latest per account and derives the account's state from it; a host is only a reader of an account's usage.

Claude reports three windows: `five_hour` (the session), `seven_day` (the week) and `overage`, the extra-usage pool the other two spill into. Its refusal is what Claude Code shows as `You've hit your monthly spend limit`. A `disabled-reason` of `org_level_disabled_until` means extra usage is off on that account; `org_level_disabled` means organisation policy prevents it. Extra usage is a paid add-on, so an account that never turned it on reports a rejected overage permanently: that is a ready account, not a limit. The per-model weekly variants are not shown.

Each window carries `status` (`allowed`/`allowed_warning`/`rejected`), `utilization` (0–1), `resetsAt` (epoch ms), an optional `disabledReason`, an optional `runsOutAt`, and the account carries `at`, when the reading was taken, which a surface always shows so a stale figure is never mistaken for a live one. From successive readings the host estimates when each pool reaches 98% — the session over the last 45 minutes of the current window, the week over the last 6 hours — making no estimate from one reading, a flat one, or when the reset comes first. The estimate feeds probing, near limit and the display, never account choice.

Each account row shows a line per window it has data for, omitted for a window not yet read, never a zero placeholder. Each line is the percentage, a bar and, with `resetsAt`, a local time (same-day `14:32`, otherwise `Wed 14:32`) with UTC on hover, and `runs out ~HH:MM` beside it when estimated. Every instant is formatted from an epoch in the reader's own zone, never the raw epoch, enum or the provider's prose. A rejected session or week reads as limited. A rejected overage reads as off, in neutral styling, saying nothing has been overspent, with the reason where a reset time would go: `Turn on`, linked to that account's Claude usage settings, or `disabled by organisation`. A row has no Refresh action.

Usage also appears where the work happens: the composer's context ring opens a popover naming the pool closest to its limit, or the refusal, with every window beside it (`14-design-web.md` § Chat panel header), and the New chat screen carries the same one-line summary beside the model (`14-design-web.md` § Model selector).

Settings → Usage opens with two groups above the accounts. "Allowance left" is a burndown: for a period (Day = 24 h, Week = 7 d, Month = 30 d, or Custom from/to) one line per Claude account of the weekly window still unspent at each reading, drawn as a smooth curve within each weekly cycle and a vertical step at each reset. "Chats by tokens" ranks chats with a completed turn in the period by tokens (fresh and cached input plus output, from each turn's usage in the server's chat record). Both come from `GET /api/usage-report`, answered by the server from its own records: a named period from a cache it keeps current every ten minutes, a custom range read on request. The page says when the figures were read. Reading history starts when the server first records it, bounded in size.

## Surface linking (QR flow)

Any already-linked surface can link a new one.

1. On a linked surface, the user opens Link a device. That surface requests a single-use pairing nonce from the server — authenticated with its own credential — and renders it as a QR and as a short code, for a new surface that types rather than scans.
2. The new surface generates its device keypair, takes the nonce from the QR or the short code, and submits the nonce and its device public key to the server.
3. The server validates the nonce, mints a credential for the new surface bound to the nonce and the device public key, and returns it.
4. The new surface stores its credential and connects.

A pairing nonce is single-use and expires after five minutes. The credential is bound to the nonce and the device public key, so it cannot be replayed or retargeted to another device.

## Sign-in by approval

A new browser signs in by asking a device that is already signed in, as on an Apple device.

1. The new surface asks the server to sign in (unauthenticated, rate-limited), naming itself ("Chrome on Mac"). It keeps the private `secret` the server returns with the request id.
2. The server tells every signed-in surface (`signin.requested`) and wakes the phone with a push. Each shows Allow / Deny. A surface that connects later reads what is waiting from `GET /api/auth/signin/pending`.
3. Allow (`POST /api/auth/signin/:id/approve`, authenticated) returns a six-digit code, shown only on the approving surface. Deny turns the request away. Either answer sends `signin.resolved`, which clears the prompt everywhere.
4. The person types the code on the new surface, which redeems it with its `secret` for a credential. The server mints a web credential and records the surface.

A request lasts five minutes and at most five wait at once. The code works once; three wrong codes burn the request. The code is revealed only to an authenticated approve, so naming a request is not enough to sign in. The first sign-in of an account has no device to ask and still uses a credential token (`patch auth bootstrap`).

## Relay

A server with no address of its own — one running on a laptop, or behind a home router — is reached through a relay: a rendezvous both sides dial out to. The relay forwards bytes it cannot read.

- The server holds an Ed25519 relay identity (`relay.key` in its data directory, made on first use). Its channel is the first 22 characters of the base64url SHA-256 of the public key, so only the holder of the key can hold the channel: the relay makes a joining server sign a one-time challenge with it. A newer connection from the same server replaces the older.
- A device learns the relay's address, the channel and the server's public key from a pairing code (`05-surfaces.md` § Canonical QR payload). It connects to the channel; the relay tells the server a device has arrived and forwards binary frames each way, labelled so devices cannot see one another's.
- Everything between a device and the server is end-to-end encrypted. The device sends an ephemeral X25519 key sealed to the server's static key; the server answers with its own ephemeral key; each side derives one key per direction from both Diffie-Hellman results, and every message is a XChaCha20-Poly1305 frame whose nonce is an implicit counter. Only the holder of the server's key can read the first frame or answer it, so the device knows it is talking to its server and not to the relay; a frame the relay drops, repeats, reorders or alters fails to open and ends the session. The relay sees which channel, how many devices and how many bytes — never a path, header, body or message.
- Inside the session the device makes HTTP requests and opens WebSockets as though the server were next door, multiplexed as numbered streams. The server ends each one on its own loopback address: a request is made again, as an ordinary request, against the listening server, and a socket opened the same way. The tunnel therefore adds no access: every route needs the same credential it needs anywhere, and a device with only a pairing code can do only what the code allows.
- Relayed access is for surfaces. A host dials the server's address directly (`02-host.md`).
- A relay keeps no state. It limits frame size and devices per channel. Both ends ping to keep a quiet connection from being dropped as idle and to find a dead one: the server pings the relay, and a device pings its server inside the session; two unanswered pings end the connection and it is dialled again. Running one is `11-deployment.md` § Relay.

A server is relayed when `PATCH_RELAY_URL` names a relay; Settings → Account shows whether it is reachable that way and by how many devices.

## Host registration (adding a host)

Every host registers its own host, opened from a linked surface. Hosts
are peers and any number may be registered; a second host follows the same
flow as the first.

1. On a linked surface, the user opens Add host; the surface requests a single-use daemon-registration nonce from the server and renders it as a QR and as a short code, for a host where the code is typed rather than scanned. The QR and the short code carry the same nonce, so a host that scans and a host where it is typed submit the same value.
2. The new host submits the nonce and its public key, as the installer's final step: run the install command, enter the pairing code, and the host appears in Settings → Hosts.
3. The server registers the host, issues its `daemonKey`, and records the host's self-description (`hostId`, host name, platform, versions). With the `daemonKey` it hands over the voice-session secret every host verifies voice session tokens with (`PATCH_INTERNAL_TOKEN`), so the pairing code is the only thing a person gives the installer. An installer that is not already holding the secret pairs before it registers the service, since the service cannot start without it.
4. The host stores `~/.patch/daemon.key` and authenticates to the server with it thereafter.

The code travels in one direction: the server mints it at a linked surface's
request and the installer redeems it. Adding a host therefore starts on a
surface that is already linked, and the very first surface of an account gets
its credential from the server's administrator: `patch-server pair` on the
server prints a pairing code that makes the account the first time it is run
(`11-deployment.md` § Server installation), and `patch auth bootstrap`
(`17-cli.md` § Commands) does the same from a terminal, before any host can be
added.

Registration is per host and idempotent: re-running the installer on a host
that is already registered re-uses its stored `daemonKey` rather than creating a
duplicate host. A host that has been revoked pairs again from scratch.

Adding a host includes provisioning its agent backends (`02-host.md` § Provider
adapters). It signs in to nothing: the shared accounts reach it with its first
settings snapshot (§ Backend credentials).

## Revocation

Any linked surface can be revoked from the app (Settings → Devices). Server invalidates the JWT and terminates the WebSocket.

Revoking a host decommissions that host's install: its `daemonKey` is invalidated, its WebSocket dropped, and its chats stay readable from the server's record but can no longer run (`04-chats-and-folders.md` § History). Removing a host is confirmed, and the confirmation names how many chats live on it. Other hosts continue as they were. The Manager's home host is refused (409 `manager_home`) while another host is registered: the user moves the home first (`06-threads-manager-speakers.md` § Changing home).

## What's trusted vs untrusted

| Component                 | Trust                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A host                    | Trusted. Holds the shared accounts' access credentials (never refresh tokens) and provider keys, the provider sessions of its chats, and runs with the host user's full authority — see below. |
| Patch server              | Trusted — you run it. Plaintext content; no end-to-end encryption. Stores every shared credential, encrypted at rest (`01-server.md` § Settings).                                              |
| Webhook callers (Todoist) | Untrusted. Rate-limit, JSONata-filter, no code exec.                                                                                                                                           |
| Phone/web clients         | Trusted via server-issued credential.                                                                                                                                                          |

### The authority of a turn

A turn carries the host user's authority, including `sudo` and `docker` where
that user has them (`02-host.md` § Runtime and installation). Two requirements
follow:

- Every trigger ingress — Todoist, inbound webhooks, cron
  (`08-triggers-and-jobs.md`) — is an entry point to that authority, and each is
  authenticated or secret-gated.
- The installer states what the host will be able to do on the host, once,
  before it registers.

## Provider keys

Provider keys — the API keys the host itself uses for hosted voice and Groq
Whisper — are shared by every host and set and revoked from one Settings →
Providers page (`02-host.md` § Provider keys). The gate is every other shared
setting's: a live surface credential. They are stored like every other secret
(`01-server.md` § Settings): on the server, encrypted, sent to every host, and
never sent back to a surface, which sees where each key comes from and its
last four characters.

## Tokens on the wire

- EdDSA-JWT for surface/daemon-to-server WebSocket auth.
- A secret's value — a backend credential or a provider key — inbound on the
  REST call that sets it, outbound only to a host (in a `settings.snapshot`, or
  a fresh access credential), and from a host to the server when a host adopts
  one. A refresh token never leaves the server. Never in a response to a
  surface, a report or a log.
- Webhook ingress is gated by the unguessable server-issued jobId in the URL, plus the trigger's own signature scheme where the source supports one (see `08-triggers-and-jobs.md`).

## Cross-refs

- QR flow mechanics: `05-surfaces.md`
- Host init sequence: `02-host.md`
- Server endpoints involved: `01-server.md`
