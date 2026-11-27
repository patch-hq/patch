# Principles

## Patch is a public app

Patch is deployed and used by many users on various environments. Everything that gets built must be able to run for them as part of a deployed unit, not just on this host. All designs/spec must be able to work for a user doing a fresh install of their self hosted server, host and surfaces on their own devices.

## Never use environment variables

Environment variables are not visible as part of deployment. The user has no idea when an agent put them in until it's not there and the deployment breaks or a feature that depends on one is missing. Either the app creates it for itself or its config within the app.

## Gateway

Patch is a gateway to the provider on a device. It passes through what the provider does and does not force what it does not. The provider's conversation, permissions and rendering reach the user unchanged; Patch adds surfaces, triggers and its own tools around them.

Features follow capability. Edit, rewind, branch, resume and switching off native tools are offered only where the provider supports them natively through its official interface; where it does not, the feature is absent for that provider rather than imitated. Each provider's adapter declares what it supports (`02-host.md` § Provider adapters). A provider session that is gone stays gone: the chat stays readable from Patch's record and cannot continue with the model's memory.

Each provider's own settings, session retention and auto-delete among them, are exposed per provider in Settings for the user to choose. Patch does not override them.

Reason for the rule: an imitated feature — a rebuilt session, a faked turn, a rewind the provider never made — gives the model a conversation it never had, and its failures look like the provider's own.

## No hidden prompt content

Patch writes into a provider's conversation only by sending real messages through the provider's official interface. It never fakes turns, rebuilds or reconstructs sessions, writes a provider's session files, strips or alters a provider's output, or injects hidden prompt content. Anything Patch sends the model — a wake, a restart notice, a changed task list, an edited document, a Continue — is an ordinary message in the chat's record that the user can see.

Prompting belongs to the provider and to the user's own instruction files (`CLAUDE.md` and its equivalents) in the relevant folder. Patch ships an empty instruction file for each special thread's folder as starting content in the user's filesystem. The user can read it, edit it, delete it.

Patch ships two pieces of prompt content that are not messages. One is the patch-tools guidance, set through the provider's official system-prompt option so the agent knows what patch's own tools are for. It is not hidden, which is the test: Settings shows its full text, edits replace it, emptying it removes it, and a reset restores the default. It earns its place because patch's tools are deferred: the agent is handed their names and no schemas, so a tool it has never loaded loses to a built-in that merely looks like it would do — `view_file` to `Read`, leaving the user a collapsed row where a picture should be, with nothing in the transcript saying why.

The other is the Manager prompt (`06-threads-manager-speakers.md` § Manager prompt and folder), the Manager's role, set through the same system-prompt option on the Manager's turns only and visible and editable in Settings on the same terms.

The `[voice • <surface>]` prefix patch puts at the start of a user message that came in by voice (see `07-voice-app.md`) is part of that message: stored in the record and shown with it. It is metadata-as-data — like an email From: header — not a directive. The user's instruction files decide what to do with it.

Reason for the rule: invisible prompt content from the platform layer is the single biggest source of hard-to-debug agent behaviour. If something is shaping the agent's responses, the user must be able to see it and edit it. Visibility is the whole of the test, so prompt content that meets it is allowed and prompt content that hides is not, whoever wrote it.

## Patch-owned state

Patch owns the state the user needs to see or that must outlive a turn: the chat record, subagents (`patch_agent`), background tasks, goals, wakes, watches, memory, artifacts, pads and settings. The in-session loop — editing, search, shell, web — is the provider's, and Patch does not reinvent, proxy or wrap it.

Patch adds its state through official channels only. Its tools reach every provider over MCP, and the provider's native equivalents are switched off with the provider's own setting, so the model never faces two tools for one job. Where a provider cannot switch off a native equivalent, Patch's version is off for that provider and the native one is used.

Native equivalents are not left beside Patch's because the host drives each provider through its programmatic interface, not its interactive app: a turn runs to completion, no agent process outlives the call it belongs to, and nothing fires an in-session cron or keeps an in-session background task alive after the turn. A visible but dead tool is a trap — the model is trained to reach for it, it "succeeds", and nothing happens. Bus-watching ("check on this in five minutes") is a `patch_wake_me` self-wake (`02-host.md` § Self-wake).

Patch's tools get distinct `patch_`-prefixed names with distinct words (`patch_wake_me`, not `patch_cron`; `patch_job_*`, not `patch_schedule`) so the model faces no two tools with overlapping meaning. Patch jobs and wakes are for what the agent cannot do alone: durable cross-session schedules (weekly newsletter, daily HA update at 2am), external event ingress (webhooks, Todoist), cross-chat orchestration (Manager spawning fresh chats), and any timer that must outlive a single turn.

A native tool that is only partly inert is corrected, not switched off. Running a shell command in the background is dead here, but the shell is not, so the host refuses that one request through the provider's permission interface and the refusal tells the agent why (`02-host.md` § Background work). Switching off the shell over one dead option would cost the agent its shell.

Default test: if the provider can do it within a turn and nobody needs to see it afterwards, don't add a patch tool for it.

## Configuration

Behaviour is declared in code. An optional environment variable with a default in the source is not allowed, even where a missing value cannot break anything: what is declared and what is running drift apart in silence — the deployment sets the variable, the process never receives it, the fallback runs, and nothing reports the difference. A limit, a timeout, a mode, a fixture, a mock — each is declared in one place in code, and a behaviour worth having is worth having on.

Values that genuinely come from outside — a bot token, an OAuth client, a service account — are configured in patch and stored with the rest of its state, not read from the environment. A host missing one says which value is missing and where to set it, rather than starting up degraded or failing at the moment the credential is first used. Configuring an integration is something the user does in patch, on any surface, like everything else.

The environment supplies only what the process cannot know about itself: the account and host it is running as, and the paths and ports the host hands it. Those are listed in one place, each with the reason it qualifies, and reading one that is not on the list fails the build — so adding the next one is a decision rather than an accident.

## History ownership

A backend's storage does not decide what a chat remembers. Patch's record of a chat is held by the server: one append-only log per chat, in Patch's format, holding every message, tool call, result, artifact and decision in the order it was shown. It is the source for display, search, paging and every surface. Each entry carries the provider's own message or turn id (`nativeRef`), which is how native edit and rewind are offered.

A chat has exactly one writer, its host, which numbers the chat's entries; the server stores them in that order and never renumbers. A host taking over a chat (a replaced host, a Manager home change) continues from the server's last entry.

The provider's session stays on the host in the provider's own format. Patch never reads it for display and never edits it, so a provider pruning, rotating or losing its session costs the model's memory, never the chat's history.

Switching provider starts a new chat linked to the old one. Context carries over only as a visible first message the user can read and edit, and the two chats show as one continuing thread with the switch marked. See `04-chats-and-folders.md` § History and § Provider switches.

## What we don't do

- We don't wrap or transform the agent's prompts, or add anything to them the user cannot see.
- We don't layer a second permission system on top of the agent's. A human editor save is never refused on the grounds that the agent is mid-turn either — the two writers are kept apart by writing atomically, not by locking one of them out.
- We don't summarise, abridge, or rewrite chat content. `patch_peek` returns raw messages.
- We don't compete with the agent on UX. Same prompt, same rendering, same flags. Wire-level pass-through.

If a provider adopts a feature outside Patch-owned state, the corresponding patch feature is removed.

## What we do add

- Remote surfaces: terminal CLI to a remote host, web SPA, native phone app, voice (self-hosted Whisper + Kokoro across all voice surfaces), desktop notifier.
- Provider accounts signed in once and available on every host (`10-auth.md`).
- External triggers: cron, generic webhook, Todoist.
- Cross-chat tools available in every chat: peek, send-to, spawn, job CRUD, notify.
- Notification routing across channels (push / desktop / speakers) with presence-aware suppression.
- QR-code device linking modelled on Happy.

## How we add it

- The server holds every chat's record, decides every chat's status, and is the ingress endpoint. It makes no LLM calls.
- A host runs provider sessions on its machine, one adapter per provider, and is the only writer of its chats. One host per machine.
- Surfaces read only from the server and display what it sends, status included. They derive nothing.
- Copy from Happy where it works (wire protocol, voice architecture, QR linking, host model). Don't reinvent.
- Fail loudly. No silent fallbacks (portfolio convention).
