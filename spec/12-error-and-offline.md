# Error and Offline Behaviour

Patch has several parties holding connections: surfaces ↔ server ↔ hosts. Any of them can disappear. This doc defines what happens.

## Principles

- Disconnects don't lose anything. The chat's record is on the server and the provider's session stays on its host; neither depends on a connection, and a dropped connection is never a chat outcome.
- No fallbacks. When something breaks, it's visible, not silently absorbed (`principles.md`).
- One surface per failure. A failure is reported once, in one place. A surface never repeats the same message in a second element beside the first — two copies of one message read as two separate faults, and the spare copy is the one that ends up unstyled. On web that one place is the error toast; a failure that needs to persist past the toast belongs in the affected control's own state, saying something the toast doesn't. A new chat that failed to start is such a case: it stays as a failed draft with its message, the reason and a Resend (`04-chats-and-folders.md` § Spawn).
- Said in plain English, code kept. What the user reads is one sentence saying what to do next. The machine-readable code, and any wording a host wrote for whoever wrote the host, are never the message and are never appended to it — an unrecognised code least of all, which takes a generic sentence rather than being interpolated into one. Neither is discarded: both are kept verbatim in a Details disclosure under the sentence, collapsed by default, and a toast holding one does not auto-dismiss while that disclosure is open.
- Full-page failures use one page. A path no pane claims, and a crash while rendering a pane, each take the panel with a title, one sentence, the path or stack under Details, and the way out (Back to Manager / Reload). A render crash never leaves a blank window, and navigating away clears it. A failed action's toast is `<Action> failed. Try again.` with the thrown message under Details.
- Positions. A surface holds a position in each chat and asks the server for what is newer, or for older pages before its earliest entry. Only the server answers, and opening a chat never waits on its host (`03-wire-protocol.md` § Chat history, `05-surfaces.md` § Loading).
- Catch-up arrives as a burst, and is applied as one commit. A surface gathers inbound entries for up to one frame and applies the run to its store as a single commit, in arrival order — the result is identical to applying them one by one. Applying them one at a time costs a render of the whole transcript per message: the chat visibly fills in from its oldest message down while the scroll chases the growing content, and the work is quadratic in the transcript's length. Anything that reads or writes chat state outside that fold — working out the position to ask from, or resolving a question card — commits the gathered entries first, so it never acts on a transcript missing entries that have already arrived.
- Questions survive any reconnect. A history answer carries every question still unresolved on the chat, whatever range was asked, and the record holds each answer, so a surface catching up never draws a settled question open or an open one without its controls. Surfaces identify a question by its request id and ignore one they already hold (`14-design-web.md` § Main chat panel, `15-design-mobile.md` ## Chat detail). Questions past their deadline come back expired.

### Offline reading

Chats in the device copy (`05-surfaces.md` § Loading) open from what the device holds while it has no connection, marked as not current. A chat the device does not hold says it needs a connection to load; it is never shown empty.

### No polling

A surface never re-asks for history on a timer. New entries are pushed to the surfaces following or focusing a chat (`03-wire-protocol.md` § Account feed). `chat.focus_change` replaces that surface's previous focus, and a history request never subscribes as a side effect. After its socket reconnects the surface announces its focus and resumes the feed from its positions. A healthy connection that misses an event is a bug to be found and fixed, not something a poll papers over.

## Chat status

The server alone decides a chat's status (`01-server.md` § Responsibilities). Hosts report facts — a turn started, a turn ended with its outcome, a question raised or resolved (`03-wire-protocol.md` § Session events) — the server sees each host connect, announce a restart or go, and accounts report their state (`10-auth.md` § Account states). Surfaces display the status the server sends and never derive it (`05-surfaces.md` § Chat status). Snoozed, archived and pinned are user flags, kept apart from status.

| Status                     | Wire                  | Means                                                                                                                                   |
| -------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Idle                       | `idle`                | No turn running and nothing owed                                                                                                        |
| Running                    | `running`             | A turn is in flight, including one retrying a transient error                                                                           |
| Waiting for the user       | `waiting_for_user`    | A question is unresolved                                                                                                                |
| Queued for an offline host | `queued_offline`      | The server holds a message for the chat's host, which is offline                                                                        |
| Host restarting            | `host_restarting`     | The chat was running or waiting when its host announced a restart, and the host has not yet reattached                                  |
| Host offline               | `host_offline`        | The chat was running or waiting when its host went without announcing a restart, or did not return within two minutes of announcing one |
| Interrupted                | `interrupted`         | The turn's process died with its machine (§ Continue)                                                                                   |
| Paused until a reset       | `paused`              | The turn met a temporary limit; carries the reset time and the account (§ Limits and sign-in)                                           |
| Waiting for sign-in        | `waiting_for_sign_in` | The account the turn needs is signed out; carries the account                                                                           |
| Failed                     | `failed`              | The turn ended in a failure that will not clear by itself; carries a reason                                                             |

A chat with nothing running keeps its status when its host goes; the host's own presence says the host is offline (§ Host-offline UX).

### Allowed transitions

The server keeps to these. A host's report of its own state is a fact and always wins, so a report that implies any other change is applied and logged as a fault — a wrong status left on screen would be worse than a broken rule — while a change the server would make on its own outside the table is never made.

| From                                                   | To                            | On                                                                                         |
| ------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------ |
| Idle, Interrupted, Paused, Waiting for sign-in, Failed | Running                       | a turn started                                                                             |
| Running                                                | Waiting for the user          | a question raised                                                                          |
| Waiting for the user                                   | Running                       | the question resolved                                                                      |
| Running, Waiting for the user                          | Idle                          | the turn ended done or stopped                                                             |
| Running                                                | Paused                        | the turn ended limited                                                                     |
| Running                                                | Waiting for sign-in           | the turn ended signed out                                                                  |
| Running                                                | Failed                        | the turn ended failed                                                                      |
| Running, Waiting for the user                          | Host restarting               | the host announced a restart                                                               |
| Running, Waiting for the user, Host restarting         | Host offline                  | the host's link went unannounced, or two minutes passed since it announced a restart       |
| Host restarting, Host offline                          | Running, Waiting for the user | the host reattached and the turn is live                                                   |
| Host restarting, Host offline                          | Interrupted                   | the host returned and the turn's process is gone                                           |
| Host restarting, Host offline                          | as the turn's outcome gives   | the host returned and its outbox reports the turn ended while it was away                  |
| Idle, Interrupted, Failed                              | Queued for an offline host    | a message was held for the chat's offline host                                             |
| Queued for an offline host                             | Running                       | the host returned and took the message                                                     |
| Paused, Waiting for sign-in                            | Idle                          | nothing is owed any more, or the user switched provider and the new linked chat carries on |

Nothing becomes Failed because a connection dropped, and nothing stays Running once its host has gone silent: the server's heartbeat check (§ Host → server disconnect) makes it Host offline within 15 seconds.

### Restarting, offline, interrupted and failed

Host restarting is a planned gap: the host said it was restarting (`host.restarting`, `03-wire-protocol.md` § Session events), its turns keep running as their own processes, and it reattaches to them (`02-host.md` § Host restarts). Host offline is an unplanned one — a laptop asleep, a lost network, a crash, a restart that has not come back — and says nothing about the turn itself: it may still be running, and the record catches up from the host's outbox when the host returns. Interrupted is known loss: the host is back and the turn's process is not, because its machine went down. Failed is a turn that ended in a failure: the provider refused or broke, the account is out of credit, the provider's session is gone (`04-chats-and-folders.md` § Resume), or transient retries ran out.

### Continue

An interrupted chat shows an inline "Turn interrupted" line where the turn stopped and a Continue action on every surface (`chat.continue_request`). Continue resumes through the provider's own resume where its adapter declares one; otherwise it sends a visible message asking the agent to carry on, which reads in the chat like any other message. Nothing is added to the turn unseen. Automatic continue is a user setting (Settings → Agent behaviour): with it on, the host continues each interrupted turn the same way as soon as it is back. A turn that was only queued never began, and is sent as it was. The host reports a cut-off turn as a fact, `interrupted` on its `chat.state`, writes the inline line into the chat's record once, and keeps reporting it across further restarts until the chat is continued or another turn starts. A Continue for a chat that is no longer interrupted does nothing. An until-complete snooze (`04-chats-and-folders.md` § Snooze) keeps waiting while a chat is interrupted, as the turn it waits on may still come back. Unattended work, such as an agent's background child, waits for Continue like any other chat unless automatic continue is on.

### Limits and sign-in

A turn that meets a temporary limit ends `limited` and the chat is Paused until a reset, carrying the reset time and the account; the user's chosen behaviour then applies (`10-auth.md` § Limits). A signed-out account makes the chat Waiting for sign-in, with a Sign in action on every surface (`10-auth.md` § Signing in). Out of credit makes it Failed with that reason, and a broken account Failed with the provider's message under Details. None of these is retried on a timer. The pause is held as the chat's status on the server and as the host's owed turn, so it outlasts any restart.

The pause is a message in the transcript, not a banner: a full-width card under the turn it belongs to, because it is about the reply that is not coming yet.

- The heading names the limit and account — "Session limit · Work" — with "Resets in 16 min · 15:00" on the right, ticking. Where nothing stated a reset there is no countdown, rather than an invented one. Once the reset passes with the card still there, the heading reads "Session limit reset · Work", the corner "4 min ago", and "Message not sent" sits under it. All text is at least 14px.
- The headline names a pool a person spends — the session (5-hour) or the week (7-day), never the overflow. Overage is what covers for those two when they empty, and naming it as the limit reached suggests no action. A rejected overage on its own blocks nothing and never reads as blocked.
- The card names the limit behaviour the user chose (`10-auth.md` § Limits) and always draws the same controls. One that cannot help is greyed out with a tooltip saying why, never hidden:
  - `Send` (`chat.resume_now_request`) — disabled until the reset ("Available at 15:00"); re-sends the paused turn.
  - `Change account` (menu) — the connected accounts of the chat's provider with usage left, other than the one that ran out. Choosing one runs the turn on it (`10-auth.md` § Limits). Disabled when there is none ("No other account has usage left").
  - `Change provider` (menu) — every connected provider with usage left, other than the chat's own. Choosing one starts a new chat on it, linked to this one (`04-chats-and-folders.md` § Provider switches). Disabled when none ("No other provider has usage left").
  - `Extra usage ↗` — a link to the provider's usage settings, because Patch cannot flip an account setting. Disabled when extra usage did not fail to cover the limit ("Extra usage is already on").
    The filled button is the first enabled of `Change account`, `Change provider`, `Send`. There is no model picker: a session or weekly limit covers every model on the account. There is no "N other accounts available" line; the controls say it.
- A new message to a paused chat just queues behind the owed turn. For the person who knows better (credit topped up, a limit lifted early) the card header carries a small retry icon that is always enabled; it sends `chat.resume_now_request`, and the queued messages drain behind the owed turn.
- The card is withdrawn from every surface the moment the chat leaves Paused.

Where Patch states a failure itself, the provider's sentence is not copy anywhere. A failure the provider states structurally is reported in Patch's own words, built from those fields, and that one account is what every surface shows: the transcript, the chat's failed status, and the run log of a job whose chat failed. The provider's sentence is diagnostic detail — it stays in the host log and as the raw field of the structured block — and is never rendered as the failure. Otherwise the same failure is read twice and the two disagree about which limit was even reached. This is driven off the structured fields, never off a match on the wording: a failure Patch has no structured account of keeps its real message, in full.

### Transient errors

Only transient errors retry automatically: a dropped provider connection, a 5xx or a crash mid-stream on a 10s / 30s / 90s ladder, and a 529 overload backing off from 5s, doubling to a 60s cap. Each attempt is shown in the chat, so the retrying is never hidden. The chat stays Running throughout and becomes Failed only when the ladder is spent. A stated limit never goes on this ladder. No setting gates it: a turn dropped by a network blip is not a preference.

### What a recovery leaves behind

A turn that recovered is ONE turn, however many goes it took. Every re-send —
a rung of the ladder, a paused turn coming back — is the host re-running a turn
the user sent once, so it must not read as a message the user sent again.

- The re-sent user `chat.message` carries `retryOfSeq`: the seq of the ORIGINAL
  user message for that turn, on every attempt, never the attempt before it. A
  surface folds the copy into the bubble already on screen instead of drawing
  the same sentence a second time. A user retyping the same thing is a new turn.
  `retryOfSeq` is part of the entry in the chat's record, so the fold holds on
  every surface and after any reload.
- Retry on a settled turn forks. Retry in a message's long-press sheet sends
  `chat.fork_request` for the user turn (`04-chats-and-folders.md` § Branching)
  and drops every later turn from the view: the retry starts a new track from
  that point rather than appending to the conversation. It is offered only where
  the provider can branch natively.
- Retry in place. A person's Tap to retry on a turn that failed to deliver is
  the same thing from the other side: the surface sends `chat.input` with
  `retryOfSeq` set to the ORIGINAL user message's seq, draws no bubble of its
  own, and the host's resulting `chat.message` folds into the existing bubble
  as another attempt — the `< >` pager gains a page. The failure mark stays on
  the bubble until the retry is observed running. The page is added the moment
  Retry is pressed, not when the host answers: the earlier reply leaves the
  transcript at once (one `<` away), and only the new run's content appears. A
  retry that never reaches the host takes the page back off.
- Retry vs Continue. A turn that failed partway (out of usage, a dropped
  connection, a crash) offers BOTH on the failed message and on the phone's
  error row. Retry restarts from that message: the text runs again as a new
  attempt, and what the first attempt did is set aside. Continue keeps it and
  carries on as § Continue describes. A long turn may be an hour in when it
  dies, so Continue is always offered beside Retry and never replaced by it.
  Neither is offered for a failure that will recur unchanged (input too large):
  there only "Retry anyway" is drawn.
- Interruptions. Retry in place is only for a person choosing to re-run a
  turn. A turn cut off by its machine going down never stamps `retryOfSeq`: the
  history shows the "Turn interrupted" line, then Continue's resume or visible
  message, then the next output, all in time order.
- A failure that has been superseded is not an outcome. As the turn goes
  round again, the `turnFailed` mark on the bubble comes off. It is not thrown
  away — it is filed on the ATTEMPT it ended, where the surface's `< >` pager can
  still reach it. Only a genuinely settled failure — the ladder exhausted, or
  nothing ever resumed — leaves a mark at rest, and that one keeps its
  `Tap to retry`.
- A turn that went round again says so, on the message's own meta strip
  (`14-design-web.md` § Main chat panel): `Retried once` / `Retried twice` /
  `Retried N times`.

Why it matters. Unattended work has no one to notice. A job-spawned chat
that dies on its first turn has not yet claimed its task, so it leaves no trace
anywhere — the job records the _spawn_ as `ok`, and the task looks like one
nobody ever filed. A job's run log therefore records a `chat-error` entry
against the job when a chat it spawned fails, in addition to the earlier `ok`
for the fire itself.

## Scenarios

### Surface → server disconnect

- Surface notices WS close and its link state becomes `reconnecting` at once. The "reconnecting..." banner waits for the disconnect grace (see Surface connection state model).
- Surface tries to reconnect with exponential backoff (1s → 2s → 5s → 10s, max 30s).
- On reconnect the surface sends `hello`, then `feed.resume` with its feed position and the position of every chat it follows (`03-wire-protocol.md` § Account feed). The server sends what changed while it was away and each followed chat's entries after its position. Nothing restarts from the beginning and nothing waits on a host.
- A feed position the server no longer keeps is answered with `feed.reset`, and the surface reloads the chat index. A failed reload is shown as an error, not swallowed.
- Inbound from user while disconnected: surface queues in-memory. Emits on reconnect. If the surface is killed before reconnect, queued messages are lost — users get a "not sent" indicator.

### Host → server disconnect

A host dials out to the server, so this fires whenever that link breaks: the host or server restarting, or a laptop host sleeping, changing network, or moving out of range. Reconnection is a normal operating mode.

- The server does not wait for a close to notice. It pings every host socket every 5s, and a host that has sent neither a pong nor any frame for 15s is terminated and announced `host.offline` — a laptop whose lid is shut leaves a TCP link that looks open for minutes, and surfaces must show it offline within seconds.
- The host's work carries on: turns run, and everything they produce waits in the host's outbox on disk (`02-host.md` § Host outbox).
- Chats that were running or waiting become Host offline (§ Chat status). Nothing is marked failed.
- On reconnect the host resends everything after the server's last acknowledged outbox position, in order, then carries on live. Messages the server held for it are delivered (§ Guaranteed input delivery), and each chat's status follows the facts that arrive.
- The server announces `host.online` to surfaces.

### Surface connection state model

A surface tracks two independent things and shows them as two indicators: the WS link to the server, and host presence. The server can be reachable while a host is down.

- The WS link has four states: `connecting` · `connected` · `reconnecting` · `offline`.
- Host presence is tracked per `hostId`: `unknown` · `online` · `offline` (`unknown` until that host's first `host.online` / `host.offline` greeting arrives on connect). A chat's indicator reflects the presence of its own host.
- No offline flash on load. On first launch a surface is `connecting` with `unknown` host presence, and shows a neutral, quiet indicator until a connection has been established. The offline/reconnecting treatments are for `reconnecting` (was connected, dropped) and `offline` (a connect attempt has failed) only.
- Disconnect grace: idle is not a disconnect. The link state is always reported truthfully and immediately (diagnostics, composer, connection dot), but the reconnecting/offline banner only appears once the app has been in the foreground with the link down for 3s. Mobile OSes drop a backgrounded app's socket, so a close while backgrounded arms nothing, and on returning to the foreground a surface with no live socket dials at once (skipping any pending backoff step) and starts the 3s grace from there — a resume reconnect that lands within it never shows the banner. Backgrounding hides a banner already up; if the link is still down on return, it reappears after a fresh grace. A successful reconnect clears it.
- The host should dial the server as early as startup allows, and its first reconnect backoff step is short (≤1s) so a transient miss recovers within about a second.

### Server lost

A surface already shows its own dropped link (the banner, after the 3s grace). What it cannot show is that the server has been gone for a while, so two things escalate at one minute:

- The host reports how long its link has been down (`offlineSince` in `/internal/diag/link`: since the loss, or since start if it never connected; `null` while online).
- The desktop app, on a Mac that runs a host, reads that from the host's control socket every 15s from its main process. Past one minute it sets the tray tooltip to "server unreachable" and raises one native notification, and clears both when the link returns. A host it cannot read is logged, never treated as healthy.
- When the server is shutting down to restart (a deploy or self-update, on SIGTERM) it closes every host and surface socket with code 4503 (`CLOSE_SERVER_RESTARTING`), the reason being `server restarting into <version>` when the release it will run next is known (the release `current` points at) and `server restarting` when it is not. Unlike 4401 this is retryable, and it means _come back now_: the client redials immediately instead of entering its backoff, then retries at a flat 250 ms until the server answers, for at most 90 seconds. The state is shown live, with no grace period: the banner reads "Restarting into <version>" ("Restarting" without a version) instead of "Reconnecting…", and clears the moment the connection returns. If the server is still down after 90 seconds, or the drop was unplanned (no notice, including a server killed without a clean shutdown), the surface is in the ordinary reconnecting/offline state with normal backoff.
- The phone's banner, after a minute of foreground outage, changes from "Reconnecting…" to "Server unreachable. Retrying", and reverts on reconnect.

### Hosts fail independently

Offline is per host:

- Chats on reachable hosts stay usable while another host is down. The banner
  names the affected host and appears with that host's chats.
- Every buffer below (pending webhook/cron payloads, held messages) is
  keyed per host and flushed when that host reconnects.
- A chat, job or voice request stays with its own host, whose folders, tools and
  state are the ones it needs (`04-chats-and-folders.md`).
- While the Manager host is offline, Manager and Speakers are unavailable,
  and the surfaces say so (`06-threads-manager-speakers.md`). Announcements
  on the channels those threads mediate still go out from the hosts that own them
  and are still recorded, so the thread has them as context on its next reply
  (`09-notifications.md` § The broadcast log).

### Host-offline UX

A host being unreachable is a first-class, explained UI state. When a surface knows a host is offline:

- The banner appears immediately the moment the surface learns the host is offline — both on a live `host.offline` transition AND on (re)connect, because the server sends the current host status as an `auth.ok` greeting so a surface that connects after the host dropped shows it as offline. There is no window where the UI says "connected" while the agent is actually unreachable.
- A persistent banner states that the host is unreachable and that messages will be held and sent when it reconnects, with a tap-through to Settings → Hosts. It is scoped to that host's chats, and becomes app-level when every host is offline.
- Navigation stays fully available — the user can read history and browse chats/settings everywhere.
- The composer stays usable and its messages are held. A message into an existing chat, or an editor save, sent while its host is offline is ACCEPTED, held by the server, rendered in a distinct "Host offline — will send when it reconnects" state (never worded as merely "Queued", which reads as the agent being busy; a message already queued behind a turn has its chip read "Host offline" while the host is down), and delivered automatically on reconnect (see Guaranteed input delivery below). It is always accepted and always delivered. Spawning a new chat on an offline host is refused up front instead, because the folder cannot be validated (`04-chats-and-folders.md` § Spawn). Only real-time-only controls that genuinely cannot be held — a voice note/call, where audio is ephemeral — render visibly disabled with a host-offline reason.
- Only chat messages and document saves are held. A document save from a surface into an offline host is accepted and sent without the read-back or conflict check (they need the host), and says it will save when the host reconnects. Host settings do not queue: a host's name, Update and Sign in are disabled while it is offline, with no error raised.
- File browsing, file open and document history on an offline host show a calm "Host offline" in place of the content. A `host_offline` answer is a state, never an error toast or red error line.
- This state is distinct from WS-`reconnecting` and is shown as such.

### Connection diagnostics screen

"Can't reach the agent" is the single most common way Patch looks broken, and a bare `Reconnecting…` banner tells the user nothing they can act on or report. Every surface therefore has a connection diagnostics screen: a real error screen that says what it tried, what happened, and hands over a copyable report.

When it takes over the app (blocking). Only when the surface has yet to establish a WS link in this session AND at least two connect attempts have failed. That is the case where there is nothing else to show — no roster, no transcripts — so a banner over an empty shell is a worse lie than an error screen. It respects No offline flash on load: the first `connecting` attempt shows the quiet neutral indicator.

Closing it is always available. The blocking takeover carries the same Close as the on-demand overlay — leading with the error screen is not the same as trapping the user behind it, and a surface with nothing to show is still a surface the user is allowed to look at. A closed screen stays closed for the rest of the session: attempts keep failing in the background, and re-taking the window on each one would be an overlay that cannot be left. The banners' Diagnose action is how it comes back.

When it is opened on demand (non-blocking). In every other disrupted state — WS `reconnecting` after a good connection, or WS connected with the host `offline` — the existing banners stay exactly as spec'd (navigation available, composer queues) and each carries a Diagnose action that opens the same screen as a dismissible overlay. A surface with a host offline stays navigable behind it (see Host-offline UX).

What it runs. The screen runs the diagnostics itself, on open and on every Retry — it re-runs rather than restating cached state:

| Check      | How                                                                                                                                   | Distinguishes                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Credential | stored surface credential present + well-formed JWT                                                                                   | "not paired" from "paired but rejected"                                                                     |
| Server     | `GET /api/healthz` (public)                                                                                                           | server unreachable (DNS/TLS/offline host) from server up; reports `version`+`gitSha`                        |
| Host links | `GET /api/daemon/healthz` (authed) — one line per registered host, 401 on a bad credential                                            | a host being down from the server being down from a rejected credential — the whole point                   |
| WebSocket  | live surface state, after any dial in flight has settled: URL, connection state, failed-attempt count, last close code/reason         | a socket that failed to open from one that opened and dropped                                               |
| Protocol   | what forward compatibility absorbed this session (`03-wire-protocol.md` § Forward compatibility): fields ignored, event types dropped | a surface that is merely a little behind its agent from one that is missing behaviour the agent already has |

The Protocol check is the one place a surface admits it is older than its agent,
and it grades the two cases differently. Ignored FIELDS pass: the agent sent
something this build has no use for, which is drift worth seeing and nothing
worth acting on. Dropped event TYPES fail, naming the types and saying
"update this surface": the agent is emitting behaviour this build does not
implement at all. It is listed last so an upstream failure — no credential, no
server, no host — still supplies the screen's headline; being behind is never
the story when the link is down.

Each check renders pass/fail with its actual detail text (HTTP status, thrown network error message, version strings) — a check that could not run says so, and renders as its own state rather than a pass. Every failing check also carries one sentence saying what the user can do about it (pair again, wake the agent's host, check the network, update the app), shown under its detail and included in the copied report; a passing check has none.

Opening is as fresh as Retry. A surface that is not connected dials immediately when the screen opens, and the WebSocket check waits (up to 5s) for a dial already in flight to connect or fail before it reports, so the first look describes the attempt happening now and never the outcome of one made before Diagnose was pressed.

On mobile, Settings → Account → Reconnect to server opens diagnostics even while offline. Diagnostics includes Pair again, available while checks are running, which closes the overlay and opens the pairing scanner. A saved credential without a server route is incomplete pairing: startup opens pairing instead of the tabs and does not start network services. Completing pairing starts the connection and app services immediately, without restarting the app.

Retry cancels the reconnect backoff and dials immediately (backoff resets to its first step), then re-runs the checks.

Report copies a plain-text diagnostic report — timestamp, origin, WS URL, surface build version/sha, connection state, and every check line — to the clipboard, so a broken surface can be reported from the surface itself.

### Guaranteed input delivery (surface → host)

A user's `chat.input` is either delivered or reported as failed. There are two hops (surface↔server, server↔host) and each can flap mid-send: a message handed to a socket that dies an instant later is gone with no error. Delivery is made resilient by tracking every input to completion:

- Idempotency key. Every `chat.input` / spawn carries a `localId`; the host dedups on `(chatId, localId)`, and so does the server for what it holds, so re-delivering the same input is a safe no-op. This is what makes blind retry correct.
- Pending until observed. The sending surface marks the message pending the instant it is submitted and keeps it pending until it OBSERVES a receipt or the turn take effect: `chat.input_held` (the server holds it for an offline host), `chat.input_ack` (below), the chat going Running for that turn, a `chat.queued {localId}`, the assistant `chat.message`, or a `chat.error`. A held message is drawn as held for the offline host (§ Host-offline UX) until its host acks it. Pending messages render in the distinct "sending…/queued" style — the style says whether the turn actually started. The pending line leads with an icon: a clock while the host is online ("Sending…"), a cloud-off while it is away.
- Ack. The host emits `chat.input_ack {chatId, localId}` the moment it accepts an input for processing (before the first token); the server relays it. This is the positive receipt that retires the pending state even before output streams — and distinguishes "delivered, working" from "lost".
- Timeout → idempotent redelivery → loud failure. If a pending input is neither acked nor observed-running within a bounded window (~8s), the surface re-delivers it (same `localId`; the host dedups if it did arrive). After a few failed attempts it stops and shows a persistent "not delivered — tap to retry" affordance on that message. A turn NEVER sits as a silent spinner forever — it resolves to running, to an error, or to a retry affordance.
- A connected host is not proof that a running worker is healthy. Once a turn has started, ten minutes with no provider event or tool progress ends it with a visible, retryable "agent stopped responding" error. This covers a worker or tool child being killed while the host control socket itself stays online; the UI must not mislabel that state as the whole host being offline, and must not leave the turn `running` forever.
- Tapping retry is chat-wide, not message-wide. Consecutive sends can each fall into the same flap and pile up as several "not delivered" messages in one chat; tapping retry on any one of them re-sends it AND every other still-pending input in that chat submitted before it (idempotent — same `localId`s, the host dedups), so one tap un-sticks the whole backlog instead of making the user hunt down and tap each earlier message individually. Inputs submitted after the tapped one are untouched — they are still on their own timeout/retry schedule.
- Held across an offline host. While the host is offline the server holds inputs on its disk (`01-server.md` § Responsibilities) and delivers them in arrival order when the host returns; when the server is also unreachable, the surface keeps them and sends them on reconnect. Ack and observe proceed as above.
- Survives a server restart. Held messages are on the server's disk, so a restart keeps them, and the surface still holds each input it has no receipt for and redelivers it once its own connection is back. The surface is the source of truth until it sees a receipt.
- A turn that was delivered, started, and then failed for an unclassified reason (as opposed to a specific, recoverable case that gets its own error message, like an offline host or an invalid session) is reported on the message that failed, the same "tap to retry" treatment as an undelivered input, rather than as a separate line in the transcript — every "this didn't get a reply" case looks and behaves the same regardless of which hop broke. Retrying resends the message's text as a brand new turn: the original is already recorded as run, so resending its exact input would be deduped into a no-op rather than actually retrying it.

### Server restarts

- All connections drop; surfaces show the server restarting or unreachable (§ Server lost).
- The stop is bounded: every connection gets the going-away notice, open requests are cut rather than waited on, a socket still open 2 seconds after its notice is closed, and a stop that has not finished in 15 seconds ends the process and is logged as a fault.
- Nothing is marked failed and no chat changes status because the server went. Turns keep running on their hosts, whose outboxes hold what they produce.
- The server starts from its record, chat index and held messages on disk (`01-server.md`), so every chat and its history is available to surfaces as soon as it is up, before any host has reconnected.
- Hosts reconnect and resend everything after their last acknowledged outbox position; surfaces resume the feed from their positions.

### A host restarts

- Turns, terminals, watches and background jobs run as their own processes and keep going. The host reattaches to them on start and loads only the chats with live or owed work (`02-host.md` § Host restarts, § Chat loading).
- Every stop the host chooses (a self-update, a service restart, a signal) announces itself first, so the chats it was working on show Host restarting rather than Host offline (§ Chat status). A host that crashed is Host offline until it returns.
- When the host is back each turn is live again, or ended while it was away and reported through the outbox, or, if its process is gone, Interrupted.

### A host's machine goes down

- The turns' processes die with the machine. When the host is back, each turn that was running is Interrupted (§ Continue).
- Chats with no turn owed come back idle and stay there — a reboot does not wake a chat that was already finished.
- A turn that was mid-tool-call loses that tool call; the provider's session holds everything up to it.

### Events for unknown chats

- A `chat.state` or `chat.error` for a chat absent from both the chat index the surface holds and its own optimistic rows is ignored. State and errors update a chat; they never create one.
- Hidden is independent of failure: a hidden background/job chat that becomes Failed remains in Hidden and never moves into the main project list. Archived and deleted lifecycle states still take precedence over Hidden.

### Webhook arrives while a host is down

- Server can't route to that host. Stores the webhook payload in `/data/pending/<hostId>/<jobId>-<fireId>.jsonl`.
- When that host reconnects, server flushes its pending payloads.
- Bounded: max 100 pending per job, oldest dropped with a log line.

### Cron fires while a host is down

Patch's server owns the cron scheduler (see `08-triggers-and-jobs.md`), so a tick still fires regardless of host presence. Routing the resulting action is the question:

- Server fires the trigger, evaluates the filter, resolves action templates as normal.
- If the action's host is connected, it dispatches over that host's WebSocket.
- If that host is offline, the action payload is written to `/data/pending/<hostId>/<jobId>-<fireId>.jsonl` (same path as buffered webhooks) and flushed when the host reconnects.
- Bounded the same way: max 100 pending per job, oldest dropped with a log line.

A buffered fire does not wait unseen. Once it is more than 10 minutes late the server adds one silent entry to the notification bell, never a push, naming the job, the host and the time it was due, so the user finds out on opening the app (marked on the pending file so a restart does not repeat it). When the host returns and the fire is released more than 10 minutes after it was due, the chat it creates is named `<job> — ran late (due HH:MM)` (HH:MM in the job's cron timezone); a `message` fire into an existing chat leads with `[Ran late (due HH:MM): its host was offline.]`. A job may also ask its host to wake ahead of time (`08-triggers-and-jobs.md` § Wake host).

If a host stays offline through multiple cron firings, the user gets a backlog of spawns/messages on reconnect rather than missed work. For idempotent jobs (e.g. "spawn a daily bus-watch chat") this is usually fine; for jobs where a backlog would be wrong, the job should set its own dedup key inside the spawned chat's prompt.

A backlog released by a reconnect is still subject to the job's own concurrency limit (`08-triggers-and-jobs.md` § Concurrency) — a host coming back does not let a limited job run its whole backlog at once. This is the difference between the two queues: the pending buffer is per host, capped, and drops its oldest when full; the concurrency queue is per job and unbounded — a fire waits, it is never refused.

In-chat timers use `patch_wake_me` (`02-host.md` § Self-wake), which is durable across host restarts: the pending wake is persisted to disk, re-armed on boot, and any wake that came due during downtime fires once on restart (`principles.md` § Patch-owned state).

### Voice session mid-disconnect

- All voice surfaces (phone, web, voice device) stream audio to the host over WSS for host-side Whisper + Kokoro. If the WSS drops, the audio session ends. On the phone/web, surface UI shows "voice disconnected" and falls back to text input. On the voice device, LED ring shows the disconnected state and returns to idle.
- Reconnect resumes the next voice session from scratch — audio sessions are not replayed on reconnect (audio is ephemeral).
- If a voice user-turn message had been transcribed but not yet delivered to the chat when WSS dropped, the host retries on reconnect. If retry fails within 10s, the surface is told "delivery failed, try again."

## What we don't do

- No transactional guarantees across chats. Each chat is its own stream.
- No end-to-end receipts for notifications — we don't confirm a user actually saw a push. (User input, by contrast, IS delivery-guaranteed — see Guaranteed input delivery. The distinction: an input we accept must reach the host or fail loudly; a push is fire-and-forget.)

## Observability

- Every WebSocket connect/disconnect logged with reason code.
- Host heartbeat dashboard in the web app (admin/developer view).
- `patch doctor` (CLI) runs: check server reachability, per-host status, pending webhook/cron count, failed chat count. See `17-cli.md`.

## Cross-refs

- Frames, positions and the account feed: `03-wire-protocol.md`
- Status authority, held messages and the chat record: `01-server.md`
- Host outbox and reattach: `02-host.md`
- Account states, limit behaviour and sign-in: `10-auth.md`
- Device copy and loading: `05-surfaces.md`
- Surface heartbeat + presence: `05-surfaces.md`
- Notification-on-disruption: `09-notifications.md`
