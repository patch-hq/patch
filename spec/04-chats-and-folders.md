# Chats and Folders

## Chat model

A chat is one agent session pinned to a host and a folder on that host. Analogous to running an agent CLI inside that folder on that host, except the session is persistent, routable, and observable from other surfaces.

- Identity: `chatId` (ULID, prefix-matchable like Happy's session IDs).
- Host: `hostId`, chosen at spawn alongside the folder and fixed for the chat's life. Moving to another host starts a new linked chat there (§ Moving to another host); replacing a host with a new machine that takes over its chats is the guided step in `11-deployment.md` § Replacing a host. A chat on an offline host stays visible and readable, and a message sent to it is held by the server, on disk so a server restart does not lose it, and delivered when the host reconnects (`12-error-and-offline.md` § Host-offline UX). Spawning a new chat on an offline host is refused up front instead, since its folder cannot be validated (§ Spawn).
- Name: short human-readable label for the sidebar. AI-summarised from the chat's first user message — as soon as that message is accepted (not once the turn settles), the host fires a cheap one-shot model query over it (a Codex/ChatGPT chat is titled on its own model, like its goal check, since a Codex-only host has no Claude account) and stores the resulting 2–6-word Title-Case summary in `meta.json.name`. Triggered ONCE per chat, asynchronously and non-blocking, so a long-running turn never delays the title landing, and only for ordinary chats (special threads keep their fixed names). A job-spawned chat gets exactly this one user message and no other, so that single trigger gets two real attempts (a short delay apart) before giving up — a transient error or empty first reply must not permanently strand it as "New chat" with no later message able to retry it. Until a title lands — or once both attempts fail/return empty — `name` stays `null` and the surface shows "New chat" (never the folder basename: two chats in one folder would then carry the same title, and it reads as a real name rather than as "not named yet"); the title comes only from the summariser, so a raw `[Attachments]` path stays out of it. Renameable from any surface: a rename stores the name in `meta.json.name`, and clearing it to empty stores `null` so the surface goes back to "New chat". Because the summariser is only triggered over a chat whose `name` is still `null`, a rename is never overwritten — including one made before generation lands. Special threads are not renameable.
  **Ambiguous titles.** When a title is shared by chats on more than one host, a list row names its host (the host's name, as on the chat header) beneath the title, on web and phone; a title unique to one host, or repeated only within one host, carries no host.
- Current status: what a chat IS to the user, carried on `chat.state` as `statusKind` + a one-line `statusSummary` (not shown in the sidebar; other surfaces such as notifications and the snooze sheet still use it). Three kinds put a chat in the list and one keeps it out — `question` (blocked on the user: an answer, a decision, or a thing only a person can do in the world), `report` (not blocked, but the agent has elected to say this is worth seeing) and `complete` (finished, nothing outstanding — a hidden job that ends `complete` does not come into the list; it stays in Hidden, § Chat model). A permission prompt is the fourth way into the list but is not a kind: it is a live request derived from `pendingPermissions`.

  **Generated vs declared.** Most statuses are GENERATED: a cheap model summarises what the agent did in the settled turn — read from the agent's final reply only, generated once that reply is complete, never from the user's request — in at most 80 characters so the row shows it whole. A summary the model returns over that length is dropped (logged), never cut with an ellipsis. The pair is in-memory only, cleared the instant another user message is accepted (including one queuing behind a running turn) so no surface shows a status predating the message on screen. A `question` or `report` set by the agent's own tool call — `patch_ask_human`, `patch_report` — is DECLARED, and is a different kind of fact. It is persisted to `meta.json`, so it survives the host restart every deploy performs; it outranks the generator, which may not overwrite or demote it; and it is cleared by a USER turn and nothing else, because a machine turn is the chat carrying on, not evidence anybody read it. Declaring also takes the chat out of Hidden (and out of Archived), one-way.

  **A notification does not unhide its chat.** `patch_notify` takes its source chat out of Archived, one-way, but leaves Hidden alone: the notification is how the user is reached, and a hidden chat stays hidden. It does not set a status — the row carries no `statusKind`. A chat that wants into the list declares a status (`patch_report`) or asks a question.

- Lifecycle: chats run forever in storage, and history is retained. The UI inbox treats them as unread / read / archived (see `14-design-web.md` § Chat lifecycle): new activity → unread (`·`); user visit → read (`✓`, subtly greyed). Read is user-driven only. There is no auto-archive — a chat stays in the active list until it is manually archived (the chat header's archive icon or the sidebar row's archive button).

  **Archived means stopped.** Archiving is how the user says "this is finished", so an archived chat never runs anything: archiving stops the running turn (as Stop does, including any permission request it is parked on), drops every queued message, cancels its pending self-wake, stops every `patch_watch` task it owns, and abandons any turn paused until a reset or waiting on a transient retry — on EVERY branch the chat has, not only the active one (§ Parallel branches): a side branch mid-turn is stopped and its own queue dropped right alongside the active branch's. Nothing the chat set in motion fires afterwards, so nothing the chat did can bring it back. A chat that is working in the background without bothering the user is not archived — it is hidden (below).

  Archive is sticky against being merely opened or resumed: an archived chat stays archived when it is opened, resumes after a restart, or sits idle. But a MESSAGE landing in it starts it again: the user's own composer or a job tick into a `continue` chat un-archives the chat before the turn runs. Another agent's `patch_send_to` does the same, and its result tells the sender the target was archived (`targetWasArchived: true` with a note) so it knows it has woken a chat the user put away. It comes back to where it was before it was archived: a chat that was hidden (§ Chat model) returns to Hidden, unless the message is the user's own or another agent's `patch_send_to`, which bring a hidden chat into the active list. Un-archiving is one-way: nothing re-archives the chat afterwards except archiving it by hand again (the chat header's or sidebar row's archive icon, or the chat-panel banner's Unarchive control for un-archiving without sending anything). Archiving the chat you are currently reading moves you on with it: the chat leaves the active list and the surface opens the next chat in the sidebar's drawn order — the row that was below it, the nearest row above it if it was the last one, or the top of the list if it had no row of its own (a snoozed chat, say), and the new-chat screen when nothing active is left. This holds however that chat was archived (its header icon, its sidebar row, the keyboard shortcut, or a bulk/project archive that included it), and when the archive was made on ANOTHER surface: a surface showing the chat when its `chat.state` arrives as archived moves on the same way (the web opens the next chat; the phone goes back to the chat list), once, and a surface that archived the chat itself does not move twice; unarchiving never navigates. Deleting a chat is a recoverable soft-delete — it moves to a Deleted section and can be restored (nothing is hard-deleted from the surface).

- Snooze: a chat can be snoozed until a moment in time (Gmail's snooze). Snooze is a separate axis from `status` — a snoozed chat is still `active`; it carries a `snoozedUntil` ms-epoch timestamp. While `snoozedUntil > now` the chat is hidden from the active list and appears in the sidebar's Snoozed section with its wake time. When `snoozedUntil` passes, `snoozedUntil` clears itself and the chat returns to the active list unchanged (same unread/read state, same `lastUpdated`, so a snooze leaves the chat's activity as it was). See § Snooze below.
- Hidden: a chat can be hidden — running, but out of the active list. Like snooze it is a separate axis from `status`: a hidden chat is `active`, carries `hidden: true` on `chat.state` (persisted in `meta.json`), and is drawn only in the sidebar's Hidden section. It is how a job whose runs are background noise keeps them out of the way (the action's `startHidden`, `08-triggers-and-jobs.md` § Action), and it is the opposite of archived: a hidden chat is expected to be doing something, an archived one never is. A chat leaves Hidden, one-way, when the user needs to see it or has chosen to: another agent's `patch_send_to` writing into it, the agent declaring a `question` or `report` (§ Chat model), or it blocking on a permission decision or an `AskUserQuestion` (`02-host.md` § Permission mode), so a request nobody can see cannot sit unanswered. If that prompt then EXPIRES unanswered (`02-host.md` § Permission mode) nobody saw it, so the chat goes back to Hidden and the agent is not told of the round trip; an answer or a manual hide/show makes the exit stick. Everything else — a USER message sent into it, a self-wake, a watch completing, a job tick, the todo list advancing, a turn re-sent after a usage limit — leaves it hidden. The Hidden section's row (and the hidden chat's banner) carries Unhide, which un-hides without sending anything (`chat.hide_request { hidden: false }`). Archiving a hidden chat stops it like any other but leaves `hidden` set: it has no effect while the chat is archived, and it is where a host message starting the chat again returns it to (§ Chat model). A hidden chat that FINISHES stays in Hidden: nothing archives a chat automatically, so a job's chat is never in Archived unless a person put it there, and a `patch_ask_human` or `patch_report` from it reaches the user by moving it from Hidden into the list (the one-way exit above) rather than out of Archived. Its next message starts it again, hidden. Special threads cannot be hidden. The user hides a running chat from the chat header's ⋯ menu (web) or the row's long-press sheet (phone) — `chat.hide_request { hidden: true }` — and the AGENT is told: the next turn carries a note (§ Notes to the agent) saying the chat is now in hidden mode (or, when it leaves Hidden, no longer in it), the way a surface's edit to the task list is. Hiding then showing before that turn says nothing.

- Pinning: `folder` is set at spawn and holds for the chat's life.
- Many per folder: each `cd ~/projects/x && patch new` creates a fresh chat in that folder. Projects are just folders with ≥1 chat.
- Subagent: a chat created by another chat's `patch_agent` carries `meta.subagent: { parentChatId, label, outcome? }` for its whole life — never cleared, never on any other chat. Its record lives exactly where every other chat's does (`~/.patch/chats/<chatId>/`); the field is what makes it a subagent rather than a separate storage shape, and what every listing (this section, search, `patch_list_chats`, the sidebar) excludes it on. Full lifecycle/durability/permissions contract: `02-host.md` § Background work.

## Spawn

Caller provides:

- `hostId` — the host to run on. Required. A spawn naming an unregistered host
  is an error, and one naming an offline host is rejected up front with the host
  named.
- `folder` — absolute path on that host. Paths are scoped to their host: the same
  string on two hosts means two different directories.
- `model` — optional, and from that host's catalogue (`02-host.md` § Model
  catalogue). The chat starts on the model named here, or on the host's last-used
  model when it is omitted, and can be changed later (§ Model). It selects the
  backend the chat runs on. A host records the model of each chat spawned on it,
  so the last-used value follows the host rather than the surface that asked,
  and a host carries one from its first successful catalogue read (`02-host.md`
  § Model catalogue) — so a spawn on a newly added host needs no model. Until a
  host has read a catalogue it has none, and a spawn there that names no model is
  an error saying so. When the account's default model belongs to a provider
  with no account on that host able to run it (signed out, or out of usage), the
  server starts the chat on the first catalogue model whose provider has one;
  if none does the default stands. Surfaces show the same choice.
- `account` — optional. Names one of the provider's accounts and locks the
  chat to it; without one the chat is Automatic and each turn's account follows
  the provider's account strategy (`10-auth.md` § Choosing an account).
- `prompt` — optional initial prompt.
- `parentChatId` — optional, for spawns from a special thread (tracked for observability).

Host:

1. Generates `chatId` (ULID) and validates the folder exists on this host.
2. Starts the first turn through the provider's adapter (`02-host.md`), in `folder`, with Patch's MCP server and the chat's permission mode (`02-host.md` § Permission mode).
3. Captures the provider's session id from the adapter as the chat's `sessionId`.
4. Writes `~/.patch/chats/<chatId>/meta.json` (chatId, provider, sessionId, folder, createdAt, name=null until first turn finishes).
5. Records the adapter's events as the chat's entries (§ History).
6. Emits `chat.spawned`.

A refused spawn creates no chat, but it does not lose the message. The refusal is
reported against the `chatId` the spawn was allocated, and a chat-scoped error
reaches every connected surface — but a surface builds a chat row out of any
`chatId` it has not seen before, so the refusal alone would draw a nameless,
folderless row for a chat that does not exist and never will (it is absent from the
chat list, so nothing later corrects it). The refusal therefore also names that
`chatId` back to the caller as one to retract, and the caller drops the row.
Retracting is idempotent and final: a duplicate or late-arriving error for a
retracted chat does not redraw it, since the error frame and the refusal travel
separately and can arrive in either order.

What stays is the surface's own new-chat draft (`14-design-web.md` § New chat
drafts), not a chat: the message the user sent, with the folder, host and model
chosen, is kept as a failed draft that lists in the sidebar with the reason it
failed, and opens on the new-chat screen with the error and a Resend. Resending
spawns afresh from the draft as if it had just been sent; success consumes the
draft, another refusal leaves it failed with the new reason. The user discards it
like any draft. A spawn refused after the chat was already shown (the host's
refusal arrives late) turns back into a failed draft the same way, and the user is
moved onto it. The failure marker belongs to the surface it happened on and is not
synced; the message is, as any draft is. A long message is therefore never lost to
a refused spawn. The user still hears of the failure once, by the toast
(`12-error-and-offline.md` § Principles), and the failed draft is where it stays.

## Model

A chat's model can be changed at any point in its life, from any surface
(`14-design-web.md` § Model selector). The host owns the value and persists it
with the rest of the chat's state, so a change outlives a host restart instead
of quietly reverting to whatever the host was last used on.

A change takes effect on the chat's NEXT turn. Each turn is its own call to the
backend resuming the same session, and the model in force is read as the turn
starts, so a change made while a turn is running leaves that turn alone. The
surface says which turn the change applies to rather than implying the running
one switched.

The model named must be one the host's catalogue currently offers (`02-host.md`
§ Model catalogue). One that isn't is refused naming it, and the chat stays on
the model it was already running — never rounded to a near match. A chat keeps
one provider for its life: the picker changes the model within it, and choosing
a model of another provider is a provider switch (§ Provider switches), which
starts a new chat.

Changing a chat's model does not change the host's last-used model. Last-used
records what new chats start on, and a mid-chat change is scoped to the one chat
it was made in — repointing every future spawn from it would be a change the user
did not ask for and cannot see.

The host reports the chat's current model in the chat's state, so every surface
holding that chat converges on it: two windows open on one chat always agree
about which model it is on.

Also reachable as a composer built-in: `/model <name>` typed in the composer
changes the chat's model the same way the picker does, without opening it —
matched case-insensitively against the host's catalogue by id or label,
uniquely-abbreviated names accepted (e.g. `/model opus` where only one
catalogue entry contains "opus"). A bare `/model` or a name matching nothing
or more than one entry is a usage error naming the problem, and no change is
sent. A name matching another provider's model opens the provider switch, as
the picker does.

### Provider switches

Switching to a model of another provider starts a new chat linked to the old one,
on the same host and in the same folder. The surface asks the server to draft it
(`POST /api/chats/:id/continue {model}`), which stores a new-chat draft (`14-design-web.md`
§ New chat drafts) naming the chat it continues, and the surface opens it on the
new-chat screen. Its first message is the draft the user reads, edits and sends:
that message is the only context that carries over. The starting text is drafted
from the server's record of the old chat, with no model call, so it works while
the old chat's host is offline: one line naming the old chat, its model, host and
folder, then the last request and how the last reply ended, and every request
still unanswered, each quoted. The user can keep it, change it or clear it, and
nothing reaches the new model except what the sent message says. A host refuses a
model of another provider on an ordinary chat (`provider_switch_needs_new_chat`),
so a surface too old to draft a linked chat cannot switch one in place.

Sending the draft spawns the chat with `continuedFrom` (`POST /api/chats`), and
once the host confirms it the server records `continuedFrom` on the new chat and
`continuedIn` on the old one, and stamps both on every `chat.state` it sends. A
chat is continued once: drafting or spawning a second continuation of the same
chat is refused, naming the newer chat. Surfaces show the two as one continuing
thread: one row in the chat list (the newest chat; an earlier one keeps its own
row only when its continuation is deleted), and a divider at the start of the
new chat naming the chat it continues and the models either side of the switch,
with a matching divider at the end of the old chat naming the chat that
continues it. Each divider opens the other chat; the earlier chat's messages are
read there rather than drawn above the new chat's. The old chat stays as it was,
readable and able to continue on its own provider.

The Manager and Speakers change provider in place instead (`06-threads-manager-speakers.md`).

When every account of a chat's provider is out of credit, and another provider
the chat's host can run has a ready account, the out-of-usage banner and the
limit card offer Change provider. It opens the provider switch onto the first
model of the other provider in that host's catalogue; the request that met the
limit is still unanswered, so the drafted first message carries it. With nothing
usable on the other provider, or no model for it in the catalogue, the choice is
disabled with the reason.

### Moving to another host

Moving a chat to another host is a deliberate user action and works exactly as
a provider switch does: it starts a new chat on the target host, linked to the
old one, whose first message is a visible draft the user reads, edits and sends,
with Patch's drafted summary as the starting text. No provider session is
copied or carried across; the new chat's session starts from that message. The
two chats show as one continuing thread, with a divider naming the hosts either
side of the move, and the old chat stays as it was on its own host.

Web (chat header ⋯ → Move to…), mobile (chat ⋯ → Move to…) and the CLI
(`17-cli.md`) call `POST /api/chats/:id/move {hostId, folder}`, which creates
the linked new-chat draft and answers with it; web and mobile open it on the
new-chat screen, the CLI prints its first message, and sending it spawns the
chat as any draft does (§ Spawn). The draft keeps the chat's model. Nothing is
asked of either host, so a chat whose host is offline moves the same way. The
picker lists every host (offline ones disabled), the chat's own host included
for a move to another folder there, then the chosen host's folders,
pre-selecting the one named like the chat's current folder, else the first that
host offers; any absolute path can be typed. A special thread is not moved this
way; its home changes as `06-threads-manager-speakers.md` § Changing home
describes.

A move made before linked chats could take a chat over from the server's copy
while its old host was offline, leaving that host owed a retire of its copy.
Such a debt is still paid: when the host next finishes its start-up inventory the
server asks it to set the old copy aside (under `~/.patch/moved/`) before
reconciling it.

## Effort

A Claude-backend chat can carry a thinking-effort override (`low`, `medium`,
`high`, `xhigh`, `max` — the SDK's own `EffortLevel`), changeable at any point
in its life from any surface (`14-design-web.md` § Effort control), the same
way its model is. `null` (no override) is itself a valid choice, meaning the
model's own default governs — unlike the model, which always has some value,
a chat can have no effort override at all.

A change takes effect on the chat's NEXT turn, read as that turn starts, for
the same reason a model change does: a running turn is left alone. The host
persists the chosen value with the rest of the chat's state, so it survives a
restart, and reports it on the chat's state so every surface holding the chat
converges on it.

Codex has no equivalent option. A chat on that backend has no effort to set;
a request to set one is refused.

Also reachable as a composer built-in: `/effort <level>` typed in the
composer changes the chat's effort the same way the picker does. Unlike
`/model`, a bare `/effort` is not a usage error — it clears the override,
since "no override" is itself a value effort can hold. A level matching
nothing is a usage error naming the offending text, and no change is sent.

## History

- The record: the server holds Patch's record of every chat, one append-only log per chat in Patch's format, independent of any provider (`principles.md` § History ownership; storage in `01-server.md`). It has one entry per message, tool call, result, artifact, permission decision, note to the agent and turn boundary, and it is the source for display, search, paging and every surface. A tool result too large to keep inline, or one carrying an inline image, is moved out of line into a content-addressed blob store and replaced by a reference.
- One writer: a chat's entries are written only by its host. The host translates the adapter's events into entries, numbers them (`seq`) and sends them through its outbox (`02-host.md`); the server stores them in that order and never renumbers. A host taking over a chat (a replaced host, a Manager home change — `06-threads-manager-speakers.md` § Changing home) continues from the server's highest stored `seq`.
- `nativeRef`: each entry carries the provider's own id for the message or turn it came from. Native edit, rewind and branching address the provider through it (§ Branching); nothing else reads the provider's session.
- The provider's session: stays on the host in the provider's own format, written only by the provider. Patch never reads it for display, never edits, strips or rebuilds it. A Claude chat keeps its session in its own Claude config dir (`~/.patch/chats/<id>/claude`), into which the user's skills, agents, commands, plugins, settings and `CLAUDE.md` are linked at spawn. Older hosts also kept a copy of it under `~/.patch/chats/<id>/native/claude`; nothing reads that, and the host removes it once at start, first moving a session that has no copy of its own into the chat's config dir so it can still resume.
- Access: surfaces read history only from the server, asking for what is new since a position and for older pages before a position (`03-wire-protocol.md`); a host never answers a history request. A request can name a `branchId` — absent means the chat's active branch — and this is how the Side threads panel (`14-design-web.md`, `15-design-mobile.md`) pulls a tab's content: a side branch's messages are not broadcast live (§ Parallel branches), so the panel reads them this way, while the branch is `running` and once more on open otherwise. A branch's track is its own entries plus its ancestors' up to (and, for a side thread, including) the message it forked from — an edit fork excludes the edited message itself, since the fork provides its own replacement.
- A failed turn is a quiet system note in history, never the harsher live `chat.error` — the record never carries `chat.error` itself (it isn't a lasting fact about the chat, unlike the turn's own outcome).
- Command turns: a slash command is recorded as the user sent it, `/name args`, with the arguments trimmed. Its expansion and output are the command's internals and are not recorded as user turns. The live message and its entry are one entry with one `seq`.
- Harness prompts: a prompt the harness sends on its own (Claude Code's "Continue from where you left off." on resuming an interrupted transcript, say) is recorded as the harness's, labelled so, never as a message from the user; its reply is recorded as the provider gave it.
- Retention: Patch's record is kept forever, never pruned. A provider's own session retention and auto-delete are that provider's settings, shown per provider in Settings (`10-auth.md`) and never overridden by Patch; a session the provider deletes is handled as § Resume describes.
- Encryption: the record is stored unencrypted; server and host disks are trusted. See `10-auth.md`.

### Notes to the agent

Patch tells a chat's agent about things that happened outside its turns — the chat being hidden, a goal set or a periodic reminder, hook advice, a document edited or commented on, a side thread sending back — only by an ordinary message in the chat's record, sent through the provider's interface. Each note is its own entry (`chat.note`, `03-wire-protocol.md`) with a label, shown in the transcript as a quiet collapsed row the user can open to read exactly what the model was sent. A note waits until the chat's next turn is accepted, goes ahead of that turn's own message, and is then cleared; a turn can carry several. Nothing reaches the model that the record does not show (`principles.md`).

The labels are `Hidden`, `Goal set`, `Goal cleared`, `Reminder`, `Hook advice`, `Hook failed`, `Document edited`, `New comment`, `From <branch>`, and, for the rest of what Patch tells the agent: `Todo list updated` and `Todo item fired` (§ Task list, `02-host.md`), `Broadcast digest` (a special thread), `Meeting context`, `Voice conversation` and `Voice hand-off` (`07-voice-app.md`), `Handoff` (a Manager picking up a thread), and the restart notices `Turn interrupted by restart` (and `… (pending decision)`), `Turn moved to another model` and `Turn restarted on a new session` (`12-error-and-offline.md`).

What the model receives is plain text: a header line `[Note: <label>]`, the body, then `[End note]`, at the front of the turn's message. It is not markup the provider treats specially, and a body that contains the end line has it escaped so it cannot close the note early. Only leading blocks are notes; the same words in the middle of a user's message are the user's own. The entry's seq is allocated ahead of the message's, so a replay from the provider's transcript, which holds the note and the message as one user turn, splits them into the same two entries at the same seqs. A restart re-send keeps the interrupted turn's own prompt inside its note, so the entry shows it in full while the user's message reads `Carry on`.

A record written before notes were entries holds them as `<system-reminder>` blocks on the user message, or as a `systemContext` field on its `chat.message`. Those still replay: the blocks come out as `chat.note` entries labelled from their wording, and a stored `systemContext` is shown under its message as before. Nothing writes either form any more.

## Resume

Each turn resumes the chat's provider session through the adapter's own resume. Turns keep running through a host restart and the host reattaches to them (`02-host.md`); a turn genuinely cut off shows as interrupted with Continue (`12-error-and-offline.md`).

A provider session that is gone — deleted by the provider's own retention, refused as unresumable, failed twice in a row, made by another provider (a chat switched in place before linked chats), or never recorded — stays gone. Patch does not rebuild it. The chat stays readable from the record, `sessionId` is cleared, and a divider in the transcript (a `system` message flagged `sessionGone`) says the model's memory of the chat ended there and why. The next message starts a new provider session that knows nothing of what came before. To carry context over, the divider offers Start a linked chat: the provider-switch flow on the chat's own model (§ Provider switches), whose drafted first message the user reads, edits and sends; it is not offered once the chat has been continued. A turn re-sent on a fresh session after its session failed carries a note saying the new session has no memory of the chat. A job's `continue` action into such a chat still runs.

A turn on another account of the same provider resumes the same session; the provider's own resume carries it across accounts. Patch never carries a session into another provider, and never adds unseen text to a message: "Continue" after a stopped turn sends exactly "Continue".

A chat whose folder no longer exists is found when the chat is loaded (`02-host.md` § Chat loading) and flagged `folderMissing` in its own `meta.json`. An archived or deleted chat is flagged quietly: no per-start warning, no status change, nothing returns to the active list. Any other chat is reported failed with `folder_missing`, so the reason input fails is visible before the user types. The flag clears when the folder is back.

## chat_state (live)

Separate from history. Built by the server from its chat index, its status and its record, and returned by `patch_peek` (`06-threads-manager-speakers.md` § Cross-chat toolset):

```typescript
type ChatState = {
  chatId: string;
  hostId: string;
  hostOnline: boolean; // is the chat's host connected right now?
  name: string | null; // sidebar label
  folder: string;
  chatStatus: ChatStatusInfo | null; // the server's status, 12-error-and-offline.md
  status: 'active' | 'archived' | 'errored' | 'deleted'; // lifecycle
  pinned: boolean;
  pinnedAt: number | null;
  snoozedUntil: number | null;
  model: string | null;
  lastUpdated: number;
  lastMessages: { role: 'user' | 'assistant'; content: string; seq: number; ts: number | null }[]; // latest 20 messages of the track
  lastMessage?: string; // the latest assistant message
  lastError: { code: string; message: string; at: number } | null;
  eventCount: number; // entries in the chat's record
};
```

Not persisted, and no host is asked for it: a chat whose host is offline returns the same as any other, with `hostOnline: false`. The `events` slice `patch_peek` returns alongside it is the latest page of the server's record.

A chat's status is decided by the server alone, from the facts its host reports, and surfaces display it as sent (`12-error-and-offline.md` owns the statuses and their transitions). A host going silent mid-turn makes the chat "host offline", never a stale running or a false failed; when the host reattaches it reports the turn it kept running, or the turn that was cut off, and the status follows.

## Stopping

`patch chats stop <id>` calls interrupts the turn through the adapter (in-flight tool calls and the model turn). Chat metadata is retained; a later message resumes the chat's provider session automatically. The stopped turn raises no completion notification (`09-notifications.md` § A turn the user stopped).

## Message queueing

Parity with the agent's type-ahead: a user can keep sending messages to a chat that is already `running` a turn. The host queues input behind the in-flight turn and runs queued turns serially, in arrival order, once the current turn finishes.

- Server-run queue. A message a surface sends behind a running turn is held by the server, not the host. The server acknowledges it (`chat.input_ack`), announces it (`chat.queued`) and keeps it on disk, so the queue survives a host restart and a host being offline. The server decides when it goes in: at a tool boundary the host asks (`patch.queue_pull.request`) and takes everything waiting, in order, behind whatever the host itself holds; when the chat goes idle the server sends the next message as a plain `chat.input` and reports the chat as still running until the queue is empty, since an idle report between two queued turns would read as finished. Cancel, edit and send now (`chat.unqueue_request`, `chat.edit_queued_request`, `chat.promote_request`) act on the server's queue when the message is there and go to the host when it is not. Send now stops the running turn and leaves the order alone. A side-branch message and a voice-device message go to the host (held by the server while that host is offline, § Chat model), which keeps its own queue for turns it starts itself (a goal resubmit, a self-wake). The host takes the server's answer for no longer than two seconds; without one the turn carries on and the message goes in when the chat idles. A chat that idles while its host is unreachable is reported idle as it is, not as running, and what waits goes the moment the host attaches again. Archiving a chat drops what the server holds for it.
- Open question. While an `AskUserQuestion` is on screen the server holds nothing: the blocked turn never reaches a tool boundary, so a message sent now goes straight to the host (which cancels the question with it), and messages already waiting are released to the host when the question opens.
- Host model. Each chat has a FIFO turn queue drained by a single per-chat serial pump. The pump owns execution for both a fresh idle turn (`chat.input` when idle) and a spawn's initial prompt, so input arriving during the spawn turn queues correctly too. At most one query is in flight per chat.
- Activity across a drain. A chat reports `running` continuously from its first turn starting until its queue is empty. A turn that settles with turns still queued behind it does not report `idle` — the pump starts the next one immediately, and a chat that blinks `idle` mid-queue is read everywhere as having finished: the Manager sweep (`06-threads-manager-speakers.md` § The sweep) can raise it as a candidate, and surfaces flash a done badge, while it is still working. The chat's status summary and its todo auto-advance (`02-host.md` § Task list) belong to the same settle, so they happen once the queue is empty rather than after every turn of the drain. An end the queue cannot resolve is unaffected: a credential refusal or a rate-limit park still settles the chat, and a turn pausing on a permission request still makes the chat waiting for the user. A stop is read by what is behind it: a stop with turns still queued IS resolved by the queue — a promote stops the in-flight turn precisely so the queued turn starts now — so the chat holds `running` and the interrupted drain still reports one settle at its true end, whereas a bare stop with an empty queue settles the chat immediately (there is no turn to hand `running` on to, and the composer must reopen). Either way `chat.stopped` is emitted, so the interrupted turn is still labelled. However the drain ends — including on a turn that fails outright and abandons the turns behind it — the chat lands on `idle`.
- Wire. When input is queued behind a running turn the host emits `chat.queued` { chatId, localId, message, queueSeq }, where `message` is the text as the user typed it (never the prompt the host builds around it — reminders, voice prefix, attachment paths); when a queued turn leaves the queue it emits `chat.dequeued` { chatId, localId, reason } — `reason: 'running'` (it is now executing) or `reason: 'cancelled'` (removed before running). Both are live-only (not in the record), like `chat.message_delta`; the server keeps the chat's current queue from those frames and re-sends `chat.queued` for each message still waiting to any surface that asks for the chat's history, so a surface that connects or opens the chat mid-queue sees what is waiting, in order.
- Delivery at a tool boundary. On a provider that declares `steer` (`02-host.md` § Provider adapters), a queued message does not wait for the whole turn to end; on one that does not, every queued message waits for the turn to end. After each batch of tool calls and before the agent's next step, the host hands it the leading run of waiting plain messages, in order, as one block labelled as arriving while it worked (a person's message and an automatic one are labelled differently). A message sent with send now (the up arrow) shows `interrupted` in its hover strip. Each is recorded in the transcript at that point as a user `chat.message` with `midTurn: true` and announced with `chat.dequeued{ reason: 'running', delivered: true }`, and it never runs as a turn of its own. A message that needs a turn of its own (a branch's first turn, a job, hook or goal resubmit) is not delivered this way, and nothing is delivered past one that is ahead of it. On Codex the host delivers the same block with `turn/steer` against the running turn once a tool call finishes; a refusal fails the turn visibly, since the message has already left the queue. The message shows the time it went in and `after step N` (N is the number of tool calls the turn had made), or `at the start`, in its meta strip (`14-design-web.md` § Messages).
- Stop keeps the queue. Stopping interrupts the in-flight turn and nothing else: the turns queued behind it are untouched and run in order as the queue drains. A queued message is removed only by `chat.unqueue_request`. Stopping a turn that is paused on a permission request ends that request too, as a deny — the turn is suspended on it, so leaving it outstanding would mean the stop did nothing at all and the queue waited out the request's expiry window. The agent is told that the turn was stopped rather than that the call was refused. Unlike a new message, which cancels only a question (`02-host.md` § Questions are not approvals), a stop is not selective: it ends the turn, so whatever the turn was paused on goes with it.
- Cancel. A surface removes a still-pending queued message with `chat.unqueue_request` { chatId, localId }; the host drops it from the queue and echoes `chat.dequeued{ reason: 'cancelled' }`. No-op if the turn already started (use `stop` for that) or is unknown.
- Edit. A surface replaces the text of a still-pending queued message with `chat.edit_queued_request` { chatId, localId, message }. The turn keeps its place in the queue, its attachments and everything the host folded around the typed text when it was accepted; only the typed text changes. The host echoes `chat.queued` again with the same `localId` and `queueSeq` and the new text, and every surface updates that entry in place. No-op if the turn already started or is unknown — an edit never runs as a new turn. An edit to empty text on a message with no attachments is a remove (`chat.unqueue_request`), not an edit.
- Promote (interrupt, don't wait). A surface promotes a still-pending queued message with `chat.promote_request` { chatId, localId }. The host interrupts the in-flight turn exactly as `chat.stop_request` does (`chat.stopped{ reason: 'user-stop' }`), so the queue starts draining now instead of waiting for the current turn to finish naturally — it is the "I meant this instead, stop what you're doing" control. Promoting never reorders the queue: turns already queued above the promoted one are already scheduled to run sooner and are pushed along with it, not shoved behind it; turns queued below it stay behind it, unchanged. Promoting `L3` from `[L2, L3, L4]` leaves the queue `[L2, L3, L4]` — only the in-flight turn is interrupted. Promotion does NOT emit `chat.queued` (it changes nothing about the queue's order); the eventual `chat.dequeued{ reason: 'running' }` events as the queue drains are the only wire signal. No-op if the `localId` is not a still-pending queued turn: interrupting an unrelated turn would be a destructive surprise. ORDERING IS PART OF THE CONTRACT: `chat.stopped` is emitted BEFORE the `chat.dequeued{ reason: 'running' }` of the turn that follows it. `chat.stopped` carries no `localId`, so surfaces attach it to the newest user turn that is no longer queued, reading the chat's status at that moment to tell a promote from a bare stop (`14-design-web.md` § Running-turn controls); emitted the other way round, the surface would stamp `Interrupted by a newer message.` on the message that has just STARTED running and leave the interrupted one unmarked. Emitted exactly once, whichever awaiter of the aborted run reaches it first.
- Surfaces render queued messages in a distinct pending style with a remove (×) affordance and an up-arrow (↑) promote affordance that fires `chat.promote_request`, always visible — it is the queued message's most useful control and must not depend on discovering hover. Sending never interrupts, with two deliberate exceptions, both explicit: the send button's right-click menu has "Send, interrupt immediately", and `⌘⇧↵` (`Ctrl⇧↵` off a Mac) is its keyboard form. Each sends the message and then promotes it (the same `chat.promote_request`, fired once the message has been handed to delivery, after any attachment upload). Otherwise the ↑ (and Stop, and Esc) are the only ways to cut a running turn short. `↵` and `⌘↵` just send, which mid-turn queues; the menu's "Send, wait until agent finished" sends `afterTurn: true` on `chat.input`, which makes the message a turn of its own (`ownTurn`, chip `· end of turn`) that is never handed over at a tool boundary. `⇧↵` alone is a newline; in an empty composer none of these do anything, and `↵` in an emptied composer never promotes the head (a second `↵` straight after a send once killed the turn the message was queued behind). Each queued entry carries a chip saying when it goes in rather than merely that it is waiting: the head of the queue reads `Queued`, and the rest read their place in the line — `2nd in queue`, `3rd in queue`. The chip also names the event that releases it — the head runs when the current turn finishes, the rest run once the turns queued ahead of them have run. It also says WHICH event that is: a plain message reads `· next tool call` (it is handed to the agent when its current tool call finishes, § Delivery at a tool boundary), and a turn that needs a run of its own — a fork, job, hook or goal resubmit, a side-branch message, or anything queued behind one — reads `· end of turn`. The host marks the second kind with `ownTurn: true` on `chat.queued`. Position is counted over the queued block as the surface currently renders it, so promoting or removing an entry renumbers the block immediately and the numbering never contradicts the order on screen. This state is not the offline delivery-pending state (`12-error-and-offline.md`), which waits on the host reconnecting rather than on a running turn; the two are worded differently wherever both can appear, since a reader who confuses them cannot tell whether the agent is working or unreachable. A queued message stays below the live transcript, clear of the running turn's ongoing output: the queued block is always the last thing in the stream — below every settled and streaming message, and below the thinking indicator — so its position reads as not yet sent. It takes its permanent place in the transcript only when it is dequeued and processed, so its position reflects when the agent became aware of it, not when it was sent. Sending while running enqueues the message; the composer stays open. Clicking a queued message's text opens it for editing in place, the same editor a settled turn's edit uses (§ Branching), and saving fires `chat.edit_queued_request`. If the message starts running before the edit is saved, the editor closes, the edit is not applied, an error says it had already been sent, and the edited text is put into the composer so it is not lost.
- Out of credit. While the chat is paused until a reset (`12-error-and-offline.md` § Chat status), nothing queued runs until the limit lifts, so each queued chip reads `Paused · out of credit · resumes <time>` (the time omitted when the limit stated none) instead of the position and release event.
- No auto-interrupt. A queued message waits for the turn ahead of it to finish, however long it runs; nothing promotes on a timer. Interrupting is always a deliberate ↑ or Stop.

## Turns a hook resubmits

An `agent_response` hook (`20-hooks.md` § On the agent's response) can make the host act on a chat on its own — resubmitting a turn after a `block`, or deferring its `advise`/failure onto the next one — with no composer and no job behind it. Both are shaped like every other daemon-originated turn here, not a special case of their own.

- **Block.** The host sends input the same way a self-wake or the todo auto-advance does: `origin: 'machine'` (no completion doorbell — `09-notifications.md` § Whose turn it was), nothing sets `fromUser` (a hidden chat stays hidden — § Chat model — exactly as a job's own fire into it does), and the turn's `message` IS the blocking hook's own `analysis`/`suggestion`, verbatim — there is no separate hidden prompt behind a different visible line. `hookTrigger` rides on the resulting `chat.message` (`03-wire-protocol.md` § Hooks) so a surface renders it as transcript furniture (`14-design-web.md` § Main chat panel) instead of a user bubble, the same signal `jobTrigger` is for a job's later fire. More than one hook blocking the same settled turn combines into one resubmit naming each, not one turn per hook.
- **Advise, and a hook that failed or timed out.** Neither creates a turn. The note — the hook's analysis, or its error when it failed/timed out — is held (in memory) and attached to whichever turn the chat runs NEXT — a person's reply, a job's fire, another hook's own resubmit, anything — the moment that turn is accepted, then cleared: consumed once, win or lose the race with whatever else was about to run. It goes as a note (§ Notes to the agent) labelled "Hook advice" or "Hook failed", its own entry beside the turn it went with, so that turn still reads as whatever it actually was. A batch mixing both kinds reads under the failure's label.
- **Loop guard.** `consecutiveHookBlocks` counts block-resubmits in a row with no genuine (non-hook) turn in between, reset to 0 the instant one lands. At a ceiling declared in code (not a setting — the point is a limit a hook cannot talk its way past) the host stops resubmitting and declares the chat's status instead (`report`, § Chat model), carrying the last blocking analysis: the SAME path `patch_report` uses, which persists, un-hides/un-archives, and puts the chat in the "needs attention" list. A hidden or job-owned chat is surfaced by this exactly as a hidden chat declaring its own status would be — nothing about being hook-driven makes it quieter or louder than the agent doing the same thing on purpose.
- None of this is gated to one provider: a chat on any provider resubmits and defers identically.

## Goals

A per-chat goal: a condition the user states once, which Patch itself then judges after every turn — modelled on Claude Code's own `/goal`, but VISIBLE the whole time it runs (Claude Code's is not), and provider-agnostic (a Claude chat and a Codex chat both get one, judged by the same model). One goal is active per chat; setting a new one replaces whatever was running, together with the plan around it (below).

- **Model.** `goal: string | null` — the condition text, persisted in `meta.json` so it survives a restart. While non-null, `goalProgress: { startedAt, turnsEvaluated, tokensSpent, lastVerdict: 'not_met' | null, lastReason: string | null }` tracks the run; in-memory only (a restart starts the counters at zero again — the goal itself is what has to survive, not the tally). The most recently FINISHED goal is kept on `lastGoal: { condition, startedAt, endedAt, turns, tokens, outcome: 'met' | 'impossible', reason } | null`, persisted, replaced only when the NEXT goal finishes — so the chat header can still say what it was working toward after it clears.
- **Setting it.** `/goal <condition>` in the composer sets the goal AND sends `condition` as the chat's own next turn — the condition becomes the directive, exactly as typing it yourself would. `/goal` with nothing after it (aliases `stop`/`off`/`cancel`) clears the goal and sends nothing. Wire: `chat.goal_request {chatId, goal: string | null, then?, remindEvery?, checkInEvery?}` → host `setGoal`, echoed on `chat.state`. `then`, `remindEvery` and `checkInEvery` are the plan (below); a request without them sets a plain goal and clears any plan the chat had. Setting it from a job's action (below) or a `patch_goal_set` tool call (`06-threads-manager-speakers.md` § Cross-chat toolset) persists the goal the same way but does NOT also send a turn — a job's own prompt, or the fact that a tool is being called mid-conversation at all, already supplies one.
- **Telling the agent.** Every set, replace or clear (from `/goal`, a job, or a tool call) queues a note (§ Notes to the agent) for the chat's next turn, like hiding does (§ Chat model): it states the goal (or that it was cleared) and that the host will send the agent back until it is met. A later change before that turn supersedes an unannounced earlier one. The note is labelled `Goal set` / `Goal cleared`, so for `/goal <condition>` the user sees it on the very turn the condition is sent.
- **Evaluating it.** After a turn settles on a chat with an active goal, the host asks a one-shot model to judge `condition` against the chat's own recent transcript: `not_met` (continue — the reply's `reason` is the guidance), `refused` (the agent has declined to do the work), `blocked` (it needs the user), `met` (satisfied), or `impossible` (cannot be satisfied by anyone). A goal is relentless: it is the user saying "keep going until this is done", so a turn that ends by asking whether to proceed, offering options or waiting for confirmation of something the goal already asks for is `not_met`, and the reason tells the agent to go ahead without asking again. Nothing about the shape of a turn ends a goal, including a turn that uses no tools. One model judges every chat, whichever provider the chat itself runs on, because the judge only reads a transcript; it is `goalModel` (default Sonnet 5.5), set in Settings → Goals. The condition can name its own stopping point in plain English ("...or stop after 20 turns") — there is no separate budget field; the evaluator reads it like anything else. NO FALLBACK: a failed/unparseable/timed-out evaluation changes nothing and is retried at the next settle.
  - **`not_met` and `refused`.** The host resubmits exactly the way a hook's `block` does (§ Turns a hook resubmits): `origin: 'machine'`, the evaluator's own `reason` AS the message (no hidden wrapper), tagged `goalTrigger: {reason}` on the resulting `chat.message` so a surface renders it as the same quiet transcript furniture a hook block is. This is an ordinary queued turn in every other respect — it goes through the SAME limit pause, transient-error retries and queueing any turn does, so a goal paused mid-run by a usage limit follows the user's limit behaviour (`10-auth.md` § Limits) exactly as any other paused turn would, with the goal still set the whole time it waited.
  - **`met` / `impossible`.** The goal clears (`goal: null`, `goalProgress: null`), `lastGoal` records the outcome, and a quiet system-role `chat.message` marks the transcript (`[goal: met]`/`[goal: impossible]` + the reason — no new agent turn). `met` needs nothing further: the turn was never resubmitted, so the ordinary turn-complete path already rings the usual done notification. `impossible` additionally declares a `report` status (§ Chat model) — the same "needs attention" claim a hook's loop guard or the agent's own `patch_report` makes — so an impossible goal surfaces the chat rather than clearing silently.
- **Settings.** Settings → Goals (`14-design-web.md` § Goals) holds the judge model (one for every chat, any provider), the refusal ceiling below and the judge prompt, as shared settings (`goalModel`, `goalRefusalLimit`, `goalEvalPrompt`) every host applies. The prompt is the judge's instructions; the host adds the goal, the conversation and the reply format.
- **Stringency.** `goalStringency` (shared setting, 1–3, default 2, Settings → Goals) sets how far the judge trusts the agent. 1: the judge is given the agent's latest message and the user's scope, not the transcript, and takes the agent at its word. 2: the recent chat, as above. 3: nothing is taken on trust; the judge also gets read-only file tools (Read, Grep, Glob) in the chat's folder and a longer time limit, checks every file and resource the work touched, and judges `met` only for what it verified.
- **Paused by a stop.** A user stop with nothing queued behind it ends the turn without judging it, so the goal stays set but nothing resubmits it. `goalProgress.pausedByStop` is `true` from that stop until the next turn starts (any message, or a resumed turn), and the goal bar shows it as paused (`Paused: you stopped the chat`) in place of the evaluator's reason. A stop that promotes a queued message does not pause it.
- **`blocked`.** The agent cannot go on without something only the user can give or do (a decision, a credential, access, a physical action). The goal stays set but is held: nothing is resubmitted, `goalProgress.waitingOnUser` is `true`, and the host declares a `question` status naming what is needed, so the chat is surfaced. The goal bar reads `Needs you`. The hold lifts when the user's next turn starts, and the goal is judged again after it settles, so the goal carries on once the user has supplied the thing.
- **Deadlock guard.** `goalRefusalStreak` counts consecutive `refused` verdicts, reset by any other verdict or a new goal. At the ceiling (`goalRefusalLimit`, default 3) the host stops resubmitting and declares a `report` status, surfacing the chat with the evaluator's reason, EXCEPT the goal itself is left set rather than cleared: the agent will not do it, the condition was not judged impossible. This and `met`/`impossible` are the only ways a goal ends.
- **Deferred during background work.** Evaluation is skipped while the chat has running `patch_watch` tasks — judging a transcript whose last word is "I've started a background job" tells you nothing yet. A poll re-checks until the watch finishes, then evaluates normally. A chat's own turns never block on this — only the goal check does. The judge is also handed the host's own record of the chat's background tasks (running or finished, with exit code) and told an agent's "waiting on a monitor/background task" is only valid when one is actually running; with none running it judges `not_met` and the reason sends the agent to read the finished task's output.
- **The plan around a goal.** A goal can carry three optional things, all replaced together by the next `setGoal` and all cleared with the goal. Each is mirrored on `chat.state` (`goalQueue`, `goalReminderEvery`, `goalCheckInEvery`) and persisted in `meta.json`.
  - **Sequence.** `then: string[]` (at most 50) are goals that follow, in order. When the active goal is judged `met` the host arms the first of them with the same cadences and sends its text as the chat's next turn (`origin: 'machine'`, tagged `goalTrigger`, so it reads as quiet transcript furniture, not a person's message). The rest stay queued. `impossible` stops the sequence: the queue is dropped and the report says how many goals were not started. A deadlock (`refused`) leaves goal and queue as they are.
  - **Reminders.** `remindEvery: {unit: 'turns' | 'minutes', n}` restates the active goal to the agent as a note (§ Notes to the agent) on the turn that crosses the cadence, counted and timed as a chat reminder's cadence is (§ Reminders: checked as a turn starts). The turn that carries the goal-set notice does not count.
  - **Check-in.** `checkInEvery` (same shape) makes the evaluation that crosses the cadence also ask the judge whether the work is on track. The reply adds `onTrack: 'on_track' | 'off_track'` and `onTrackReason`; an evaluation without them on a check-in is a failed one (NO FALLBACK). A goal set with no `checkInEvery` gets one of every 120 minutes; `null` opts out. A time check-in that has come due is judged even while a watch or delegate is running, so a watcher that never ends cannot stop the goal being checked. The latest read is `goalProgress.lastCheckIn {at, status, reason}`. `off_track` declares a `report` status to surface the chat; it does not end or pause the goal. Time cadences are only checked at a turn boundary, which is enough because a goal keeps the chat turning until it ends. The time of the last reminder and last check-in is persisted in `meta.json` (`goalReminderLastAt`, `goalCheckInLastAt`; absent on older files, which count from the chat's last update), so a host restart does not restart the clock. Turn counters are in-memory and restart from zero.
- **Visibility is the point** (`14-design-web.md` § Goal row, `15-design-mobile.md`): a bar above the chat while a goal is active (condition, running time, turns evaluated, tokens spent, the evaluator's latest reason, Edit/Clear); a sidebar marker on a chat working toward one; each `not_met` verdict a collapsed transcript row naming the reason (the `goalTrigger` turn itself); a `met`/`impossible` outcome its own quiet row; the chat header keeps `lastGoal` reachable after it finishes. The bar also says how many goals follow, and opened shows the sequence, the two cadences and the latest check-in.
- **Jobs** (`08-triggers-and-jobs.md` § Action): a `spawn`/`continue` action's optional `goal` sets the new chat's goal at creation, forwarded on `chat.spawn_request`. Creation-time only, like `startHidden`/`permissionMode` — a later fire into an existing chat never touches its goal.
- **Tools** (`06-threads-manager-speakers.md` § Cross-chat toolset): `patch_goal_set(condition, then?, remindEvery?, checkInEvery?)`, `patch_goal_get()`, `patch_goal_clear(outcome, reason)` — set/read THIS chat's goal from inside a running turn; an agent can only clear it by claiming met/impossible, which the judge validates (only the user's `/goal` clears without judging).

## Reminders

A chat carries one reminder: free text set from any surface's composer with `/remind <text>` (a bare `/remind` clears it), shown as a banner above the transcript, and persisted in `meta.json` with the rest of the chat's settings. On its own it is only a banner; the agent is never told.

`/remind every <n> <unit> <text>` makes it periodic, where `<unit>` is `turns`, or `m`/`min`/`minutes`, or `h`/`hours` (hours are stored as minutes). The host then sends the text to the agent again as a note labelled `Reminder` (§ Notes to the agent), so a standing principle does not scroll out of its attention: every `n`th agent turn for `turns`, or on the first turn that starts at least `n` minutes after the last time it was sent (or after the reminder was set) for `minutes`. A turn here is any turn the host runs for the agent, whoever sent it (a person, a job tick, a wake). The counters are in memory: setting or changing the reminder restarts them, and so does a host restart, but the text and cadence persist.

Wire: `chat.reminder_request { chatId, reminder, every? }` with `every: { unit: 'turns' | 'minutes', n }` (n an integer from 1 to 10000), echoed on `chat.state` as `reminder` and `reminderEvery` (`null` for a plain or cleared reminder; a cleared reminder always drops its cadence). A cadence with no text is refused on the surface with an error, not guessed at. The banner shows the cadence ("every 10 turns") beside the text.

## Branching (edit / fork a message)

Editing and side threads are offered only for a provider whose adapter declares native edit at a message and branch at a turn (`02-host.md`); for any other provider the affordances are absent, and a request for one is refused (`unsupported`), never emulated. Where they are offered, a chat is not a line, it is a graph. Any user turn can be edited, which does not rewrite history — it forks a new track from that point. The turns before the fork are shared; from the fork point on, each track has its own future. The user switches between tracks at the fork point, so an alternative phrasing is explored without losing the original.

- Branch (track): `{ branchId (ULID), parentBranchId, forkFromSeq, sessionId, label, createdAt }`. `sessionId` is the provider session backing that track.
- Root branch: every chat has exactly one, created the moment the chat's first provider session id is known (`parentBranchId: null`, `forkFromSeq: null`, label `main`).
- `activeBranchId`: which track the chat IS right now. The chat's `sessionId` is always the active branch's.
- Persistence: `branches` + `activeBranchId` live in `meta.json`, so the graph survives a host restart exactly like the chat does.

### Forking

`chat.fork_request {chatId, seq, message, localId}` — `seq` is the seq of the user message being edited, `message` its replacement text.

1. The host resolves the fork point from the record: the `nativeRef` of the last entry strictly before `seq` that carries one (§ History). Everything up to and including that entry is the shared prefix; the edited turn replaces what came after. A user turn the provider never answered carries no `nativeRef` and is passed over. With no provider output before `seq` at all, the new track starts from an empty context. A provider that forks only at whole turns (Codex) keeps the whole turn holding that entry, which it finds through its own interface.
2. It creates a new branch (`parentBranchId` = the currently active branch, `forkFromSeq` = `seq`) and makes it active.
3. It runs `message` as that branch's first turn, with the adapter forking the parent session at that `nativeRef` through the provider's own interface, so the new track starts with the shared prefix as its context and gets its own session id. The parent session is left as it was, so the original track stays intact and re-openable.
4. It emits `chat.branches` (the whole graph + the new active branch), then the turn streams normally.

Forking a `seq` that is not a user message in the chat's record is an error (`fork_point_not_found`), as is one whose earlier entries were recorded before Patch kept provider ids. Forking from the end instead would silently run the edit as an ordinary new message.

### Side threads (side message)

An edit replaces a turn; a side message asks something off to the side of a turn without disturbing what came after it. It extends the graph sideways: the shared prefix runs up to and including the message the side thread hangs off, and the side message runs as the first turn of its own track. The main track keeps its own continuation, untouched.

`chat.side_request {chatId, seq, message, localId, branchId?}` — `seq` is the seq of the message the side thread hangs off (user or assistant — asking a side question about an answer is the common case), `message` the new question. `branchId` names which branch `seq` belongs to; absent means the chat's active branch — the ordinary trigger, off the main chat.

1. The host resolves the FROM branch (`branchId`, or the active branch if absent) and refuses with `branch_not_found` if it names nothing real.
2. It resolves the side point on THAT branch's own track: the `nativeRef` of the entry at `seq` itself. That entry and everything before it is the shared prefix.
3. It creates a new branch (`parentBranchId` = the FROM branch, `forkFromSeq` = `seq`, label `side N`). Unlike an edit fork (`chat.fork_request`, above), it does **not** become active — `activeBranchId` is untouched, because a side branch runs _alongside_ whatever is active, not in place of it (§ Parallel branches, below).
4. It runs `message` as that branch's first turn with the adapter forking the FROM branch's session at the side point, exactly as a fork does, so the side thread carries the full context up to that message and gets its own session id. The FROM session is left as it was.
5. It emits `chat.branches`, then the turn runs on the branch's own independent pump (§ Parallel branches).

A `seq` with no entry on the FROM branch, or whose entry carries no `nativeRef`, is an error (`fork_point_not_found`). Hanging the side thread off the end instead would silently make it an ordinary message on the main track.

**A user's own message as a fork point.** Where the provider keeps an id the caller gives a message (Claude Code: `branching.userTurnIds`), the host sends each user turn under an id it chooses, gives a new session (fresh or forked) an id it chooses, and records the pair as that message's `nativeRef`, so a side thread keeps the user's message itself. A provider that forks only at whole turns (Codex: `branching.wholeTurns`) hangs a side thread off a user message the way an edit forks: through the turns before it. A fork resumes the session the kept entry's `nativeRef` names, which for an entry a branch inherited is its parent's: a provider may give a forked session's messages new ids.

**Where surfaces offer it.** Edit and side thread are offered on an entry only where the fork would succeed: the provider declares the capability and the entry (for an edit, an earlier entry, or none before it at all) carries a `nativeRef`. Surfaces never see the id; the server marks such an entry `branchable` (`03-wire-protocol.md` § Event categories). Web, mobile and the host share one rule (`forkPointIndex` in `@patch/wire`), so an entry recorded before Patch kept provider ids shows no action rather than failing after the click.

**Branching off a side thread.** Naming an existing side branch as `branchId` hangs a NEW side thread off a message that lives only on THAT branch's own track — the Side threads panel's "branching again from inside the panel" (`14-design-web.md`, `15-design-mobile.md`). Every entry on a side branch carries its own `nativeRef` like any other, so its messages are fork points exactly as the main track's are.

The side branch is an ordinary branch: it appears in the graph, the switcher at its `forkFromSeq` message returns to the main track, and it survives restarts like any other.

**Naming.** A side branch gets a name the same way a chat does (§ Chat model): as soon as its first message is accepted, a cheap one-shot model query summarises it into a short Title-Case label, stored on that branch (not the chat) and never overwritten once set unless the user renames it first. `null`/unnamed until it lands. Renameable from any surface: `chat.branch_rename_request {chatId, branchId, name}` — `name` may not be empty (a branch has no folder-derived fallback to clear back to, unlike a chat's own rename). An unknown branch is a `branch_not_found` error.

### Parallel branches

Several branches of one chat can be mid-turn at once, each in its own session — a side branch never shares the active branch's turn-execution state, so creating one and sending it messages never waits on, or blocks, whatever the active branch is doing.

- **Addressing.** `chat.input`, `chat.stop_request` and history requests each take an optional `branchId`. Absent means the chat's active branch — every existing caller, unchanged. A `chat.input` naming a branch OTHER than the active one runs (or queues behind) a turn on that branch's own independent pump; the active branch's own single-turn-per-chat pump is unaffected and keeps its full feature set (compaction, transient-error retries, limit pauses).
- **A side branch's own pump.** It resolves its account and runs turns through the adapter exactly as the active branch does, with its own queue (a second message to a busy side branch queues behind the first, draining FIFO), its own stop (`chat.stop_request {chatId, branchId}`), its own permission requests/questions (below), compaction and transient-error retries.
- **Content stays on its own track.** A side branch's messages and tool calls are persisted to its own track (readable through a history request naming its `branchId`, or `patch_history`) but are **not** broadcast live to every surface holding the chat — no surface broadcasts a second, simultaneous track, so doing so would interleave two conversations into the one view a surface draws for this chat. The Side threads panel (`14-design-web.md`, `15-design-mobile.md`) is what gives it somewhere to go, and it is PULL-based to match: it asks the server for the open tab's branch while that branch is `running`, rather than the host pushing content for a branch nothing is broadcasting live.
- **Permissions and questions address a branch.** `chat.permission_request` carries an optional `branchId` (absent ⇒ the active branch). A question or tool-approval raised by a side branch's own turn is tagged with it, so a surface routes the card to the right track (the Side threads panel's own card on that tab) rather than the chat's main transcript, which draws only the active branch. Resolving it (`chat.permission_response`) is unchanged — it already addresses the request by `requestId` alone.
- **`activeBranchId` stays the chat's "main" track** for everything that expects exactly one: the sidebar preview, resume-on-restart, `patch_send_to`, jobs' `continue` action, and an edit fork (`chat.fork_request`) switches it.
- **Stopping.** `chat.stop_request {chatId}` with no `branchId` means "stop the chat" and ends EVERY branch's turn, not just the active one's. Archiving (§ Chat model) stops all of it the same way: nothing a chat has in motion, on any branch, survives either.
- **Status aggregates.** The chat's one status (decided by the server, `12-error-and-offline.md`) is the active branch's own, RAISED by any other branch currently running or waiting for the user: `running` if any branch is working, `waiting_for_user` if any branch is blocked on a question (this outranks mere `running` — a blocked branch is more actionable than a busy one), falling back to the active branch's own status when nothing else is happening. A side branch failing silently does not, on its own, escalate anything the sidebar shows. A side branch's OWN `running` flag — carried on its `chat.branches` entry, set the instant its pump picks up a turn and cleared the instant it settles — is the one PER-BRANCH signal beyond this aggregate and beyond permission requests; it drives the Side threads panel's tab status dot without needing to poll.

### Send back

A side branch can post its conclusion back into its parent branch's track two ways: the tool `patch_send_back` (no arguments; callable only from a turn running on a side branch, via `PATCH_BRANCH_ID`), or the surface-triggered `chat.send_back_request {chatId, branchId}` — the Side threads panel's "Send back to chat" button (`14-design-web.md`, `15-design-mobile.md`), which does the identical thing without needing a turn to be running on the branch at all. Both land on the same underlying step below. Refused (naming why — `send_back_failed` on the wire path) when the branch has no parent (the root), or when it has already sent back once (one-way, like the edit fork's session capture); the tool form is additionally refused when the calling turn is not on a side branch.

1. The host generates a short summary of the branch's own conclusion — a cheap one-shot model query reading what the branch was asked and what it last said, the same mechanism a collapsed tool run's label uses (`chat.tool_run_summary`).
2. It posts a quiet row into the PARENT branch's track right now: an ordinary `chat.message` (`role: 'system'`, `branchSendBack: {fromBranchId, fromBranchName}`), reading `From <branch name>: <summary>`. Live-emitted when the parent is the active branch (the one view a surface draws for this chat); otherwise it lands on the parent's own track, same as any other side-branch content.
3. The SAME summary goes to the parent's agent as a note (§ Notes to the agent) on the parent's NEXT turn, so the agent reads it as part of that turn rather than having to notice the row.
4. The branch is marked `sentBack: true` (carried on `chat.branches`) and the summariser's own failure (no account with credit, provider error, timeout) is recorded as the row's text rather than silently saying nothing — NO FALLBACK to pretending it worked.

### Switching tracks

`chat.branch_switch_request {chatId, branchId}` — the host points `activeBranchId` (and therefore the chat's `sessionId`) at that branch, persists, and emits `chat.branches` + `chat.state`. The surface then reads the newly-active track's history from the server and re-renders it. Switching to an unknown branch, or to one whose first turn has not yet produced a session id, is refused (`branch_not_found`) rather than silently landing somewhere else. Switching is refused while a turn is `running` — the in-flight turn belongs to the current track; stop it first.

The host publishes the graph on `chat.branches` {chatId, activeBranchId, branches[]}: on fork, on switch, and with a history response so a reconnecting surface learns the graph without a separate request.

### Surfaces

A user turn reveals an edit (pencil) affordance on hover/focus. Editing carries the turn's text back into the chat's MAIN composer (web; a queued message is still edited inline, and the phone has no turn editing), with every control it has — attachments, model, approval mode, `/` skill menu, dictation, quotes. The edited turn is outlined and everything below it greyed and inert, to show the edit runs from that point; the composer's unsent draft is set aside and put back on save or cancel (Cancel button or Esc). Send is Save: it uploads any attachments, then `chat.fork_request` (carrying `attachments` and `disabledTools` like `chat.input`) fires and the transcript re-loads on the new track. Where a message is a fork point with more than one track, a track switcher (`‹ 2/3 ›`) renders on that message; the arrows fire `chat.branch_switch_request`. The switcher sits on the turn the user sees at that fork point: on the original track that is the original turn, on a forked track it is the edit's replacement, which the host logs under a fresh seq (the turn it replaced is not on that track), so ‹ on the edited turn returns to the original. The switcher appears once a chat has been forked; a single-track chat looks exactly as it did.

A side-thread affordance (`14-design-web.md` § Side threads panel, `15-design-mobile.md` § Side threads screen) sits beside the edit pencil: hovering (desktop/web) or long-pressing (mobile) ANY settled message, user or assistant, offers "Open side thread", as does the message's own right-click/context menu. A message with one or more side threads forked from it carries a marker — "Side thread · N messages · running" — clicking/tapping it opens the panel/screen on that tab.

## Document edits

`14-design-web.md` § Document editor. A `.md` file a surface saves (`file.write`, whichever editor made it — the document editor or the plain one) is tracked per chat against what was on disk before; the chat's NEXT turn carries a diff as a note labelled "Document edited" (§ Notes to the agent). Several saves to the same file before that next turn diff start-to-latest as one change, not each keystroke; a file saved back to exactly what it was reports nothing. Cleared the instant it is delivered — a later turn with no further edit carries none.

A comment the user leaves on a document (or a reply inside an existing thread — `14-design-web.md` § Document editor's comments both ways) reaches the chat's agent the same way: queued the instant it is made, delivered as its own note labelled "New comment" naming the file, the thread and the text, the moment the chat's next turn is accepted, then cleared. Independent of the diff note above — a turn can carry one, the other, both, or neither.

## Pinning

Any regular chat can be pinned. Pinning lifts the chat out of its folder section and surfaces it at the top of the sidebar, immediately below `Manager`, so the user reaches it without scrolling.

- Storage: pinned state is per-chat metadata on the host (`pinned: true`). Survives host restart.
- UI: pinned chats appear in a Pinned group above the folder list. They keep the same status badge / mic shortcut / kebab menu as any other chat.
- Toggle: kebab menu → `Pin chat` / `Unpin chat`. No dedicated drag-to-pin gesture.
- Order: most-recently-pinned at top.
- Use case: a long-running chat the user opens often. The canonical example is a Home Assistant control chat (see `06-threads-manager-speakers.md` § Smart-home control from a desk) — one chat, pinned forever, used continuously for `lights off` / `kitchen scene`.
- Special threads (`Manager`, `Speakers`) are not "pinned" — they sit in fixed slots (Manager top, Speakers in the Channels section near the bottom) and the pin toggle is hidden for them.

## Snooze

Snooze means "I'm leaving this to carry on; don't make me think about it until it comes back." A snoozed chat keeps working — goals, loops, self-wakes and new turns all continue, possibly for many hours — and says nothing until it returns, when it says what happened.

- Model: per-chat `snoozedUntil: number | null` (ms epoch), persisted in `meta.json` so a snooze survives a host restart. Orthogonal to `status` — snoozing does not archive or delete, and an archived/deleted chat is unaffected by its `snoozedUntil`.
- Snoozed ⇔ `snoozedUntil !== null && snoozedUntil > now`. Every surface derives "is snoozed" from that comparison, so a surface that was offline when the snooze lapsed still shows the chat correctly the instant it renders.
- The sheet: choosing Snooze — the chat header ⋯ and hamburger menus' Snooze row, or the folder header's clock for a whole project — opens one modal sheet (a bottom sheet on the phone). It names what is being snoozed (the chat's name; for a project, "Snooze <project>" and "<N> chats"), offers the presets in a two-column grid with each preset's resolved wake time beside it, shows a "Run in background" box, states the rule "Snoozed chats keep running and reappear when scheduled", and ends in Cancel and one primary button. Choosing a preset only selects it; the button reads "Snooze" and is disabled until one is chosen, then "Snooze until <wake>" ("Snooze <N> until <wake>" for a project). Enter confirms; Esc and the scrim cancel. Unsnoozing an already-snoozed chat is a direct action with no sheet.
- Presets: 2 minutes, 5 minutes, 30 minutes, 1 hour, an evening time (default 5pm; today, or tomorrow once it has passed), Tomorrow at the morning time (default 9am), 1 day, Next Monday (the coming Monday at the morning time; a Monday today means a week out), plus a duration slider and Custom… — the slider steps through 1, 2, 3, 4, 6, 8, 12 hours, 1, 2, 3 days and 1 week , each resolving to now plus that span at confirm time; Custom is a free-form date/time (web: a date/time field shown inline; phone: typed `YYYY-MM-DD HH:mm`). A past or invalid custom time raises a visible error and snoozes nothing (NO FALLBACK). A wake time is shown `HH:MM` if it is today, `Fri 08:00` within the next 6 days, and `Thu 22 Oct` beyond. The morning (default 9) and evening (default 17) hours are shared account settings (Settings → Chats → Snooze defaults, `snoozeMorningHour` / `snoozeEveningHour`, whole local hours 0–23), and the sheet carries a cog at its top right that opens that page. Every preset is resolved on the surface, at confirm time, into an absolute `snoozedUntil`; the host only ever stores the absolute timestamp (a delta would drift while an event is in flight).
- Run in background: the box appears only if some chat in the set is `running`. It lists each running chat — its working badge, its name ("This chat" in a single-chat sheet), its current status line if it has one, and how long its current run has gone (`25m`, `2h 10m`, from `chat.state.runningSince`) — and, for a project, a last line "+ <N> not running". Without a running chat the box is absent.
- Until complete: a further preset, always shown but greyed out and disabled (tooltip on web, accessibility hint on the phone: it needs running work to wait for) unless every chat the sheet is for has work to wait for (a turn running, a goal still open, or a one-shot self-wake armed). A whole-project snooze is the exception: it is enabled when at least one chat in the project has such work, and waits for the whole project — idle chats are snoozed with it (the request carries `waitForSet` and the one set id), and the host returns the entire set together once no chat of it has work left (a chat that stops for a person still returns on its own). The host refuses it when no chat of the set has work. It is sent as `snoozedUntil = 8640000000000000` (the largest Date) so "snoozed ⇔ `snoozedUntil > now`" holds unchanged, and shows as "when done" where a wake time would be ("Snooze until complete" on the button). The host ends it, as a normal wake with a record and Back state, the moment the chat has no turn running, no goal, no one-shot self-wake and no `patch_agent` agent it started still running; or sooner if it stops for a person (a permission, a question, an error). Background tasks and recurring loops are not waited on; the chat's agents are, so the snooze outlasts the parent's own idle gaps until the last agent has returned; a one-shot self-wake is, so the snooze carries through the wake's turn. The host refuses it (400-equivalent error, no snooze) for a chat with nothing running, no goal, no one-shot wake and no running agent, and a host restart does not end it by itself: if the restart resumes the interrupted turn (or leaves it parked on credit), or a one-shot wake is still armed, the snooze carries on and ends when that turn returns, otherwise there is nothing left to wait for and it ends at startup.
- Unsnooze: setting `snoozedUntil = null` at any time (the Snoozed section's row control, the snoozed banner, or the chat header's snooze control while snoozed) returns the chat to the active list immediately.
- Snoozing the chat you are currently reading moves you on, exactly as archiving does (§ Chat model): the surface opens the next chat in the sidebar's drawn order, or the new-chat screen when nothing active is left. This holds from the chat header, the sidebar row, and a project-wide snooze that includes it. Unsnoozing never navigates.
- After confirming, a toast (the usual toast duration) reads "<chat or project name> snoozed until <wake>", with a second line "<N> chats running in background" for a project ("1 chat…" for one), or "Running in background" for a single running chat, and nothing when nothing is running. It carries Undo, which restores each chat's previous `snoozedUntil`.
- Waking: the host arms a timer for the snooze and, when it fires, clears `snoozedUntil` to `null`, persists, and emits `chat.state` — so an open surface pops the chat back into the active list without a reload. Timers are re-armed from `meta.json` on host start; a `snoozedUntil` already in the past clears on load. Waking does not touch `lastUpdated`, unread state or activity — the chat comes back exactly as it left. See § Back below for what it says on return.
- Snoozed means silent: while `snoozedUntil > now` a chat produces no notification of any kind on any channel — push, desktop, the in-app toast and the bell — for chat completion, waiting on permission, `AskUserQuestion`, `patch_ask_human`, `patch_report`, `patch_notify` at every level, `patch_call` (which resolves as unanswered, without ringing) and errors (`09-notifications.md` § Snoozed chats). Nothing is replayed as a push when it returns; § Back replaces it. A permission prompt or question in a snoozed chat does not end the snooze — it waits (Hidden, by contrast, exits on these). The chat otherwise runs exactly as before: no caps, limits, holds or pauses, and `patch_send_to` still delivers. The one exception: an agent's `patch_send_to` into a snoozed chat ends the snooze (as it does a hide or an archive), so the chat returns to the active list — unless the chat has a goal, which keeps it snoozed until the goal is done. `manager-sweep` skips snoozed chats. Reaching the chat by URL/deep-link still opens it normally, with a banner naming the wake time.
- Resnooze after an answer: when a snooze ended because the chat stopped for the person (the record's outcome is `waiting`) and the chat is not snoozed again, its question card offers three ways out: Send answer and snooze, Send answer, Cancel. Send answer and snooze sends the answer, then snoozes the chat for the length the old snooze had, counted from now (an until-complete snooze is until-complete again), with the usual toast and Undo; a refusal by the host reverts and toasts (NO FALLBACK). Send answer and Cancel behave as everywhere else.
- Requests: surface → host `chat.snooze_request {chatId, snoozedUntil, setId?}` (via REST `POST /api/chats/:id/snooze` with body `{snoozedUntil: number | null, setId?}`); host → surfaces the resulting `chat.state` carrying `snoozedUntil` and `snoozeRecords`. A `snoozedUntil` in the past is rejected (400), so the caller sees the bad value rather than a silent "now".
- Special threads (`Manager`, `Speakers`) cannot be snoozed; the control is hidden for them and the host rejects the request.
- Whole-project snooze: the folder header's clock opens the sheet for every chat the "archive all in project" button would move — the folder's whole chat set (§ Folders), including pinned and already-snoozed ones, excluding special threads and anything already archived or deleted. There is no "as listed" variant. Each chat is its own `chat.snooze_request`, all carrying one `setId`, applied and reverted independently — a request that 400s for one chat leaves the rest snoozed and toasts the failure (NO FALLBACK), same as a per-project archive failure.
- While snoozed, in the sidebar: each project keeps its place, and after its active rows its snoozed chats are one dashed line — "<N> snoozed" and "back <wake>" (the earliest wake among them) — with no dots, status or progress. A project with only snoozed chats keeps its header with just that line. Tapping the line opens the Snoozed section; the Snoozed toggle carries the count of snoozed chats.

### Back

When a snooze ends — it lapses, or an agent's `patch_send_to` ends it — the chats return to their project as before, and the host records what happened.

- Records: per chat, `snoozeRecords` (in `meta.json` and on `chat.state`, oldest first, the last 20): `{setId, startedAt, startSeq, until, endedAt, outcome, backCleared}`. `startSeq` is the log position the snooze began at. A "set" is the chats snoozed by one action — a project snooze is one set, a single-chat snooze a set of one — and shares a `setId` (the host makes one when the request carries none). While snoozed the host tracks the last turn that finished, the last error, and when the chat began waiting on a person; when the snooze ends it fixes `outcome`: `waiting` (blocked on a permission or question; with the time since), else `failed` (with the time), else `running` (still going at wake), else `finished` (with the time of the last finished turn), else `none`. A person's own unsnooze closes the record already cleared: there is nothing to say.
- A returned row (a chat whose last record has ended and is not cleared) takes a subtle accent inset on its left and, beneath its name, one line: "finished 03:52", "waiting on you since 21:14", "error at 23:05", "still running"; `none` has no line. The badge is unchanged. The project header shows one pill, "back · snoozed <duration>" (`45m`, `12h`, `3d`), for the most recent set that is back there; it has no close control.
- Clearing: the first interaction with any chat of the set — opening it (`chat.snooze_back_clear_request`, REST `POST /api/chats/:id/snooze/back-clear`), sending to it, archiving it, or snoozing it again — sets `backCleared` for the whole set on the host and broadcasts `chat.state` for each chat, so every surface drops the pill, the insets and the lines together. An agent's or a job's message does not clear it.
- Divider: the transcript carries a permanent centred divider where each snooze began — "Snoozed 19:42 – 08:00", then " · finished 03:52" (or the other outcome's text) once there is one, a weekday before any time not on the wake day. It stays after the Back state clears.

## Section counts

The lifecycle sections a surface can list — archived, snoozed, deleted and
automations — are also served as bare totals, one small response carrying a
number for each, with no chat rows in it. A surface loads it on cold start
alongside the chat list and refreshes it whenever a chat changes lifecycle
state, so a section's size is known before its list has ever been fetched.

Each total is defined as the size of the list that section's own query returns
— the same filter, not a separately-stated rule — so the number is always
exactly what expanding the section fetches. Carrying no rows, the response
stays small however many archived chats accumulate, which is what lets it be
fetched eagerly when the lists themselves cannot be.

## Search

One search covers every chat on every host except deleted ones — active, pinned, snoozed, archived, the special threads and job-created chats alike. A chat matches when every term of the query appears, case-insensitively, in its name, or in a single user or assistant message of its record, or — where the record holds no matching message — in its stored first-message preview. A query that could be a chat id also finds the chat whose id contains it. Tool calls and their output are not searched: they are most of a transcript's bytes, and file dumps and command output would put nearly every chat in every result. A term is a whitespace-separated word; a run in double quotes is one term matched as an exact phrase (internal whitespace of the text, line breaks included, counts as a single space; an unterminated quote runs to the end of the query). A search can be limited to titles: with full text off only chat names are searched — no message, no preview — and no transcript is read. Full text is on by default. A query is at least two characters after trimming.

Each chat is one hit. Hits are ordered by date: the most recently active chat first, whether its name or only its messages matched. A hit carries where the chat lives (its host, and the section it is listed under), how many of its messages matched, and a snippet: a window of the most recent matching message with every term occurrence marked, plus that message's `seq` and the time it was written (`createdAt`, from the entry itself). A preview match has neither. Opening a hit opens the chat scrolled to that message.

The server answers from its own records (`01-server.md`), so every chat is searched whether or not its host is online, and no host is asked. Results are paged, deepest page 200 hits. The wire shapes are in `03-wire-protocol.md` § Chat search.

## Folders (host-owned registry)

Projects are just folders with ≥1 chat, so to start the first chat in a
project the user picks a host and a folder on it, in the common case without
typing or guessing an absolute path.

Where a chat runs is chosen first, then the folder on that host. With more
than one host registered the new-chat screen offers the hosts by name, and the
folder picker lists only the chosen host's registered roots and recent folders,
so picking `~/projects/patch` on hetzner and `~/code/patch` on Tom's MacBook is
the same gesture made after choosing the host.

- Each host publishes its own folder registry and recent list, and a host's
  folders are only ever offered while that host is chosen, so two hosts sharing
  a path string stay two directories.
- An offline host is listed, marked offline, and cannot be chosen.
- Changing the host keeps the chosen folder only if the new host has a folder at
  that path; otherwise the folder clears.
- The picker defaults to the last used (host, folder) pair, and a draft keeps
  the host it was typed against.
- A host added later appears in the picker as soon as it registers.

Folders are defined on the host — each host owns its host's filesystem
and is the only party that knows which folders actually exist. Each host holds
its own registry (a small set of user-designated project roots, seeded from recent
chats and edited through `patch hosts folders` (`17-cli.md` § Commands) or that
host's Settings → Project folders, both writing through to that host). Installing a host creates no folder: Patch never invents a starting folder. A first chat with no folder chosen prompts for one (the new-chat folder picker, which can also make a new folder when the person asks). On a host with no projects yet the picker also suggests the host user's home folder as a labelled "Home folder" one-tap choice; it is only suggested, never preselected, and nothing is created. A host
publishes its folder list to the server, which relays it to every connected
surface over the wire (a `folders.list` snapshot on connect and a
`folders.updated` push on change, both carrying the `hostId`), so one
consistent picker on every surface is populated from the same lists and a folder
that exists on a host is one tap away everywhere.

An edit travels the other way as `host.folder_add` or `host.folder_remove`,
carrying the `hostId` of the host being edited and the path
(`03-wire-protocol.md` § Host events). The host validates the path against its
own filesystem, writes its registry, and answers with `folders.updated`, so the
list every surface shows is the one the host actually holds. A path that does
not exist on that host is refused naming it, and an add aimed at an offline host
is refused up front by the surface rather than buffered.

Within each host's group the picker offers, in order: that host's registered
folders first, then folders seen in recent chats on it, then a clearly-secondary
free-text field for a genuine ad-hoc path on that host. Each host stays the
source of truth for its own paths: the published list is not a substitute for
the spawn-time `folder exists` check on the chosen host — an ad-hoc or stale path
still fails loudly with `folder_not_found` on send.

Recent-folder selection rule (real project folders only). The recent list
is seeded from folders seen in recent chats, so it can pick up paths that are
not project roots. The host filters these out before publishing so
"Recent" shows only real project folders, most-recently-used first. A recent
folder is excluded when it is:

- a reserved special thread's folder (Manager / Speakers — excluded
  by chatId), OR
- junk by the shared junk-folder rule: a special thread's
  working folder recognised by PATH (any path ending
  `threads/manager` or `threads/speakers`), any path with a
  dot-directory segment anywhere (`.patch`, `.git`, `.cache`, …), or a system
  scratch dir (`/tmp`, `/var/tmp`, `/private/tmp`, `/var/folders/*`).

The path test for a thread folder is not redundant with the dot-directory test.
The thread dirs sit under the host's patch home, which is `~/.patch` on an
ordinary install but is relocatable (`02-host.md` § Stack), so a relocated home
gives thread dirs with no dot segment at all (`/daemon-home/threads/manager`) —
those are still patch's own bookkeeping and still never a project. The chatId
test is not redundant either: a folder reaching a picker through the server's
folder roster or a host's published registry arrives as a bare path with no chat
attached, so path is the only thing there is to test.

Explicitly registered project roots are user-designated and bypass the junk
filter (a root deliberately placed under, say, `/tmp/work` is still shown). The
same junk-folder rule is applied on the surfaces' pickers, so a folder the
surface knows only from its own chat history is filtered identically — in the
recent lists, in the pickers' dropdowns, AND in whatever those surfaces DEFAULT
to. A default is drawn from the same filtered set as the list it defaults
within, so no surface can preselect a folder it would refuse to offer.

### Folder roster (folders seen in chats)

The half of a surface's recent list that comes from chat history is served by the
server as its own roster, separate from the chat list: one entry per folder that
holds at least one chat, carrying that folder's host and the timestamp of its
most-recent chat, most-recent first. A surface loads it on cold start alongside
the chat list, and it is what "folders seen in recent chats" resolves to in the
picker and in the sidebar's recent projects.

Archiving does not retire a folder — a folder whose chats are all archived stays
in the roster, so it remains a one-tap entry point for starting the next chat
there, and its host still resolves. Only soft-deleting every chat in a folder
drops it. The roster is deliberately not derived from the surface's own chat
list, which holds only active chats and so cannot see an all-archived folder at
all. Being one entry per folder rather than per chat, it stays small however many
archived chats accumulate.

### Browsing (directory listing)

Beyond the published registry, a surface can browse a host's filesystem
to pick a folder, so the user drills into a directory tree instead of typing a
path. Browsing is addressed to one host at a time, the one whose group the user
is in. Each host exposes a directory-listing control — a request naming a
directory (defaulting to the registered roots when none is given) returns that
directory's child directories only (name + absolute path; files are not
listed — a chat targets a folder, not a file). Browsing is NOT confined to the
designated roots: the host runs with its user's whole authority and a chat can
reach any path on that host the moment it starts, so confining the picker
protected nothing and only stopped a person opening a chat in a folder they had
not registered first. The roots are what the picker OFFERS at the top level —
the shortcuts to where you work — not a boundary on where you may go. Going up
from a registered root returns to that shortcut list; going up from anywhere
else is simply the parent, ending at `/`. A path that does not exist or cannot
be read is still `folder_not_found`, never a listing of something else. The
client renders the tree with a breadcrumb of the current path and a "use this
folder" action at any level. This is the mechanism behind the mobile/web folder
browser (`15-design-mobile.md` § New chat flow); the flat published
`folders.list` remains the one-tap shortcut for the common case.

The browsed filesystem is ALWAYS the selected host's — on every surface,
including the desktop shell. A surface offers only that host's filesystem, not
its own, as the folder source: no OS-native directory dialog, no local file
picker, no drag-a-folder-in. The selected host is frequently a different host
from the surface (the Hetzner box vs. the user's laptop), so a locally-picked
path is a path that host does not have and every chat spawned into it dies with
`folder_not_found`. This holds even where the desktop app runs on a host that
is itself a host: it is a surface like any other and uses the same host-backed
browser the browser SPA uses, against whichever host the user picked. The only
ways to name a folder are (a) the published/recent list, (b) drilling the chosen
host's tree, and (c) typing an absolute path on that host.

Performance (sub-200ms for a typical directory). The listing must feel
instant. The host-side listing:

- reads a directory once, taking each entry's type from the listing itself, so
  there is no per-entry `stat` (a missing or non-directory path is
  `folder_not_found`);
- stats only symlinks, to resolve their targets, and runs those concurrently —
  a pnpm `node_modules` is a symlink farm, and serial stats turn one listing
  into hundreds of round trips;
- caches each result (and the roots view) in memory for about 3 seconds keyed
  by the resolved directory, so the picker's rapid re-reads skip the
  filesystem. Live registry changes still arrive over `folders.updated`
  independently.

## Constraints

- A chat's host and `folder` are fixed for its lifetime; moving starts a new linked chat (§ Moving to another host). For isolation, make a new folder and spawn a chat there.

## Cross-refs

- Spawn sequence on the wire: `03-wire-protocol.md`
- Host internals: `02-host.md`
- Status on disconnect: `12-error-and-offline.md` § Chat status
- Hooks that resubmit/defer onto a turn: `20-hooks.md` § On the agent's response
- Goal bar, sidebar marker, transcript rows: `14-design-web.md` § Goal row, `15-design-mobile.md`
- Job-set goal: `08-triggers-and-jobs.md` § Action
- Goal tools: `06-threads-manager-speakers.md` § Cross-chat toolset
