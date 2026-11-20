# Host

One native background process per host, running as the user who owns
that host. It runs agent sessions and owns the filesystem they work in.

## Runtime and installation

The host runs with the access of the user it runs as: the whole filesystem,
every installed tool, services on loopback, the host's package manager,
`docker`, `systemctl`, `launchctl` and `cron`. A chat on a host can do what that
user can do from their own shell.

It runs under the user's account and `HOME`, so the agent reads that user's own
configuration — their skills, plugins, MCP servers, settings and `CLAUDE.md` —
and a chat behaves the way that agent behaves in their terminal.

The OS service manager owns its lifecycle: launchd on macOS, a systemd user unit
on Linux, with restart-on-failure and start-at-boot. It runs through logout,
surface disconnects, and any app on the same host closing.

It is a native process rather than a container. A container would have to mount
the host back into itself to reach the files it works on, keeping a private
network namespace that hides services on loopback, a private PID namespace that
hides host processes, a foreign uid that misowns written files, and a duplicate
toolchain. On macOS and Windows the container runs inside a Linux VM that cannot
see the user's host at all, so there the arrangement cannot work.

The host dials out to the server over WSS and holds that connection, so a host
works from behind NAT with no public address, open port or DNS entry.

### Installation

The host ships as an installable binary artifact per OS/arch, which installs on
a host that has only an OS on it.

```
patch-host-<version>-<os>-<arch>/
  node               pinned Node runtime
  host.mjs         the bundled host
  native/            platform-native addons (onnxruntime for VAD)
  silero_vad.onnx    the VAD model (~2 MB), the one model weight in the artifact
  install            registers the service, then runs first-run setup
```

`silero_vad.onnx` is in the artifact because it is ~2 MB and everything
end-of-utterance and barge-in depends on it, so it works on every host with
nothing downloaded (`07-voice-app.md`). The large weights stay out
(§ Optional components).

Two install routes:

1. `curl … | sh` on any host with a shell.
2. From a surface: Settings → Hosts offers the install command for another
   host, and the desktop app installs the host onto the Mac it runs on
   (§ Desktop app and the local host).

First run is self-contained: the installer registers the service, provisions a
provider (§ Provider adapters), then asks for the pairing code the user takes
from a linked surface's Add host, and submits it with the host's public key
(`10-auth.md` § Host registration).

The install also writes the `patch-cli` skill that ships in the artifact into the
host user's own agent skills directory, and rewrites it on every self-update, so
every chat on the host can drive the CLI and the skill matches the host it
describes (`17-cli.md` § Skill).

The host self-updates. It checks the server for a newer build on boot and every
two minutes, and installs a newer build as soon as it sees one: it downloads it and
restarts itself under the service manager. Nothing waits for the host to be idle,
since its work outlives the restart (§ Host restarts). A host
behind the current version shows an update control in Settings → Updates. The shared setting
`autoUpdateHosts` (default on) governs this: off, a host neither installs on its own schedule nor is told
to by the server when it connects, and stays put until Update (one host) or Update all is pressed. A
host whose server greeting it cannot read still updates. A failed
update leaves the running version in place and reports the failure to surfaces.
An install never waits for running work, and no surface offers to force one: a
restart ends none of it (§ Host restarts), so the host updates whenever it likes.
The only thing that defers an update is a build whose artifact for this
host is still being built.

### Host restarts

A host restart, whether a self-update or a service restart, leaves the host's
work running. Every long-lived piece of it runs as its own process rather than
as a child of the host: each turn under a detached runner, each terminal session
(§ Terminal sessions), each watch and each `patch_watch` job (§ Background work),
and each script job's command (`08-triggers-and-jobs.md` § Action — `script`). The host
reattaches to each on start.

A turn's runner owns the provider process's stdio and keeps everything said to
and by it on disk, under `<patchHome>/turns/<chatId>/`. On start the host reads
those directories against the chats' owed turns. A turn whose runner is still up,
or whose provider process finished while no host was attached, is reattached:
everything the provider said meanwhile is read back, what the previous host had
already recorded is skipped, and a permission the turn was waiting on is asked
again. A directory belonging to no owed turn is ended and removed, and a finished
turn's directory is removed. A runner with no host attached whose provider has
been silent for 30 minutes ends it, so an orphaned turn finishes as failed
instead of holding its chat running. An install never prunes a version folder a
live runner started from.

A Codex turn is no different. Its `codex app-server` process (one per turn) runs
under the same runner, which records app-server's JSON-RPC lines in both
directions. The thread and turn ids are read back from that record, so a
reattached turn neither resumes the thread nor sends the prompt again; a turn whose
thread or turn was never recorded had not begun, and starts again as a new turn.
What app-server said after the point the previous host had handled is replayed,
along with each request of its (an approval, a question) that no host had answered,
so the user is asked again. Responses to the previous host's own requests are not
replayed, and the new host's request ids continue past the highest the old one
used. A replayed item the chat's log already holds, found by its item id, is not
logged again.

A chat on a model endpoint is no different either: it is a Codex turn (or a
Claude Code one) like any other, and is reattached the same way.

A script job's command runs detached in its own process group, with its output
written to files and its exit code to a sidecar file, and its record is on disk
under `<patchHome>/job-runs/` before the request returns. A host that restarts
mid-run picks each record up, keeps enforcing the command's timeout, and reports
the result when the command ends, with its real exit code, output and duration; one
that finished while no host was up is reported as if the host had been there. A
command that died with the machine left no exit code, and is reported failed as
interrupted, never re-run. The server waits for a script's result for its timeout
plus the acknowledgement bound (20 seconds), so a host that is down for longer than
that has the fire recorded as unanswered first; the result it reports when it
returns, interrupted included, is then recorded against the same fire and shown in
place of the unanswered row (`08-triggers-and-jobs.md` § Logs).

A turn's identity for reattachment is its turn id. A turn that arrives without
one (a spawn prompt, so every job-fired chat's first turn) is given one when it
starts.

Each runner states the protocol it speaks in `runner.json` (`protocol`; absent means
1). Runners are tiny and change rarely. Because a runner lives for exactly one turn,
a new protocol needs no coordination: the old runner finishes its own turn, the
chat's next turn starts on a new runner, and the host never holds anything for it.
A host asked to reattach to a runner whose protocol it does not speak fails that
turn loudly rather than guessing.

A turn whose process did not survive (the machine went down) is not re-sent. Its
chat shows it as interrupted with a Continue action, and Continue goes through
the provider's own resume where the adapter declares one, otherwise it sends a
visible message (`12-error-and-offline.md`). Nothing is added to the turn
without the user seeing it. A turn that was only queued never began, and is sent
as it was.

### Stopping the host

A stop (SIGTERM, a self-update, `POST /stop`) takes seconds, however many chats the host holds: shutdown does only work that scales with what the host was doing, never with what it has loaded.

- Turns, watches, terminals and script job runs are not stopped; they run as their own processes and the host reattaches to them when it starts (§ Host restarts). There is nothing to wait for.
- Only chats whose position or last-updated time moved since their metadata was last saved are written back.
- Everything that can wait on a peer (audio clients, the server link, control connections, transcription) closes concurrently, each with a 2 second budget; a close that overruns is logged by name and abandoned, and a close handshake the peer never answers is cut after 1 second.
- A stop that has not finished in 10 seconds ends the process and is logged as a fault.

### Chat loading

At start the host loads only the chats with live or owed work: a turn to
reattach, a queued or held message, a pending wake, a running watch or run, an
armed or just-ended snooze, a turn parked on credit. It keeps a list of those
chats so start-up reads no others. A chat joins the list the moment it gains
work and leaves it only after the host has found it idle, so a crash never loses
a chat's work. A host with no list (its first start with this behaviour) builds
one from a single scan of its chats; a list that cannot be read is an error.

Every other chat is loaded when something names it: an input, a surface's action
on it, a cross-chat tool. A loaded chat stays loaded. Loading is what checks a
chat's folder (`04-chats-and-folders.md` § Resume) and repairs its log. A listing
or search that must cover every chat reads their records without loading them.
Loading a chat never blocks a surface, which reads only from the server
(`01-server.md`).

On connect the host announces the chats it has loaded in full and names every
other chat's id (`03-wire-protocol.md`), so the server keeps the chats it holds
for this host and drops only those the host no longer has.

### Desktop app and the local host

The desktop app is a surface. It installs and manages the host on its own
host — offering "run a host on this Mac", installing the service, showing
its status, restarting it — and the host it installs is an ordinary OS service
with its own lifetime, like any other host's.

Settings → Hosts in the desktop app carries a This Mac group while the Mac has
no host: one Install action, which mints a pairing code and runs the published
installer with it, and on failure shows the installer's own last lines. Once the
host is installed the group goes, and the Mac is a row in the host list.

A macOS service is given the PATH the user's login shell builds, not the
installer's own: launchd and whatever launched the installer both start from a
bare PATH, and a chat needs the user's tools. An installer that cannot read that
PATH stops rather than registering a service with a guessed one.

## Provider adapters

A chat runs on a provider, and each provider is one adapter. An adapter runs
turns, translates the provider's events into entries of the chat's record (each
carrying the provider's own message or turn id, `nativeRef`), reports the state
of the accounts it runs on (`10-auth.md`), and supplies the models it can run and
the permission modes it accepts. It also declares its capabilities: resume, edit
or rewind at a message, branch at a turn, switch off native tools, interrupt, and
steer. Features follow those declarations (`principles.md`): a feature whose
capability an adapter does not declare is absent for its chats. Surfaces do not
offer it, and the host refuses a request for it with `capability_unsupported`
(a `chat.error`, or a 409 from the CLI and agent tools) rather than doing a
lesser version: an edit without `editAtMessage`, a side thread without
`branchAtTurn`, Stop or send now without `interrupt`, a turn on the provider's
saved session without `resume`. Without `steer` nothing is handed into a running
turn at a tool boundary; a queued message waits for the turn to end and its chip
says `end of turn`. No feature uses `rewind` yet. Adding or
removing a provider is adding or removing its adapter; nothing outside the
adapters branches on a provider by name. A chat's model selects its provider, a
chat never changes provider (`04-chats-and-folders.md` § Provider switches), and
the host reports the providers it has to surfaces.

The provider's session stays on the host, in the provider's own format, where the
provider keeps it. Patch never reads it for display and never writes it.

The Agent Client Protocol (ACP) adapter is the default: any ACP agent is added as
a provider through it, and its capabilities are those the agent advertises over
ACP.

Gemini CLI is the first ACP agent; § ACP agents below says how they run.

Two providers have direct adapters because they expose more than ACP does:

- Claude Code runs through the Claude Agent SDK against the host's own
  installation. It offers a per-chat thinking-effort override
  (`04-chats-and-folders.md` § Effort).
- Codex runs through a managed, version-pinned Codex app-server process, with an
  isolated credential profile per account. The pinned Codex is downloaded from
  the npm registry, checked against the registry's own integrity, and runs as its
  native binary, so a host needs no Node toolchain for it. Its models use
  provider-qualified identities in the model catalogue. It supports explicit
  approval, workspace edits, read-only planning and explicitly unrestricted
  execution, and has no automatic approval classifier, so a new Codex chat
  inherits explicit approval when the default is `auto`. It branches only at the
  turn boundaries the app-server supports. On reconnect the adapter reconciles an
  outstanding provider turn before submitting another; an uncertain outcome is
  reported and never silently retried. It has no effort setting.

### ACP agents

Every ACP agent runs through one provider, `acp`. An agent is configuration,
not code: the command that starts it speaking ACP on stdio, its arguments, a
label, which shared provider keys (§ Provider keys) it reads from which
environment variables, and optionally which of its own session modes matches
each Patch permission mode. Patch ships Gemini CLI (`gemini --acp`, reading the
shared `gemini` key as `GEMINI_API_KEY`); the shared `acpAgents` setting adds
agents or replaces one by id. Its models are `acp/<agent>/<model>`.

- A host offers the agents whose command it has. It asks each one, over
  `initialize` and a `session/new` in a scratch folder that never sends a
  prompt, for its version, its capabilities and its models (the session's
  `model` config option, or the older `models` field; an agent that names none
  offers `default`). The answer is kept for ten minutes, a failed one for one,
  and asked again when the agent's entry or keys change. Each installed agent is
  a row in Settings → Hosts (`acp:<agent>`) with the state the agent gave:
  ready, not signed in (add its key under Settings → Providers, or sign in to
  the agent on that host; there is no sign-in button), or not working, with the
  agent's own words behind Details. A signed-out or broken agent lists no models
  and says why against the `acp` backend in the model picker.
- A turn is one agent process: `initialize`, the chat's session (new, or the
  saved one reopened with `session/resume` or `session/load` where the agent
  advertises either; a load's replay of the conversation is not recorded
  again), the chat's model (`session/set_config_option` or `session/set_model`)
  and mode (`session/set_mode`, where the agent entry maps one), then
  `session/prompt`. Patch's tools go to the session as its `patch` MCP server,
  followed by the host's enabled servers.
- What the agent says becomes the record: message chunks stream and close into
  one message, thought is kept apart, a tool call keeps the agent's own name and
  input and is settled by its update (a diff is recorded as the edit), and a
  plan becomes the chat's task list. Each entry carries the agent's id for it
  (`nativeRef`): the tool call id, or the message id where the agent gives one,
  else one made from where the message began in the turn's output.
- A permission request goes through Patch's permission flow. Under bypass every
  call is allowed and under accept edits every edit, delete and move; otherwise
  the user is asked, and "allow for the session" picks the agent's allow-always
  option. A stop is `session/cancel`; an agent that has not finished 15 seconds
  later is ended.
- Declared capabilities: interrupt always, resume where the agent advertises
  load or resume. ACP has no edit, rewind, branch, steer or native-tool switch,
  so those are absent, and so are `auto` and `plan` modes. A chat on an agent
  that cannot reopen a session cannot continue after its first turn; it says so
  and stays readable. A switched-off Patch tool is left out of Patch's MCP
  server; a switched-off tool of any other kind is refused, since ACP cannot
  switch it off. ACP chats get no generated title (it would be a turn of the
  agent's own, kept in its history).
- Turns outlive the host. An ACP agent runs under the same detached runner as a
  Codex turn (both are JSON-RPC lines on stdio). ACP has no way for a new
  process to rejoin a running prompt, so the runner is what is reattached: the
  next host reads from the runner's files which session and prompt request the
  turn is on, numbers its own requests past the previous host's, is handed what
  the agent said that the previous host had not handled, asks again any
  permission left unanswered, and takes the prompt's answer whether it arrives
  now or arrived while no host was attached.
- Account state (`10-auth.md` § Account states) is what ACP shows: signed out
  when the agent refuses a session for want of a sign-in, limited when a turn is
  refused with a quota error (with no reset time, so the turn fails visibly
  rather than parking), broken with the agent's message otherwise. ACP carries no
  usage readings, and an agent may accept a session with a key its model API
  later refuses; that refusal fails the turn in the agent's words.

Switching off native tools is a capability. Where Patch has its own version of
something a provider also offers natively (subagents, scheduled self-wakes), the
adapter switches the native one off with the provider's own setting and the
chat gets Patch's. Where a provider cannot switch its native one off, Patch's
version is off for that provider's chats and the native one is used
(`principles.md`).

Local models and routers (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter,
LiteLLM) are not providers. Each is a model endpoint inside a harness Patch
already drives, listed under Settings → Providers → Model endpoints: a name, its
API, its base URL, optionally the models to offer, and optionally a key. An
OpenAI-compatible endpoint runs in Codex, as a custom model provider with no
ChatGPT sign-in; an Anthropic-compatible one runs in Claude Code, pointed at it
with `ANTHROPIC_BASE_URL`, with no Claude account: the turn carries the endpoint's
key (or a placeholder for a keyless endpoint) and never a Claude credential, so a
Claude login stored on the host is never sent to the endpoint. The list is a shared setting;
a key is a shared secret, written once, sent to hosts in the snapshot and never
shown again. The models an endpoint names, or else lists at `/models`, appear
under its harness in the catalogue, and an unreachable endpoint is reported
against that harness, naming it. Titles and goal checks for a chat on an
endpoint run on the chat's own model, so nothing calls a paid API the user did
not choose. A chat on an endpoint that is no longer set up is refused, naming
it. Patch runs no agent loop of its own.

Chats made on Patch's former local-model loop (`local/<model>`) keep their
history and stay searchable, but cannot continue: the chat says so and offers a
new chat in the same folder on the same model through Codex. The old
`localModelBaseUrl` setting becomes the endpoint those new chats use.

The host provisions a provider the host lacks rather than reporting it as
missing. For Claude Code it resolves the `claude` executable and passes it to the
SDK as `pathToClaudeCodeExecutable`, so turns run against the same binary,
version and configuration the user gets in their terminal:

1. Present: use it. The resolved path and version go to surfaces and appear in
   Settings → Hosts.
2. Absent: install it via the provider's own installer once the user has picked
   that provider (`host.backend_install`, `03-wire-protocol.md` § Host events),
   never before, reporting progress to surfaces over the same channel as
   § Optional components. Claude Code's
   native installer needs only a shell and curl and installs to the user's own
   `~/.local/bin`, where the host then finds it and keeps it updated.
3. Present and signed out: the adapter reports the account as signed out, and
   every surface offers sign-in (`10-auth.md`).

A host takes its last-used model from the first catalogue it reads successfully —
the newest entry of it — so a host can run its first chat before anyone has
chosen a model on it (`04-chats-and-folders.md` § Spawn). That read needs a
working credential, so a host whose provider is provisioned but signed out has no
last-used model until it is signed in. Every chat spawned after that
sets it.

A failed install is reported to surfaces and the host holds turns for that
provider until it is resolved. Providers are independent: a host with one
unprovisioned keeps running chats on the others.

## Small jobs

Chat titles, status lines, tool-run labels, branch send-back summaries, link summaries and recurrence translation are small one-shot model queries. They share one ordered model list: the first entry is the set model, and each later entry is tried in order when the one before it fails. The default is `claude-haiku-4-5-20251001` then `claude-sonnet-4-5`. The list is the shared setting `smallJobModels` (`01-server.md` § Settings), changed with `patch settings set small-job-models a,b` (set model first), and applies to every host from its next job. An empty list, an empty entry or a model named twice is refused when the setting is written. `PATCH_SMALL_JOB_MODELS` is not read.

This is separate from account choice (`10-auth.md` § Choosing an account): the account is chosen first, then the models are walked on it. Each failed model is logged. When every model fails the job fails with an error naming the models tried and the last reason, so a retired or unavailable set model is visible and not covered over. Jobs with their own configured model (goal checks, meeting analysis, manager sweeps, rotation digests) and Codex chats, which run on their own model, are not part of this list.

## Permission mode

Turns run under `auto` by default: a model classifier approves or denies each
tool call without involving a human. Surfaces are remote and frequently
asleep, so `auto` is what a host starts on absent an explicit choice — a call
the classifier will not approve is denied outright and the agent is told so in
the transcript, which leaves the triggers, jobs and self-wakes that run
unattended free to carry on or fail visibly rather than stall until somebody
happens to look.

The SDK's classifier sometimes gives up on a `Bash` call and hands it to the
host as an approval request anyway. Under `auto`, on a turn the host started itself (job, trigger, self-wake — `origin: machine`), the host treats that as the
classifier's denial: it refuses the call at once, tells the agent so, and raises
no approval card — the denial shown in the transcript carries the classifier's own stated reason when the SDK gives one — a card in an unattended job chat only stalls it. A goal follow-up turn is `origin: machine` but belongs to a person's chat, so it asks like a user turn unless the chat is hidden. On a turn the user started, someone can answer, so the call is put to them as an ordinary approval card — this is how an advance approval is honoured rather than refused. Other
escalations under `auto` (a sensitive-file write, a question) still ask.

`bypassPermissions` never prompts — every tool call runs immediately.
`default`, `acceptEdits` and `plan` DO block a turn: a tool call needing a
decision under that mode (e.g. `acceptEdits` still prompts for a Bash command,
only file edits are pre-approved) is held until a `chat.permission_request`
sent to surfaces (`03-wire-protocol.md`) is answered with a
`chat.permission_response` — the chat is waiting for the user meanwhile
(`12-error-and-offline.md` § Chat status), resuming the turn once answered, denying the call with the agent
told so in the transcript if declined. Because these modes can stall a turn
on an absent human, none of them is ever reached by default — only by a
deliberate choice, made by someone who intends to be there to answer it.

The modes are `auto`, `acceptEdits`, `bypassPermissions`, `default` and `plan`.
They are the Agent SDK's own mode names and are passed through to it unchanged,
so every surface that offers the choice names them exactly as written here
rather than in words of its own — except `default`, which surfaces call Ask:
it is not the default mode, and "Default" beside a preselected Auto reads as
a contradiction.

Every chat carries its own mode. It is stamped at creation from the host
default in force at that moment (a spawn request naming a mode wins over it),
and from then on only a change made to that chat alters it. Changing the host
default therefore steers the chats created next, and never reaches back into
one already running. The mode is stored with the chat rather than in the
running process, so a host restart does not disturb it.

The default is a shared setting (`01-server.md` § Settings), so every host
stamps new chats from the same one; `auto` until one is chosen. A provider may also have a
default of its own (`providerPermissionDefaults`, keyed by provider id), which
wins for chats on that provider and may only name a mode the provider can run;
the server refuses any other. A provider with none takes the shared default, or
`default` where it cannot run that (Codex has no `auto`). A chat is set from within the chat itself. There
is no clearing a chat back to the host default — a chat with no mode of its own
does not exist.

The host carries the chat's mode on `chat.state`, so a surface shows the mode
the next turn will use. That value is only ever the mode in force now, so a
change made part-way through a conversation is also written into the chat's
transcript, as a `system` `chat.message` naming the mode the chat moved to. It
is recorded where the change was made, which is one turn before it takes
effect. Re-picking the mode a chat is already on changes nothing and records
nothing. These are entries in the chat's record; the provider's own session has
no notion of them.

Claude Code can resolve a turn onto a different mode than the one it was
given and does not refuse the combination itself, it silently substitutes one
and carries on. The host compares the mode Claude Code actually resolved
against the one requested at turn start and, for every substitution
target except `plan`, refuses the turn: the turn ends failed
and the error states facts only — the mode requested, the mode that ran, the
model and the Claude Code version, with no guessed cause — because the remaining targets
(`default` in practice) block on a human approving every tool call, which for
an unattended chat is a dead end rather than a degraded mode.

A mode change made while a turn is running applies from the next turn. It never
fails, interrupts or is compared against the running turn: the check above is
against the mode the turn started with. (A turn running in `plan` is the one
exception: moving it off `plan`, as "Approve & resume" does, reaches it now.)

A turn Claude Code lands on `plan` is not refused. `plan` blocks a turn the
same way `default` does — a decision per tool call — so it is exactly what a
person choosing `plan` from the mode control gets, not a dead end. The turn
runs on, the chat is moved onto `plan` exactly as a person's own choice would
move it, and it gets the same mode-change record in the transcript — except
this one names Claude Code as what made the change, not the person the chat
belongs to.

### The agent's own Plan Mode entry, mid-conversation

Distinct from the substitution above: the agent can call `EnterPlanMode` /
`ExitPlanMode` itself, mid-turn, on a chat that was never given `plan` at all
— a deliberate "let me think this through with nothing at stake" the model
reaches for, independent of the chat's configured mode. While it lasts the
SDK gates every tool call the way `plan` does, so the chat's mode must say
`plan` too.

The host watches for these two tool calls in the stream (`EnterPlanMode` a
`tool_use`, `ExitPlanMode` its `tool_result` — gated on the result, not the
call, since `ExitPlanMode` presents the plan and waits on approval before the
SDK actually leaves `plan`; a denied/errored result changes nothing). Entering
stamps the chat onto `plan` and records it exactly as the substitution case
above does (`automatic`, naming Claude Code as what made the change);
exiting restores whatever mode the chat was actually configured to before —
held in memory for the span of the plan, not persisted, since it describes
one turn's tool-call sequence, not a standing preference. A manual mode
change made _while_ plan is active is not specially reconciled against this
in-memory stash; it is expected to be rare enough not to need it.

### Questions are not approvals

The permission gate is also how the agent asks the user a question:
`AskUserQuestion` reaches it under EVERY mode, `auto` and `bypassPermissions`
included, because there is nothing to auto-approve — the tool's whole output is
the answer the human gives. Its arguments carry 1–4 questions, each with a
short `header`, the question text, 2–4 `options` (`label` + `description`) and a
`multiSelect` flag; its `answers` argument is left empty for the permission
layer to fill in, and the tool echoes back whatever it finds there. So an
approval with no answers is not a no-op — it runs the tool and returns an empty
answer to the agent, which then proceeds on a decision the user never made.

The host therefore treats an `AskUserQuestion` permission as a question, not a
yes/no: the surface renders the options (`14-design-web.md` § Main chat panel)
and returns the selections as `approve_with_edits` (`03-wire-protocol.md`
§ Answering with content), and the host merges them into the tool's `answers`
argument as the `updatedInput` it grants permission with. Denying is still a
real deny — the tool does not run and the agent is told so — which is what
"cancel the question" means. NO FALLBACK: answers that do not parse as
`{[questionText]: string}` deny the call and raise a `chat.error`, rather than
approving an empty answer.

What the agent is told when a question expires is the shared `questionExpiredPrompt`
setting (`{seconds}` is the window), edited under Settings → Prompts. Its default
tells the agent to carry on with what does not depend on the answer rather than stop.

A question asked while a person's message is already queued on the chat is not
raised at all: it is denied at once with the superseded message, because the
message is the answer and the turn would otherwise park before the tool call
that releases the queue.

Cancelling is not the same act as stopping the turn (`04-chats-and-folders.md`
§ Message queueing), and the deny message the agent is handed says so. Left
generic, a deny reads to the agent as the user refusing the plan behind the
question, not just declining to answer it — so a question the agent could have
carried on past instead ends the turn outright. The host's deny message is explicit
that the turn is still live, and tells the agent to keep going on whatever it
can decide for itself, and to come back and ask — or stop — only for what a
question exists for in the first place: an ambiguity it cannot resolve alone,
or a next step that is destructive, irreversible, spends money, or otherwise
reaches outside the chat into the real world.

A question is also superseded by the user simply answering in the composer,
which is the normal thing to do when none of the options is the answer. A new
message on a chat with an outstanding question cancels the question — a real
deny, so the tool does not run — and the message then runs as the next turn.
Without that the message is accepted, queued, and goes nowhere: the turn is
suspended on the question, and the queue only drains once that turn ends. The
agent is told that the question was superseded rather than refused, and that the
next user turn is the answer, so it reads the reply instead of apologising for
having asked. Only questions: an ordinary tool approval is a turn paused on
purpose, and typing must never decide it.

A question also EXPIRES. It is the one permission the user cannot simply leave
pending: the turn cannot proceed without it, so a question asked while the phone
is in a pocket parks the whole chat indefinitely and the agent has no way to
notice. Question expiry is a shared setting (`01-server.md` § Settings): on or off, and the window in seconds, defaulting to on at 10 minutes.
Turned off, a question waits indefinitely and no deadline is shown.

An ordinary tool approval expires too, on a fixed hour rather than the
question window, and is not configurable: an approval raised in a chat nobody
is watching wedges an unattended job exactly as a question does, but a chat
someone is sitting in front of is likelier to want to approve a tool call than
to answer a question, so it is given more of the doubt.

The host owns the deadline, and it is the same deadline everywhere: the
request carries the instant it expires (`03-wire-protocol.md`), so every
surface counts down to the one the host will actually act on rather than to a
clock of its own, including a surface that connects after the question was
asked. A request with no deadline on it is one that will not expire.

A question's deadline is not fixed the instant it is asked. A surface's
`chat.focus_change` (`03-wire-protocol.md`) naming this chat, or naming
something else after previously naming this one, gives the deadline a fresh
full window — the same length the question was originally asked with, not
whatever the setting currently reads, so a mid-flight change to the setting
cannot retroactively shrink a question already in play. Both edges reset it:
the user looking at the question and looking away are each worth a fresh
window. Every connected surface is told
the new deadline (`chat.permission_expiry_update`, `03-wire-protocol.md`), so
the one-deadline-everywhere rule above still holds after a reset. Only a
question resets this way; an ordinary tool approval's fixed window ignores
focus.

The expiry resolves as a `deny` on the wire, because `deny` is what
`chat.permission_response` can already say and a new decision value would be
dropped by any surface running behind (`03-wire-protocol.md`). The AGENT is told
the truth instead, through the deny message the host hands `canUseTool`: that
nobody answered, that this was NOT a refusal, and that it must not assume any of
the options. Otherwise an expiry reads to the agent exactly like the user
rejecting the question, which is the same class of bug as an empty answer.

## Optional components (large models)

The list is Kokoro TTS (~340 MB), a local Whisper model (~1.5 GB) and the
speaker model for voice profiles (`speaker`, ~27 MB, WeSpeaker ResNet34 in
sherpa-onnx's format, `16-voice-device.md` § Who is speaking): weights the
installer does not carry. The host downloads them on demand,
per host, driven from the app. The VAD model stays off this list — it is ~2 MB
and ships in the artifact (§ Installation). Two entry points:

- Settings → Hosts → components lists each optional component with its size and
  state (`not installed`, `downloading`, `installed`, `failed`) and install and
  remove controls.
- Starting a meeting on a host with no speech set up asks which route to take
  (§ Speech set-up). Pressing the mic on a host whose voice components are missing asks once —
  "Voice needs a 340 MB download on <host>. Download?" — and on accept starts
  that same download with progress in place. Declining cancels the action.

Download progress streams to every surface (`03-wire-protocol.md` § Host
components), so a download started on a phone is visible on the desktop.

Each host advertises the components it has. A surface disables an affordance
whose component is missing and names what is needed. An interrupted download
resumes, and a component counts as installed once its size and digest verify.

Remote backends install nothing: with the speech engine set to Groq, STT is a cloud
call.

### Speech set-up

Voice stays optional at install: a fresh host has no speech engine, and nothing
is downloaded or bought for it. The first time a surface starts a meeting on a
host with no speech set up, the host refuses the start with `chat.error`
`speech_not_set_up` (message naming both routes) and the surface asks the user
to choose:

- Add a cloud speech API key (Groq). The key is saved as a provider key
  (§ Provider keys) and the host transcribes with it from then on.
- Download the local voice models onto that host (Whisper and Kokoro, about
  1.9 GB per host, § Optional components), with progress in the prompt.

Either way the refused meeting starts again by itself once the route works: on
the key being saved, or on the Whisper component verifying as installed. The
host switches engine in place when a key or component arrives, with no restart.
An installed local model wins over a key, because it costs nothing. A host whose
speech setting names an engine (below) or an account whose meeting engine is a hosted one already counts as
set up. There is no fallback: with no route chosen, transcription refuses rather
than returning a stub, and no key is spent unless the user added it.

The engine is the shared setting `speechBackend` (`01-server.md` § Settings),
changed in Settings or with `patch settings set speech-backend <value>`: `auto`
(the default) follows what the host has, as above; `off`, `groq`, `elevenlabs`,
`local` or `parakeet` name one engine on every host. Each host saves the value in
its own state and switches engine in place, with no restart. A named engine
whose credential or model is missing is refused where the setting is applied:
that host reports which value is missing and where to set it, keeps its current
engine, and still applies the rest of the same settings update. A `mock` engine exists for
test fixtures only and can be named only in a host's own state file, never by
the setting.

## Browser

A host can run a real browser for its own chats — Chrome/Chromium in a
virtual display, never headless — so an agent can do what a human does in a
browser: fill in a form, sign in, click through a multi-step flow, in the
background. Distinct from the optional "Browser tools" setting that wires the
`playwright` / `chrome-devtools` MCP pair into a chat's tool list (§ Runtime
and installation above, `14-design-web.md` § Agent behavior) — that stays as
it is, an opt-in MCP a chat can turn on. This is a Patch-owned capability with
its own `patch_browser_*` tools (`06-threads-manager-speakers.md` §
Browser tools), distinct names so the model never faces two overlapping ways
to drive a browser.

Honest by design. The browser is a normal Chrome/Chromium with a normal
fingerprint: never headless (`headless: false`, under a real display, or on a
headless Linux host one this component opens itself with its own Xvfb),
automation flags off (`--disable-blink-features=AutomationControlled`,
`navigator.webdriver` patched undefined by an init script), real input events
with human timing on every click and keystroke, persistent cookies. It never
pretends to be something it isn't beyond being a normal browser — no stealth
beyond that, and no captcha-solving service of any kind. It obeys
`robots.txt` only where that applies (crawling); a user-directed task working
a page the user asked for open is not a crawl.

Profiles. One persistent profile, `<patchHome>/browser/profile` — a real
Chromium `userDataDir` — shared by every chat on the host, so a site logged
into once stays logged in across chats and across a host restart (this is
the `'logged-in'` default `patch_browser_open` takes). A task that must run
signed out instead passes `profile: 'logged-out'`, which opens a throwaway,
in-memory browser context with no `userDataDir` and so no cookies to carry —
closing its tab leaves nothing on disk.

Installation. Optional, the same Settings → Hosts pattern as the voice
weight sets (§ Optional components above) — not installed, the
`patch_browser_*` tools fail saying exactly how to install it, with no
fallback to another browser or to `headless: true`. Unlike a weight download
there is no digest to verify: "installed" means Playwright's own Chromium is
present (`npx playwright install chromium`) and, on a headless Linux host
with no `DISPLAY`, that `Xvfb` is on the `PATH` to open one. A host that
already has a real display (a desktop Mac, a Linux box someone is logged
into) uses that one directly and never starts its own Xvfb.

Computer use is off by default. `patch_browser_mouse` and
`patch_browser_key` (acting by screen position) refuse to run until the user
has answered a permission card — Approve, Always allow, or Deny — the first
time a chat uses them. Approve covers the rest of that chat; Always allow is
stored in `host.json` (`computerUseAlwaysAllowed`) and covers every chat on the
host; Deny fails the call with no fallback. The other `patch_browser_*` tools
are not gated.

Tools. `06-threads-manager-speakers.md` § Browser tools has the
full signatures. The tools let an agent do anything a person can do in a
browser: `patch_browser_open` returns a `tabId`; `_read` returns the page as
element snapshot, full text, structured data or accessibility tree; `_click` /
`_type` / `_fill_form` / `_select` / `_upload` / `_interact` act on an element by
`ref`; `_mouse` / `_key` act by screen position; `_navigate`, `_wait`,
`_switch_tab`, `_tabs` and `_close` move through pages and tabs; `_dialog` and
`_downloads` handle what pages throw up; `_state` carries cookies and
localStorage; `_eval`, `_console`, `_network` and `_viewport` debug; `_screenshot`
sees what text can't. Before anything irreversible a click or a submitted form
could trigger — a payment, a sent message, a booking, a deletion — the tool's
own guidance is to ask the user first; this is the tool-ownership convention
(`principles.md` § Patch-owned state), not a second permission system alongside
`canUseTool`.

Refs. A `ref` names an element, wherever it lives: the top document, an
iframe (cross-origin included) or an open shadow root. Refs are stable — an
element keeps its ref across reads, a new element gets a new one, and a ref stops
resolving only when its element leaves the page (`ref_not_found`). Elements with
no ref (a paragraph, a drop zone) are named by a CSS selector where a tool takes
one.

Reading. `patch_browser_read` has four modes. `snapshot` lists every visible
interactive element with its ref, role, name, value and link target. `text` is
the page's visible text, in full up to `maxChars`, iframes included, or just the
element at a `ref`. `structured` returns headings, tables (headers and rows),
lists, links and the article body. `accessibility` is the browser's own
accessibility tree. A password field's value, and anything the user typed during
a hand-off, is `[redacted]` in every mode. Screenshots can be of the viewport, the
whole page, or one element.

Pages that open things. A link that opens a new tab or window
(`target=_blank`, `window.open`, with or without `noopener`) becomes a tab of its
own, owned by the chat that drove its opener and listed by `patch_browser_tabs`
with its `openerTabId`. A dialog never blocks a tab: an `alert` and a
`beforeunload` are accepted, a `confirm` or `prompt` is declined unless the agent
armed an answer for the next one with `patch_browser_dialog`, and every dialog is
recorded for the agent to read. A download is saved under
`<patchHome>/browser/downloads/` and listed by `patch_browser_downloads` as a file
on the host. A file chooser is never opened natively: it is held until
`patch_browser_upload` fills it (`patch_browser_read` reports `fileChooserOpen`),
and uploading through the element that opens one does both steps.

Waiting. `patch_browser_wait` waits for text to appear or vanish, a selector
or ref to reach a state, the address to contain a string, the network to go idle,
or a fixed pause, and fails clearly on timeout rather than carrying on.

State. `patch_browser_state` reads, writes, saves, loads and clears the
profile's cookies and localStorage, so an agent can use a saved sign-in. Saving
writes a mode-600 file on the host and returns only counts, keeping secrets out of
the conversation; getting returns the values. The `'logged-in'` profile is shared,
so state set in it is visible to every chat on the host.

Debugging. `patch_browser_eval` runs JavaScript in the page or an iframe.
Each tab keeps its last 500 console messages and page errors and its last 500
network requests, readable through `_console` and `_network`; a response body is
available while the page that made it is still loaded. `patch_browser_viewport`
resizes the tab or emulates a named device (viewport, pixel ratio, touch, mobile
user agent); the user agent changes only when a device is asked for.

Reliability. A tab whose renderer crashed, or whose browser was killed or
closed, is rebuilt the next time the agent uses it: same `tabId`, relaunching the
browser if needed, reopened at the address it was on, with no action from the
user. The page's in-memory state is lost, so the next `patch_browser_read` carries
a one-time `notice` saying so. A tab the user closed by hand stays closed
(`tab_not_found`). A host restart
is the same: the host keeps the list of open logged-in tabs on disk (`tabs.json`
beside the profile), and the first use of a `tabId` from before the restart
reopens it at its last address with the same notice. Closing a tab, Stop, and a
clean shutdown leave nothing to restore; throwaway logged-out tabs are not kept.

Watching and stopping. The browser is one host-wide resource shared by every
chat; a tab is attributed to the chat that opened it. A chat's browsing is visible
and stoppable from that chat. `patch.browser_view.status` (host → surfaces) reports whether an action is
running (in plain words, "Clicking") and the chat's open tabs, sent whenever
either changes. Each chat's surface shows `Browsing <site>` with Watch and Stop
(`14-design-web.md` § Main chat panel — Browser hand-off). Stop
(`patch.browser_view.stop`) cancels that chat's in-flight `patch_browser_*` calls,
which fail with `browser_stopped`, and closes its tabs; other chats' browsers are
untouched. Settings → Computer use has the host-wide Stop, which does the same for
every chat. The user can also take any tab over at any time through the hand-off
below.

### In the Patch app

When the Patch app is installed on the host's own host, the agent's browser
lives in the app instead of in a Chromium of the host's own. The app is a real
browser; its tabs are the agent's tabs, and a large view of one in that app's
window (`14-design-web.md` § Main chat panel — Browser) shows the tab itself
laid over the view's place — typing, selection, scrolling, the context menu,
copy and paste are the browser's own — rather than a picture of it.

- The bridge. Electron has no browser-wide DevTools endpoint that is not an
  open, unauthenticated port, so the app serves one: a loopback WebSocket whose
  path holds a 32-byte random token, written with the app's path and pid to
  `~/.patch/agent-browser.json` (mode 600). The host connects Playwright to it
  (`connectOverCDP`) and drives tabs with the same code as anywhere else, so
  every `patch_browser_*` tool, the live view and hand-off work unchanged.
  Page sessions are relayed to each tab's own debugger; the browser-level
  commands Playwright sends — targets, contexts, cookies, permissions,
  downloads — are answered from Electron's own APIs. A command the bridge does
  not answer fails naming it.
- Profiles. The signed-in profile is the app's own persistent partition,
  shared by every chat; a throwaway profile is an in-memory context of its own.
  The user agent carries no app or Electron token.
- Tabs. A tab no view shows lives in a window that is open but never seen
  (borderless, transparent, off every screen, taking no input), so its page
  keeps drawing for screenshots and the live view; a large view moves it into
  its own window at the view's place and back when it closes, and a window
  that closes or reloads gives its tabs back. A link that opens a new tab, or
  `window.open`, becomes a tab of its own with its opener kept. Downloads go
  where the host asks. The host learns each tab's target id and reports it in
  the status (`appTarget`), which is how the app's own window knows the tab is
  its to show. The user working a shown tab while the agent is not acting
  takes it over, as in the live view.
- Starting. The host decides at its first browser launch: the endpoint file exists (the app
  has run here) means the app's browser. Not running, the host starts it in
  the background (`open -g -j` on a Mac) and waits up to 30 s. NO FALLBACK:
  an app that does not come up fails the browser call
  (`app_browser_unavailable`, 503) rather than reverting to a separate Chromium.
  The host's disconnecting closes what it opened; the app keeps running.

### Hand-off

The agent can drive the browser but must not type the user's passwords, pass
their 2FA or approve an OAuth consent on their behalf. `patch_browser_handoff`
hands one tab to the user, in the chat, and waits.

- Live view. `patch.browser_view.watch` (surface → host, `tabId` optional =
  the chat's most recently opened tab) starts a stream of
  `patch.browser_view.frame` (host → surfaces): a JPEG of the tab each time
  its page paints (Chrome's screencast, so a still page sends one frame and a
  moving one up to 20 a second), its viewport size, its address with the query
  and fragment removed, its title, and whether it can go back or forward. A
  picture is sent as soon as the view opens, so a page that is not moving still
  shows. Surfaces renew the watch every 5 s; the host stops streaming a tab not
  asked for in 15 s, so a vanished surface costs nothing. Frames are
  detail-level (only surfaces focused on the chat get them) and carry no `seq`:
  they never enter history.
- Large view. Each open view names itself (`viewerId`). A view shown large
  sends its own size and pixel ratio (`viewport`): the tab takes that size, so
  a phone gets the site's own narrow layout and the agent sees the same size,
  and pictures are drawn at that ratio — Chrome's screencast draws at the
  window's own ratio, so each paint is answered with a screenshot from the
  session that set it. When no large view renews it the agent's own size comes
  back. A size the agent sets itself (`patch_browser_viewport`) wins: views stop
  resizing the tab until they all close. The agent's screenshots are always in
  CSS pixels, so a view never moves its coordinates.
- Using the tab. The user can work any tab of their chat at any time
  (`patch.browser_view.input`, host `inputVersion` 2): presses and releases
  with their button, click count and modifiers (so a drag selects text or
  drags), the wheel, keys held or pressed (Cmd on a Mac is Ctrl to a browser on
  any other system), text, back, forward, reload and an address, and Copy,
  which answers with the selection (`patch.browser_view.clipboard`). They play
  one at a time in order, a burst of moves collapsing to the newest, and are
  never logged. Working the page — a press, a key, text, navigation — takes the
  tab over (`driver: 'user'` in the status); moving the pointer and scrolling
  do not. Take over and Hand back can also be sent outright
  (`patch.browser_view.drive`). While the user drives, every agent call on that
  tab waits; on Hand back the call that waited fails with `user_was_driving`
  ("read the page again before acting") rather than acting on a page the user
  may have changed, and a call made later carries the same as a one-time
  notice. One that waits 10 minutes fails with `user_driving`. A tab nobody is
  watching any more goes back to the agent. The status also carries where the
  agent last pointed (`cursor`), so a view draws its cursor, and when the
  chat's oldest open tab was opened (`since`), for the timer.
- Hand-off. `patch_browser_handoff({ tabId, reason, callbackPort?,
timeoutSeconds? })` blocks the tool call. The host emits
  `patch.browser_handoff.state` `waiting` with the agent's `reason`, and
  streams the tab, repeating the `waiting` state every 3 s so a surface that opens
  the chat late still hears it. The user's clicks,
  scrolls, text and keys arrive as `patch.browser_handoff.input`, in viewport
  pixels, and are played into the page as real browser events by the host —
  no Computer-use gate, since the user is the actor. They play one at a time
  in the order they came, and a burst of pointer moves collapses to the newest,
  so hover keeps up and a click never overtakes the move before it. They are accepted only
  with the live `handoffId` of that chat. `control` `done` or `cancel` ends it;
  so does `timeoutSeconds` (default 600), the tab closing, or the OAuth relay
  below. The host then emits `state` `ended` with the `outcome` (`done`,
  `cancelled`, `timeout`, `tab_closed`, `callback`).
- Sign-in form. While a hand-off waits, the host looks for a sign-in form
  on the page (a visible password or one-time-code field, or an email or
  username field on a sign-in page) and tells surfaces its fields' labels and
  kinds (`patch.browser_view.form`), never values, again whenever it changes. A
  phone shows them as its own fields and sends what the user typed as `fill`:
  the host puts the values into the page's fields, marks them as the user's
  (so the agent's reads show `[redacted]`) and submits. The user can always use
  the page instead.
- Share for review. `patch_browser_handoff({ tabId, reason, share: true })`
  is the non-blocking form, for a page the user should look at rather than act
  for the agent (a local app on a headless host). It returns at once with
  `{ ok, shared: true, handoffId, url }`. The host emits the same `state`
  events with `shared: true` and streams the tab, but the tab is not locked,
  nothing is redacted, and there is no timeout: the agent keeps using the tab
  and the user's feedback arrives as ordinary chat messages. The user's input
  is played into the page as in a hand-off. It ends (`state` `ended`) on
  `control` `done` or `cancel`, or `tab_closed`. A second share of a tab already
  shared is refused, and `share` with `callbackPort` or `timeoutSeconds` is
  invalid input (400).
- Out of the model's reach. Frames, the address with its query, and the
  user's input travel host ↔ surfaces as wire events, never as tool results.
  While a hand-off is open every other `patch_browser_*` tool refuses that tab
  (`tab_in_handoff`, 409), and `patch_browser_tabs` shows it with no title and
  no query. What the call returns is `{ ok, outcome, url, callbackStatus? }`
  where `url` has no query or fragment. Typed text is never logged. The agent
  gets the tab back when the call returns, and may then read it as usual, except
  that `patch_browser_read` shows the value of a password field, and of any field
  the user typed into during a hand-off, as `[redacted]`.
- OAuth loopback relay. With `callbackPort`, a navigation of the tab to
  `http(s)://localhost` or `127.0.0.1` on that port is intercepted by the host,
  which makes the request itself against its own loopback and hands the
  listener's response to the page. A process waiting on that port on the host
  therefore receives the authorization code however far from the host the
  user is, and the code appears in no tool result, event or log. The hand-off
  ends with outcome `callback` and the listener's HTTP status. A listener that
  cannot be reached fails the call with the reason (and no code), and the tab
  is returned. The listener must already be running.
- Surfaces. Web and phone show the same bar in the chat (`14-design-web.md`
  § Browser hand-off, `15-design-mobile.md` § Browser hand-off).

### Web Bot Auth

A Patch deployment can identify requests its agent browsers make so sites that
verify agents (Cloudflare verified bots, Akamai) can recognise it. This is an
optional shared setting, off by default. With it off, both browser profiles work
normally and send no Web Bot Auth headers. Turning it on or off applies to
existing browser sessions without restarting a host. The
server creates one Ed25519 identity on first start, keeps its private key in the
encrypted shared-secret store, and never sends the private key to a host or
surface. There is no operator-supplied key or environment setting. Every
http(s) request from either profile (`logged-in`, `logged-out`) asks its paired
server over the authenticated host link for a fresh signature and is signed per request
(RFC 9421, `tag="web-bot-auth"`, covering `@authority` and `signature-agent`,
Ed25519, `keyid` = the key's RFC 7638 thumbprint) and carries
`Signature-Agent: "<server URL>/.well-known/http-message-signatures-directory"`.
While it is on, a host that cannot reach its paired server refuses the affected
agent-browser request; a signing failure or timeout aborts that request, never
sends it unsigned.

The server serves the public half: `GET /.well-known/http-message-signatures-directory`
(signed key directory, unauthenticated) and `GET /agent` (the deployment's
public agent name, description and operator contact, plus that it obeys
robots.txt and browses at human rates). The public details are ordinary shared
settings, editable under Settings → Agent identity; the identity key is not.
A fresh deployment serves a valid
directory without configuration, and keeps the same identity across restarts.
Each independently installed server therefore has its own identity and public
directory; its hosts and surfaces depend only on that server, never on another
Patch installation or the maintainer's devices.

## Claude Code settings

The host runs Claude Code against the user's own configuration (§ Runtime and
installation), and two parts of it are visible and editable from Settings:

- `settings.json` in the `~/.claude` the agent backend reads — permissions,
  hooks, model, statusLine, output style, env and the rest. It is that
  host's own file, not a shared setting: it is edited on one chosen host
  and nothing copies it to another, so hook paths and the like can differ
  between hosts without any override. Settings shows the text as the host
  holds it and Save sends the whole text to that host (`host.claude_settings_set`),
  which replaces the file. Text that is not a JSON object is refused, naming
  why, and the file is left as it was. A change made on the host itself
  (Claude Code, an editor) is simply the file; there is no drift to resolve.
- Memory entries: Claude Code's own persistent-memory files, one per topic,
  under each project's `~/.claude/projects/<project>/memory/` alongside its
  `MEMORY.md` index. These stay on the host that wrote them, since they are
  stored under that host's project paths. Each entry is listed with its
  name, description and type (parsed from its frontmatter) and can be deleted.
  Deleting one also drops its line from that project's `MEMORY.md` index where
  present.

A provider setting the user has chosen in Settings → Providers (`10-auth.md` § Settings) is written into `settings.json` by the host, keeping every other key. Settings never changes a key the user has not chosen.

The host publishes its `settings.json` text and memory entries on connect and
after every change (`03-wire-protocol.md` § Host events), and the local CLI socket carries
the same operations (§ Control IPC).

## Provider keys

The paid services the host itself calls each need an API key: Gemini
(`GEMINI_API_KEY`) and OpenAI Realtime (`OPENAI_REALTIME_API_KEY`) for hosted
voice, Groq (`GROQ_API_KEY`) for Whisper when the speech engine is Groq
(`07-voice-app.md` § Voice is a config matrix), and Deepgram
(`DEEPGRAM_API_KEY`) for live dictation (`07-voice-app.md` § Dictation engines). These are the host's own
keys, not the agent's (the agent's credentials are its provider's, `10-auth.md`),
and not Secrets (which are injected into chats, `15-design-mobile.md` §
Settings tab).

Provider keys are shared settings (`01-server.md` § Settings): set once on
Settings → Providers and used by every host.

- A key comes from Settings → Providers, or from the host's own environment, read
  once at boot. A key set from Settings wins over the environment; revoking it
  lets a host's environment apply again. A key in one host's environment can
  be adopted from Settings as the shared value.
- Everything that uses a key reads it when it opens a session or sends a
  request, so a new snapshot takes effect for the next session with no
  restart. After applying one, each host re-publishes `host.host`, whose
  `voiceKeys` and `providerKeys` state each key's source on that host (`ui` /
  `env` / `none`) and whether its environment also has one. They drive
  Settings → Voice's "not configured" line, and re-log any configured voice
  surface now without its key.
- Set takes a value of at least 16 characters with no whitespace (a pasted
  value is trimmed); anything else is refused as `invalid_value`.
- The Groq key cannot be revoked while any host's speech setting names Groq
  with none in its environment (`required`, naming the host): that host
  refuses to start without it, and would not come back up to be given
  another. Replace it instead.
- Patch never asks a person to set an environment variable, and an agent relaying a refusal never does either. Every message that reaches a surface names the key ("no Deepgram key is set") and Settings → Providers as where to add it, never the variable's name; Settings shows no variable names. The environment remains a source a host can read (above), but only for an operator who chose it. Deepgram, for dictation on the `deepgram` engine, is set there like every other key. `test/no-env-var-prompts.test.ts` fails on any credential variable name in a message.
- A missing key never stops a host, except for that Groq one. Voice refuses
  the surface's sessions (`voice_key_missing`), and a transcription on a
  missing Groq key fails naming where to set it.

## Responsibilities

- Session lifecycle. Spawn, stop, resume agent sessions pinned to folders. Each turn runs in its own process (§ Host restarts) through its chat's provider adapter, without permission prompting by default (§ Permission mode).
- chat_state maintenance. Maintains a live, in-memory struct per chat: last N messages, activity, last-updated timestamp. Updated as events flow. No LLM summarisation — this is raw materialised state. The host reports facts (turn started, turn ended with its outcome, question pending or answered); the chat's status is derived by the server alone (`01-server.md`).
- Record writing. The host is the one writer of each of its chats' records (`01-server.md` § Responsibilities). It numbers each chat's entries (`seq`), persisting the counter after every entry, and sends them through its outbox (§ Host outbox). It keeps no copy of the record for display and never answers a surface's history request. A host taking over a chat continues numbering from the server's high-water mark for it.
- Action execution. Server fires all triggers (cron/webhook/todoist) server-side. The server emits the same event shape a surface would (`chat.spawn_request`, `chat.input`, `notify`, tool_call) — host handles them identically to surface-originated events.
- Notify egress. When a chat calls `patch_notify`, host forwards to the server with routing metadata.
- Cross-chat tool execution. When a chat's agent calls `patch_send_to` / `patch_spawn` / `patch_stop`, the host executes it in-process when the target is on this host, and relays it through the server to the owning host otherwise. Cross-chat reads (`patch_peek`, `patch_history`, chat search) are sent to the server, which answers from its record (`03-wire-protocol.md` § Cross-chat tools).

Public-facing routing and push fanout belong to the server (see `01-server.md`).

## Host outbox

Everything durable the host sends the server goes through one outbox per host:
record entries, the facts the server derives status from, chat state and account
state. Each event is written to the outbox on disk before it is sent, numbered
host-wide. The server acknowledges an outbox position once it has committed every
event up to it (`01-server.md` § Host outbox), and the host then drops those
events. After a reconnect the host resends everything after the last
acknowledgement, oldest first; the server drops a resend it already holds. There
is no per-chat comparison and the server never asks a host for history.

The outbox is the only way a recorded event leaves the host: anything the link
sends that the record keeps goes through it, including what the link's own
callbacks send on connect. A server that does not answer `hostOutbox: true` is
sent none of it; the outbox holds it, said once in the log, until a server that
takes it connects.

A turn's start and end go into the outbox the moment the chat's own log writes
them, with each entry's `nativeRef`, so the end a restarted host writes for a
turn its process left open (`interrupted`) reaches the server too. A server that
does not keep them (no `recordComplete` in `auth.ok`) is sent neither; the
entries still go to it. Chats the host held before the server's record kept
everything are sent once, whole, by the record import (`01-server.md` § Record
import); its progress is `<state dir>/record-import.json`.

A turn runs with the link down: its events wait in the outbox, which survives a
host restart. Live streaming (text deltas, tool progress) is not durable and does
not pass through the outbox. The frames are in `03-wire-protocol.md` § Host outbox.

## One host per state directory

A host takes `<state dir>/daemon.lock` (its pid) before it reads or writes anything, and a second host on the same directory exits at once naming the first. Two hosts on one directory would number the same chats and the same outbox independently, and the server would refuse one of them. A lock whose owner is no longer alive, or that is empty or unreadable (a full disk leaves it so), is taken over with a log line; it is released on shutdown.

## Host identity

Each host has a stable `hostId` issued at registration and a host name,
editable from any surface. It defaults to the name a person knows the host
by: on macOS the Computer Name ("Sam's MacBook Pro"), not the numbered network
hostname; elsewhere the hostname without its domain. Surfaces
label the host by that name ("hetzner", "Sam's MacBook"). The host also reports
its platform and arch, its own version, its provisioned providers and their
versions, its installed optional components, its permission-mode default and its
last-used model.

## Stack

- Node (pinned runtime, shipped with the host artifact), TypeScript, single process.
- Drives each provider through its adapter (§ Provider adapters), each turn in its own runner process (§ Host restarts).
- Local storage, all of it resolved from the host user's `HOME` so it is the same on every start — with two deliberate test-only overrides, `PATCH_HOME` and `PATCH_DAEMON_SOCKET`, which exist so several hosts can run on one box for the multi-host test rig (`18-tech-stack.md` § Testing). An ordinary install sets neither, and nothing in the product writes them: `~/.patch/` (config, credentials, socket) + `~/.patch/chats/<chat-id>/` (per-chat state: `meta.json`, `wake.json` and the `seq` counter) + `~/.patch/outbox/` (§ Host outbox) + `~/.patch/turns/` and `~/.patch/job-runs/` (§ Host restarts) + `~/.patch/threads/{manager,speakers}/` on the Manager host (each special thread's working folder — `06-threads-manager-speakers.md` § Where special threads run). Each provider's own session files stay where the provider keeps them (§ Provider adapters); they are not the record.
- Connects to server via WebSocket. Reconnects with exponential backoff; durable events wait in the outbox during a disconnect (§ Host outbox). See `12-error-and-offline.md`.

## CLI

The CLI surface is defined in `17-cli.md`. The host-local subset:

```
patch host start            # start the service (the installer registers it; this is for manual control)
patch host stop             # stop host; running chats stay alive as orphans until restart
patch host status           # running / last heartbeat / chat count / version
patch host list             # active chats
patch host clean            # remove stale meta.json entries for chats the backend has lost
```

Modelled on `happy host`.

## Session ID capture

The SDK emits a `result` message containing `session_id` on every query. Host captures it from the message stream and persists to `meta.json`.

If a chat does `/clear` or `/compact` mid-session, the SDK rotates `session_id` in the next `result` message; host updates `meta.json` accordingly.

## Context compression

When a chat's context fills up the SDK compacts the conversation and emits a compaction boundary carrying whether it was triggered automatically or by the user, the token count before, and — where the SDK reports them — the count after and how long it took. The host emits that boundary as a `system` `chat.message` whose content is the one-line record of the compression and whose `compaction` payload carries those figures, and records it in the chat's record so it stays with the rest of the chat instead of vanishing on re-entry.

A boundary missing its trigger or its before-count fails the turn, rather than being drawn with invented numbers that would read as measurements.

## Streaming assistant text

Surfaces render the reply progressively, not as a single final dump. The host drives every `query()` with `includePartialMessages: true`, so the SDK emits `stream_event` partials carrying `text_delta` chunks as the model produces tokens, ahead of the turn's final `assistant` message. The daemon:

- Reserves the seq the finalising `chat.message` will carry on the first text delta of a turn.
- Fans out each chunk as a transient `chat.message_delta { chatId, messageSeq, delta }` live event (no own `seq`, mirroring `audio.transcript_partial`): NOT persisted, NOT part of the record.
- Emits the durable `chat.message` at that same reserved seq when the turn's final `assistant` message arrives — this is the record entry every reader sees.

A surface accumulates deltas keyed by `messageSeq` to render the reply chunk-by-chunk, then the matching `chat.message` supersedes the accumulator. An aborted/errored turn drops its unfinalised accumulator (the reserved seq is simply skipped — readers order by seq, not contiguity).

## Background work

A shell command the agent asks to run in the background belongs to the agent process, which ends with the turn — so it would be killed moments later having produced nothing, and the agent would end its turn believing work was under way. The host refuses the background request and tells the agent why, so the choice is corrected rather than silently lost.

Subagents are Patch-owned. Where the provider can switch off its native subagent tools (Claude Code's `Agent` and `Workflow`), they are switched off (§ Provider adapters): their process-tree lifecycle and background mode sit outside Patch's durable chat accounting. Agents instead receive `patch_agent`, backed by the host's own child-chat machinery. Where a provider cannot switch its native one off, `patch_agent` is off for its chats.

### Patch-owned `patch_agent` subagents

`patch_agent({ prompt, model?, folder?, account?, disallowedTools?, background? })` gives an agent a real Patch-owned child: a durable worker that runs `prompt` to completion and hands its full final reply directly back to the chat that called it (the PARENT), never through `patch_send_to`. It is built on the host's own chat machinery rather than being a second implementation of a chat: a subagent IS an ordinary chat — same `meta.json`, same provider session, same turn queue, same restart reattach — with one extra field, `meta.subagent: { parentChatId, label, outcome? }`, that is never cleared.

That one field does three things:

- Lifecycle. The subagent's turn runs exactly like any other chat's. The moment it settles — idle with nothing queued (success), or failed with no retry armed (an SDK error, or a usage limit it cannot get past) — the host stamps `outcome` (`done`/`failed`) once, and delivers a `[from <label>]`-prefixed message into the PARENT as a new turn, queuing behind a running parent turn like any other host message (`04-chats-and-folders.md` ## Message queueing). A failure delivers the same way, naming what went wrong — never silent. Stopping or archiving the parent stops every one of its subagents that has not already settled (`outcome` stamped `stopped`, nothing delivered — the caller already knows). Several subagents can run under the same parent at once; each is an independent chat.
- Task/Agent semantics. By default the call blocks until the child settles and returns `{ id, label, status, reply }` as its tool result. With `background: true` it returns `{ id, label }` immediately; Patch owns the continuing child and delivers its final reply into the parent when it settles. `disallowedTools` is the child's capability limit, persisted on `meta.subagent.disallowedTools` and added to the always-disabled set for every turn it runs.
- Account. The child follows the parent's account lock, else the shared account order with its usual failover (`10-auth.md` § Backend credentials). `account` (id or label, as for `patch_spawn`) locks it to one stored account instead; one the machine does not hold is refused. A waited result carries `account`, the label of the account the child's last turn ran on.
- The parent stays alive for it. While any of its subagents has not settled, the parent counts as still working, like one with a running `patch_watch`: a hidden parent does not archive itself, and an active goal is not evaluated (it re-checks once they have delivered).
- Durability. Because a subagent is an ordinary chat, a host restart reattaches its in-flight turn exactly as it would any other chat's, and the delivery above fires whenever that turn settles — there is no separate subagent-restart path to get wrong.
- Invisibility. Every surface that lists, searches, or notifies about chats excludes a chat carrying `meta.subagent` — not in the sidebar, Hidden, Archived, or search, no badges, no notifications, no needs-attention, never marked unread. The ONLY way in is the parent's own transcript: the `patch_agent` call renders as a tool-call row carrying the subagent's live state (running / waiting for the user / done / failed / stopped) and a link to open its transcript read-only (`14-design-web.md` § Main chat panel — Delegate tool row).

Permissions follow the parent, not a separate mode: a subagent is stamped with the parent's permission mode at creation, like any spawn. A subagent never raises an approval to the user: if its turn reaches a tool approval — including its own `AskUserQuestion`, which arrives through the identical `canUseTool` gate — the request is denied at once with a message telling it to carry on without the call and say in its final reply what it needed, so the parent (which reads that reply) decides. Nothing is mirrored onto the parent's transcript and no card is shown. A subagent itself has no way to reach the user directly: `patch_notify`, `patch_report`, `patch_call`, `patch_speak`, `patch_ask_human` and `patch_artifact` are disabled for its turns on top of whatever the user has toggled off — talking to the user is the parent's job.

Work that genuinely outlives a turn belongs to the host. `patch_watch` starts a command the host owns: it runs in its own process group, its output is retained, and it survives the turn that started it and the chat going idle. `patch_watch_list` reports what is in flight, `patch_watch_output` reads what a run has produced so far, and `patch_watch_stop` ends one and everything it started. When a run finishes the host delivers the outcome into its chat as a turn, the same way a self-wake is delivered.

A run is persisted per chat, so a host restart re-adopts it; one whose process did not survive the restart is reported as failed rather than left pending for ever. One that finished while no host was attached is delivered by the next host with its real exit code and output, exactly as if the host had been there, and a `wakeOnMatch` line printed meanwhile is delivered once, from the persisted scan offset. Runs ride on chat state, so a surface shows what a chat has in flight without asking the agent.

## Background task completions

The agent runs sub-agents in the background. When one finishes, the SDK reports it on a user message carrying a `<task-notification>` block whose summary is a readable sentence naming the task and how it ended. The host puts that sentence on the transcript as a system message, so the completion is visible in its own right rather than only as the agent abruptly reacting to it.

The sentence names the task and how it ended — completed, failed, stopped or killed, carrying the process exit code where the task was a process. The wordings are the agent layer's, not ours, and the list is not closed: a sentence naming a task and ANY outcome ends that task, under the outcome it spells out where that is one we read exactly and under `ended` where it is not. Being unable to read a phrase must never leave the task it ended reading as still running, which is what an enumerated list of wordings did (`principles.md`). It is passed through unchanged: it is what surfaces read to render the completion (`14-design-web.md` § Background task completions), and it stands on its own where a surface does not. A block carrying no summary surfaces nothing — there is no sentence to invent.

While a background task is still running, the agent layer streams its output to a file on the host, under a per-session `tasks` directory named by the background id the launch reported (`/tmp/claude-<uid>/<project>/<session>/tasks/<id>.output`). A backgrounded command appends to it as it runs; a backgrounded sub-agent's is its transcript, so one lookup covers both kinds. A terminal session (§ Terminal sessions) is started by the same host on the same host, so following that file is how a surface shows what a running background task is doing (`14-design-web.md` § Main chat panel — Background task bar). The host neither creates nor parses these files.

The host answers a surface's request for what a set of running background tasks are costing the host, named by those same background ids. Every process in a backgrounded command's tree holds that task's output file open as both its standard output and its standard error, so the processes holding that file open are the task's processes; the task's cost is theirs summed. CPU is each process's share of one core averaged over its own lifetime, as the host's process table reports it — an average rather than an instant, because a number resampled every few seconds jitters without saying anything a reader can use. Memory is resident set size, which is current by nature.

A task with no such process is reported as unmeasured, not as zero: a backgrounded sub-agent runs inside the agent process and only links its transcript into the tasks directory, and a command whose processes have already exited leaves the file behind. Zero is a measurement, and a task that is genuinely working must never be indistinguishable from one that could not be measured (`principles.md`).

The host also counts how many of each chat's background tasks are still running, and reports that count on the chat's state (`03-wire-protocol.md` ## Event categories). It tracks them from its own outgoing stream: a `run_in_background` call starts one, a completion notice ends one, and an explicit kill ends one, paired by the same rules a surface uses (`14-design-web.md` § Main chat panel — Background task bar). A surface holding many chats has the transcript of none, so this count is the only way the list can tell a chat that has finished from one that settled idle with work still in flight. It is in memory only and is rebuilt from a reattached turn's stream after a host restart; a background task belongs to the agent process that launched it, so a turn whose process died leaves none running. The count is reported on every state emit, zero included, so a surface can tell a host that counts them and reports none running from a host that does not count them at all.

A `patch_watch` task must be given a `timeoutSec`; the host kills the task's whole process group when it is exceeded and delivers a `[watch]` message saying it timed out. Whatever the task prints is its progress: the last non-empty line of its output, and when it was written, are reported with each task so a surface can show it beside the elapsed time (`14-design-web.md` § Main chat panel — Background task bar). A task that prints nothing for an hour is flagged amber on the bar. A task may also be started with `wakeOnMatch`, a regular expression: while it keeps running, each complete output line that matches wakes the owning chat with a `[watch]` message carrying the matching lines (batched per poll, at most 20 per message), for monitors that stay up after an alert. Output is scanned incrementally from a persisted offset, a half-written line is never matched, and an invalid expression is refused when the task starts. The exit message is unaffected. At each check-in interval a task is still running (default one hour, a host setting; the agent may give a different `checkInMinutes` when it starts the task, and the user may change it from the bar, which restarts the clock), the host sends the owning chat a `[watch]` check-in asking whether it is still working as intended; the prompt text is a setting too, with `{description}`, `{running}`, `{lastOutput}` and `{taskId}` filled in. Each running task reports when its next check-in is due, and the bar shows it as `next check-in at HH:MM`; clicking it opens a field to change the interval. The interval and the prompt are host settings.

## Stray processes

A chat can start work that no tracked tool knows about: `nohup long-thing &` inside a plain Bash call is neither a `patch_watch` task nor a refused background request. The shell exits, the process is adopted by init and keeps running. The host answers a surface's request for these, so the user can see that something is running and stop it.

A chat's shell commands carry `PATCH_CHAT_ID` in their environment. An environment survives reparenting and `setsid`, where a process group or session does not, so it is the handle. A stray is a process carrying the chat's id whose parent is no longer one of the chat's own processes AND which has been adopted by init or a subreaper. The second condition is what keeps the agent process itself (parent: the host or the durable runner), its MCP servers and any command still running inside the tree out of the list.

Each stray is reported with its command line, when it started, and whether it is still running. The host remembers each stray it has seen, in memory only, so one that exits is reported as ended, with when the host noticed, rather than vanishing; the last twenty ended are kept per chat. The ended time is the host's observation, not the process's own. A request may name a pid to stop: the host stops it, and everything it started, only if that pid is currently one of that chat's strays, and answers `stopped: false` otherwise, so a surface cannot make the host signal an arbitrary process.

Detection reads `/proc`, so it is Linux only. NO FALLBACK: on a host without it the request fails with `unsupported_platform` rather than answering with an empty list, which would read as "nothing is running". A surface treats that as "this host cannot tell" and shows nothing; any other failure it shows.

Nothing else on a user message is chat-visible. Tool results and the turn's own prompt echo arrive the same way and are not transcript entries.

## Output style

Patch shapes no output style. The only system-prompt content it sets is the patch-tools guidance (`principles.md` § No hidden prompt content). The model's default style stands. If the user wants to shape it (no emoji, terse voice replies, etc.) they do so in the CLAUDE.md of the chat's folder, which the agent reads itself — nothing in the platform layer invisibly steers the agent.

## Per-turn process / warm sessions

Each turn runs as a fresh agent process: it spawns, runs the turn, and exits. The spawn costs a couple of seconds — unnoticeable in a typed chat, and the dominant cost of a spoken one.

So a chat in a voice call holds one warm agent process instead, opened when the call starts and closed when it ends, paying the spawn once per call rather than once per utterance. Nothing else uses one. A chat outside a call gets a fresh process per turn, and so do the host's own title and status turns, which never join a chat's session.

A warm session takes the chat's settings — folder, model, permission mode, disabled tools, system prompt, skills, and the session it resumes — when the call starts, and keeps them for the call. A change made elsewhere while a call is running applies to the next call, and a surface offering that change says so rather than appearing to take effect. Branching a chat ends the call's session: it changes which session the chat continues, and a warm process cannot follow them.

Barge-in interrupts the running turn and leaves the session warm. An interrupt that does not land promptly ends the session instead, so a stop is always honoured and a wedged agent can never leave a chat unable to start another turn.

The session ends when the call ends, when the chat's folder changes, when the chat is deleted, when a turn fails, and when the host shuts down. Ending it stops the agent process and everything it started.

A message the agent harness generated is not a message the model wrote, and is never rendered as one. Claude Code injects its own turns — stamped `model: "<synthetic>"` with zero input tokens — and on resuming a session whose last turn died it answers its own `Continue from where you left off.` with something like `No response requested.`. Shown as the assistant's reply, that is a turn which produced nothing reading as a turn which answered: the silent success this app has no room for. A synthetic assistant message is shown instead as a muted `system` line flagged `synthetic` (`03-wire-protocol.md`), attributed to Claude Code: the gap stays visible without the agent's name on it. A surface names the `No response requested.` placeholder `Turn interrupted` and quotes it; any other synthetic reply is quoted as what Claude Code inserted. A compaction notice, which arrives the same way, keeps its own compaction line. The marker must be PRESENT to fire: a provider that carries no such marker is not synthetic, and relabelling its replies would be the worse bug. The line is an entry in the chat's record, so reopening a chat shows it exactly as it did live. A placeholder Claude Code writes into its own session without sending it over the SDK stream is not shown: Patch does not read the session (§ Provider adapters). Claude Code also sends these placeholders back to the model on later resumes; that is the provider's behaviour and is left as is.

A turn the agent could not complete is recorded as a failed turn, whether or not the agent process exited. A warm agent reports a refused request — a spend or rate limit, a rejected credential, an invalid session — by ending the turn normally and putting the refusal in its reply, so a host that only watches for a process to die reads a failure as a finished turn and prints the refusal as though the agent had said it. The refusal is a failure: it parks and retries where the cause is transient, and surfaces as the chat's error otherwise.

## Self-wake

A self-wake lets a chat ask the host to re-invoke itself after a delay — "in 10 minutes, deliver this message back to me as a new turn". It's the primitive behind self-rescheduling reminder/check loops (e.g. a go-to-bed nag that fires every 10 minutes from 10pm until you acknowledge, then stops), and behind a fixed-cadence loop that never needs re-arming at all (e.g. "check on the build every 5 minutes").

Why the host owns it, not the agent. The agent can't usefully wait inside a turn (it would hold the SDK `query()` open and die on a restart), and the agent's native `CronCreate` does not work here: a turn runs to completion and ends, no agent process outlives the call it belongs to, and the host wires no agent cron/hooks — so an in-session cron has nothing to fire it. Because a visible-but-dead tool is a trap, the adapter switches off the `Cron*` family (§ Provider adapters), so the agent only ever sees `patch_wake_me` and `patch_loop`. Instead: the agent calls one of them and ends its turn (no blocking). The host holds the timer; when it fires, the host delivers the message into the same chat exactly like any input, resuming the provider session. (If the chat is mid-turn, a plain `patch_wake_me` wake is held, marked `waiting`, and delivered once when the turn ends rather than queued behind it; one pending wake per chat, so a held wake is never duplicated. A `patch_loop` tick is absorbed instead: see "count the interval from the end of the turn", below.)

Durable. The pending wake is persisted per-chat at `~/.patch/chats/<chatId>/wake.json` (atomic write). On host restart, every persisted wake is re-armed; a wake whose time passed during downtime fires once on boot (catch-up — the agent's own clock-check decides if a late wake is still relevant), and one past its optional `notAfter` cutoff is dropped. This is the durability `CronCreate` (in-process, dies with the turn) cannot provide.

One-shot + adaptive loop, or `patch_loop`. A plain wake fires exactly once, then the file is cleared. To loop adaptively, the agent calls `patch_wake_me` again on each fire with whatever next interval it decides — the cadence is the agent's own choice ("in 10 min", "in 20 min", escalating), not a fixed cron. This depends on the agent's behaviour each cycle: if a turn errors, or the agent simply doesn't get around to re-arming before the turn ends, the loop silently stops with nothing saying so. `patch_loop({ message, every, notAfter? })` is for the common case where that dependency isn't wanted — a fixed cadence, decided once — and removes it: the host itself re-arms `fireAt = now + every` every time the record fires, instead of clearing it, so the cadence is mechanically guaranteed rather than agent-remembered. One pending wake per chat either way (a loop and a plain wake share the exact same `wake.json` slot — both are "the host will deliver a message into this chat later", so arming one replaces the other). The agent stops an adaptive loop by doing nothing further; either kind is stopped early with `patch_cancel_wake` — there is no separate tool to stop a `patch_loop`, because a recurring wake is still just a pending wake, one that happens to re-arm itself.

A loop's `every` counts the interval from the END of a turn, not from whenever a tick happened to land. A tick that comes due while the chat's pump is already occupied — an unrelated turn still running, or (the common case when a turn outlasts `every`) the turn the loop's own previous tick started — is absorbed, not queued: the host marks the record `waiting` and arms nothing further, so a turn far longer than `every` is never followed by several identical `[wake]` turns queued up to run back to back once it finally settles. The moment that turn actually ends, the host arms a fresh `fireAt = now + every` from then — "every 3 minutes" means 3 minutes of quiet between checks, not a tick stacked for every 3 minutes the chat happened to stay busy. `waiting` is persisted on `wake.json` alongside the rest of the record, so it survives a host restart: a loop found `waiting` on boot re-arms immediately, since from the fresh process's point of view whatever turn it was waiting on is, one way or another, over. A plain `patch_wake_me` is held the same way but delivered once at turn end, not re-armed.

Tools (see `06-threads-manager-speakers.md` § Cross-chat tools): `patch_wake_me({ message, in | at, notAfter? })` — exactly one of `in` (relative: `"10m"`, `"1h30m"`, seconds, or `PT10M`) or `at` (absolute ISO 8601, computed by the agent in the user's TZ); `patch_loop({ message, every, notAfter? })` — `every` is the same relative-duration grammar as `in`, and the first fire is one `every` from the call (then that cadence forever, or until `notAfter`/cancellation); `patch_cancel_wake()` stops whichever of the two is pending. Delivered turns carry a `[wake]` prefix, as metadata-as-data like `[voice • …]` (see `principles.md`), for both kinds alike. Re-arming never silently moves the clock: an identical `patch_loop` (same message, cadence, cutoff) keeps the existing `fireAt` and says so; a different one replaces it and the result reports what was replaced and the new fire time. `patch_wake_status()` reads the pending wake/loop without touching it.

A surface can arm or stop a loop too, not just the agent: `/loop <interval> <message>` typed in the composer sends `chat.loop_request` (`03-wire-protocol.md`), which reaches the identical `scheduleWake`/`cancelWake` calls `patch_loop`/`patch_cancel_wake` reach — a bare `/loop` cancels. This is unlike `/goal`/`/remind`, which are pure user-owned banner state with no agent-tool equivalent; a loop needs to land on the real scheduler, since the agent can arm, see, and stop the very same one.

A pending wake is a scheduled future turn in the user's chat, and is visible as such: the host carries it on `chat.state` as `pendingWake` — `{ message, fireAt, notAfter?, every?, waiting? }`, or `null` when nothing is armed — read straight from `wake.json` on every state emit, so it is correct after a restart and after a catch-up fire. `every` (ms) is present only for a `patch_loop` record; its absence is what tells a surface this is the plain one-shot kind. `waiting` is present (and `true`) only while that loop is absorbing a tick, per the above — `fireAt` is stale then, so surfaces read `waiting` instead of trusting a countdown to a time that isn't real yet. State is re-emitted the moment a wake is scheduled, replaced, cancelled, or fires, and the moment a loop's `waiting` tick is absorbed and the moment it's re-armed on turn-end — a firing `patch_loop` record re-emits too, since its `fireAt` just moved (a firing plain wake clears to `null` instead, as the delivered turn lands). Surfaces render it as a bar above the chat showing the countdown to `fireAt` and the wake message, or "waiting for current turn" in place of the countdown while `waiting` is set (`14-design-web.md` § Main chat panel). Every wake's bar carries a dismiss (×) control and an edit control, since a wake is as likely to be watched by the user as armed by the agent and either can cancel it. Dismiss cancels (`chat.loop_request` with `loop: null`). Edit opens a roomy modal with the message in a large text area plus the interval (loop) or fire time (one-shot); saving re-arms through the same request, replacing the pending wake, and an unchanged fire time is kept exactly.

Self-wake vs job vs `CronCreate`: a job (`08-triggers-and-jobs.md`) is an externally-defined schedule that fires into a usually-new chat (durable, server-side); a self-wake is a chat re-invoking itself, adaptive or fixed-cadence, and self-terminating or explicitly cancelled (durable, host-side, per-chat); `CronCreate` is the agent's in-session timer — unavailable in the host's session model, so Patch provides self-wake in its place.

## Task list

The agent tracks its work with Claude Code's native TodoWrite tool. The host observes those tool calls and mirrors the list onto chat state as `todos` — `{text, status}` per item, status ∈ pending / in_progress / completed — carried on `chat.state` so every surface can show what the chat is working through (`14-design-web.md` § Main chat panel). The mirror follows the agent's list and is not persisted: a rehydrated chat starts empty until its next TodoWrite.

History: the agent's TodoWrite replaces its whole list, so the mirror keeps the items finished earlier that a new list no longer names, ahead of the new items, so the list stays a record of what was done.

Keeping the agent on the list. When a turn settles idle with items still incomplete, the host fires the head incomplete item back into the chat as a fresh `[todo]`-prefixed turn, so the agent works one focused item at a time instead of drifting. The fired turn's visible text says the line is one of the agent's own TodoWrite items and asks it to mark it in_progress now and completed once it is done; without that cue the agent does the work and leaves the item reading pending for ever.

An item already fired that comes back still incomplete is not re-fired — the agent stopped for a reason (usually a question for the user), and re-firing would steamroll the user's turn. A whole turn was spent on it, so the host marks it in_progress rather than leaving it reading pending, which would claim it was never started. The host never marks an item completed: only the agent or the user closes one out.

The user owns the list too. A surface rewrites it — edit an item's text, change its status, add or delete items — with `chat.todos_request`, which carries the whole list; the host adopts it wholesale, emits `chat.state`, and the auto-advance above then fires from the edited list. The agent's own TodoWrite state lives inside its session and cannot be written from outside, so the host tells it instead: the next turn on that chat begins with a visible note, part of the user's message in the chat's record, naming the current list and asking the agent to call TodoWrite to adopt it. Without it the agent's next TodoWrite would silently overwrite the user's edit. The note is one-shot: it goes with the next turn and is then cleared. A task-list item may carry `attachments` (the same refs a composer send carries) beside its `text`: the user queues it from the composer's send menu, "Add to todo list" (`14-design-web.md` § Composer), which uploads the files and appends the item instead of sending, so an item can stand in for a whole prompt. When the item fires, the host sends its attachments with the `[todo]` turn; the agent's own TodoWrite carries none, so when the host mirrors a TodoWrite it keeps the attachments of the previous item with the same text. Surfaces queue new items in a local draft and send them in a single `chat.todos_request` when the user finishes entering them, so the host only ever sees the completed batch; the draft is never on the wire.

## MCP server

Patch ships a stdio MCP server. It is not registered in the agent's user-scope config — instead, every SDK `query()` the host makes passes an inline `mcpServers` option:

```ts
mcpServers: {
  patch: {
    command: 'node',
    args: [patchToolsServerPath],
    env: {
      PATCH_CHAT_ID: chatId,
      PATCH_DAEMON_SOCKET: '~/.patch/daemon.sock'
    }
  }
}
```

The SDK launches that script as a child process for the duration of the query. The MCP child reads `PATCH_CHAT_ID` from env on startup and tags every tool call with it. To execute side effects (look up other chats, fan out a notification, modify a job), it talks back to the host over `PATCH_DAEMON_SOCKET` — a Unix domain socket the host owns. The host holds all state; the MCP child is a thin wire.

Auth is the same for every caller of the socket (§ Control IPC): the MCP child is given `PATCH_DAEMON_LOCAL_KEY` alongside `PATCH_CHAT_ID` and presents it as a `Bearer` on each call. Host, MCP child and the agent's query all run as the same user on the same host, so the key is defence in depth over the `0600` socket rather than a trust boundary in itself. The host still identifies the child by the env it set, not by the key.

Identity is plumbing, not call-time. Each query gets a fresh MCP child with `PATCH_CHAT_ID` baked into env. The chat agent doesn't pass its own ID, the model doesn't echo it, no header parsing — the MCP child knows which chat it is from the moment it boots.

No mutation of `~/.claude.json`. The user's agent config stays untouched. Patch's MCP exists for the lifetime of patch-driven queries.

No tool-surface scoping. Every chat gets every tool. A coding chat can in principle call `patch_spawn` or `patch_job_create`; nothing in its prompt will steer it there.

### What else a chat gets, beside `patch`

By default a fresh host adds nothing beyond `patch` itself — Settings → MCP seeds a host with the `playwright` + `chrome-devtools` pair `disabled`, so nothing but `patch` reaches a chat until a user turns one on.

Two more sources feed the same `mcpServers` option, both merged in by the host rather than left to the SDK (which does not merge them itself):

- The host's own list (Settings → MCP, `harnessMcpServers` in `host.json`) — servers the USER told Patch to add, editable through Patch's own settings tools, never by hand-editing a file. Only the `enabled` entries reach a chat.
- Claude Code's own config — servers the user already told the `claude` CLI to add, outside Patch entirely: `~/.claude/settings.json` → `mcpServers`, `~/.claude.json`'s global and per-project `mcpServers`, and a project's `.mcp.json`, the last gated on that project already appearing in `~/.claude.json`'s `enabledMcpjsonServers` (i.e. a human has trust-approved it on this host at some point — an unapproved `.mcp.json` entry is not one Claude's own process would run unattended either, so Patch doesn't run it unattended). Read-only, same as the "no mutation" rule above.

Merge order into a chat's `mcpServers`: `patch`, then Claude Code's own discovered servers, then the host's enabled list — a name in both wins from the host's list, since that is the one the user can see and edit inside Patch.

## Control IPC (local CLI ↔ host)

`patch <subcommand>` invoked on the host itself (e.g. while SSH'd in) talks to the running host over a Unix domain socket at `~/.patch/daemon.sock` (HTTP framing over the socket), not via the public WebSocket. The socket path is fixed under `~/.patch`, so the local CLI finds it without a port-discovery file. The socket is created mode `0600` (owner-only).

| Endpoint                         | Verb | Purpose                                                                        |
| -------------------------------- | ---- | ------------------------------------------------------------------------------ |
| `/list`                          | GET  | Active chats                                                                   |
| `/spawn-chat`                    | POST | Spawn a new chat in a folder                                                   |
| `/stop-chat`                     | POST | SIGTERM a tracked chat                                                         |
| `/stop`                          | POST | Shut the host down                                                             |
| `/host`                          | GET  | This host's self-description — the same content as its `host.host` report      |
| `/folders`                       | GET  | This host's folder registry                                                    |
| `/folders/add`                   | POST | Designate a project root                                                       |
| `/folders/remove`                | POST | Drop a designated project root                                                 |
| `/backends`                      | GET  | Each backend's version and this host's view of its shared accounts             |
| `/models`                        | GET  | This host's model catalogue across its backends                                |
| `/components/install`            | POST | Install an optional component                                                  |
| `/components/remove`             | POST | Delete an installed component                                                  |
| `/claude-settings`               | GET  | This host's Claude Code settings.json text and memory entries                  |
| `/claude-settings/memory/delete` | POST | Delete one memory entry                                                        |
| `/claude-settings`               | POST | Replace settings.json with `{text}`; text that is not a JSON object is refused |
| `/update`                        | POST | Apply an available host update                                                 |

Below the chat endpoints, the socket carries every host-scoped control of
`03-wire-protocol.md` § Host events that this host owns, one endpoint per
frame, because the CLI's default host is the host it runs on (`17-cli.md`
§ Hosts and the CLI) and those commands must work there without a round trip
through the server. A host-scoped control added to the wire gains its endpoint
here in the same change. Shared settings are not host-scoped and have no
endpoint here: the CLI changes them through the server wherever it runs
(`01-server.md` § Settings). Three host controls are reached over HTTP too, even
when the CLI is invoked on that host, because the server owns them rather than
the host: minting a registration code for a new host, renaming a host, and
revoking one.

Requests carry a `Bearer` local key — a defence-in-depth measure over the OS-level same-host/same-user trust the `0600` socket already provides (cheap to add, closes the case where another local process can reach the socket). When the CLI runs on a different host, it goes via the WebSocket server, not this IPC.

The host is the only party that mints that key: it generates one on first start and keeps it at `~/.patch/local.key` (mode `0600`, beside the socket), rotating it on each start. It passes the current value as `PATCH_DAEMON_LOCAL_KEY` in the environment of the children it starts, and every other caller on that host — the CLI a person runs there — reads the file, which the fixed path under `~/.patch` makes findable without discovery.

## Terminal sessions

The host owns the project filesystem, so it also owns the shell. A surface
can open a terminal session against a folder and drive it over the wire — the
escape hatch for the things the agent is not the right tool for: `git clone`ing
a repo into a project root so a chat can be opened in it, `pnpm install`, a quick
`ls`. Without it a remote host is a closed box: there is no way to put a new
folder on it from a surface.

- A session is a long-lived shell process (`$SHELL`, else `bash`) started
  with `cwd` = the requested folder, stdin/stdout/stderr piped. Long-lived, so
  `cd` and shell state persist across commands, exactly like a real terminal.
- A named folder is validated the same way a chat spawn is — it must exist
  on the host. A missing one is a loud `folder_not_found`, so a shell always starts where the
  caller asked.
- Omitting the folder is a different, explicit request — "a shell anywhere I
  can work" — used by the new-chat terminal, where no folder exists yet (that
  being the reason a shell is wanted). The host starts it in the first
  published project root that exists — where a clone is actually going — and
  falls through to `$HOME` only if it has no usable root. Either way `ready.cwd`
  reports the real directory, so the surface displays the path in use.
- Input is raw: whatever the surface sends is written to the shell's stdin
  verbatim. Output is raw: stdout and stderr are streamed back in chunks as
  they arrive, tagged with which stream they came from. The only bytes the
  host interprets are its own completion sentinel, below.
- Command completion is reported. A pipe shell prints no prompt and echoes
  nothing, so a command that produces no output — `cd`, `export`, `mkdir` —
  would otherwise be indistinguishable from one still running. Each session
  mints a random marker when its shell starts, and every input ending in a
  newline is followed on the same stdin by a command that prints that marker
  with the preceding command's exit status. The host strips the marker line
  out of stdout, so it never reaches the surface as output, and reports the
  status instead. Input that does not end in a newline is a partial line and
  gets no sentinel.
- Stripping the marker means holding back only those trailing stdout bytes that
  could still turn out to be the start of one, since the marker can straddle a
  chunk boundary. Everything else goes out as it arrives: a prompt written with
  no trailing newline must still appear immediately. stderr is never held.
- A command that reads stdin itself, or a multi-line construct typed line by
  line, consumes the sentinel rather than the shell, so it reports no
  completion until it exits. It stays reported as running, which is true.
- Output and completions are reported in the order the shell produced them. One
  chunk routinely carries the tail of one command's output, its sentinel, and
  the start of the next, so reporting the completions separately would file a
  failure above the error that earned it — or, on a chunk that lands mid-line,
  between the two halves of one message.
- Interrupt is a separate signal frame (`SIGINT`) delivered to the shell's
  process group, so a runaway command is killable without killing the session.
- Lifecycle: the session ends when the surface closes it, when the shell
  exits (exit code reported), or when it goes idle for 30 minutes. The shell
  runs under its own process, so a host restart leaves it running and the host
  reattaches (§ Host restarts), delivering the output produced meanwhile. A
  machine restart ends every session, and the surface is told.
- Limits: there is NO cap on concurrent sessions per host. A count of shells
  bounded nothing worth bounding — an idle session is one piped `bash`, and the
  real cost is what a session runs — while the slots it did withhold were easy
  to exhaust by accident, since closing the drawer keeps the shell alive and a
  reloaded surface strands its old session until the idle timer reaps it. The
  idle timeout is what bounds accumulation. A per-session output rate cap
  remains, so a `yes`-style firehose cannot flood the link.
- This is not a sandbox. A terminal session runs with the host's own
  privileges — the same privileges the agent already has on that host. It adds
  no new authority, and it is reachable only by an authenticated surface.
- Git identity is the user's own: the host runs as them, so `~/.ssh` and
  `~/.gitconfig` are already in place and a private clone authenticates as it
  would in their terminal. `GIT_TERMINAL_PROMPT=0` is set, so a credential prompt
  on a session with no TTY fails immediately.

By default a session is a pipe shell, as above, so full-screen curses programs
(`vim`, `htop`) and password prompts that demand a TTY do not work in it. That
is the web drawer's trade: its use case is clone/install/inspect.

### PTY sessions

An open that carries a window size (`pty: {cols, rows}`) gets a real
pseudo-terminal instead, for a surface that draws with a terminal emulator (the
phone's host terminal, `15-design-mobile.md` § Host files and terminal). The
shell is a login shell (`$SHELL -l`, else `bash -l`), like an ssh session, so
the user's profile puts their own tools on PATH. It echoes, prompts, completes
on Tab and runs full-screen programs.

- The PTY is allocated by a small python3 runner the host starts — no native
  module. python3 is present on every host the host runs on; a host where the
  runner cannot start answers `pty_unavailable`, never a pipe shell instead.
- The runner is detached from the host and owns the shell. Everything the shell
  prints goes first to an output log in `<patchHome>/terminals/<session>/`, and
  the host talks to the runner over a unix socket in the same directory, so a
  host that is not there loses nothing (§ Surviving a host restart).
- `ready` carries `pty: true`. A surface that asked for a PTY and gets a ready
  without it is talking to a host that predates the field and opened a pipe
  shell; it refuses the session and closes it.
- `TERM=xterm-256color`. `GIT_TERMINAL_PROMPT` is not set: a terminal can answer
  a credential prompt. When the host's environment names no locale at all, a
  UTF-8 character type is declared so the shell does not fall back to ASCII.
- Output is one stream, raw terminal bytes, decoded as UTF-8 without splitting
  a character across chunks. There is no completion sentinel and no
  `command-exit` — the prompt says when a command is done.
- Ctrl-C (`signal`) is the ETX byte written to the terminal, so the line
  discipline interrupts the foreground job exactly as a keyboard would.
- `resize` sets the window size, which is what sends the foreground program its
  SIGWINCH. A resize for a pipe session is refused with `not_a_pty`.
- Folder validation, the idle timeout, the output rate cap, the lifecycle and
  the privileges are those of every session, above.

#### Surviving a host restart

A host restart leaves a PTY session's shell and its running programs alone
(§ Host restarts). Only PTY sessions do: a pipe shell is a child of the host and
ends with it, with `daemon_shutdown`.

- On stop the host lets go of each runner without ending it. On start it reads
  `<patchHome>/terminals/` and reattaches each session to the surface that
  opened it, delivering the output printed since the last byte the previous host
  handed over (the host records that offset beside the session, so nothing is
  delivered twice and nothing is skipped). Replayed scrollback is not subject to
  the output rate cap.
- A surface that opens the `sessionId` of a session the host has running gets
  that shell, not a new one: `ready`, then the whole scrollback drawn again, and
  the same shell state.
- The log keeps the last 2 MiB of output once it passes 4 MiB. Offsets stay
  absolute, so a host asking for output that was trimmed is given what remains.
- A shell that ended while no host was attached is reported on start: its last
  output, then `exit` with its status and `shell_exit`. A runner that is gone
  with its shell and no record of it ending (the machine restarted) is reported
  as `exit` with a null code and `daemon_shutdown`; the surface offers Restart.
- A runner with no host attached for 30 minutes ends its shell, so an orphaned
  terminal does not outlive the user's interest in it. The idle timeout applies
  as before once a host is attached.
- The server keeps a PTY session's route when its host goes offline and tells
  the surface nothing while the host is away: a restart is a blip, not an end.
  When the host returns, what the surface sees is the host's own reattach
  report, an `exit` for each shell that ended while away and the output
  printed meanwhile for the rest. Only a host that has not returned within two
  minutes of being announced offline has its PTY sessions reported lost, each as
  `exit` with a null code and `daemon_shutdown`. A pipe session is reported at
  once, because it died with the host.
- A surface holding a PTY session asks for it again by `sessionId` when its host
  comes back, and when its own link to the server returns. The reply is `ready`
  and the whole scrollback, which replaces what the surface has drawn (the phone
  clears its emulator on that `ready`). A session reported lost reopens the same
  way and gets a fresh shell under the same id. The web drawer uses pipe
  sessions only, so it keeps ending and reopening on a host restart.
- A session record that cannot be read is discarded. The scrollback is on the
  host's disk, readable only by its user.

## Host files

A surface can list, read and write files on a host by absolute path, with no
chat in between (`03-wire-protocol.md` § Host files). The chat-scoped file
browser resolves every path through a chat's folder; this is how a file outside
every chat — a skill under `~/.claude/skills`, a dotfile — is reached: opening
the file browser without a chat at all, or climbing a chat's own browser above
its folder (`14-design-web.md` § File browser).

- It is not confined to the project roots. A surface that can reach this can
  already open a terminal on the host, which reaches every file the host's
  user can, so a narrower file API would guard nothing.
- A path must be absolute and already normal (no `.` or `..` segments, no
  doubled or trailing slash); anything else is `path_invalid`, never resolved
  against something the surface did not name. A `list` with no path lists the
  host user's home directory and reports its absolute path.
- A listing shows every entry, hidden ones included, directories first. A
  symlink is listed as what it points at; a dangling one as `other`.
- `read` returns UTF-8 text up to 1 MiB, with its `version` — the SHA-256 of
  the bytes on disk. A directory, a binary file or a larger file is refused with
  its own code rather than opened mangled or truncated.
- `write` replaces an existing file's whole content and must name the `version`
  it was edited from. If the file on disk no longer matches, the write is
  refused with `conflict` and nothing is written. It never creates a file. It
  writes through a symlink to its target, keeps the file's mode, and commits
  atomically (temp file, fsync, rename), so a concurrent reader sees the old
  file or the new one.
- A committed write inside a chat's folder is announced to that chat's
  surfaces with `patch.file_changed`, as its own editor's save would be.
- A `recursive` `list` walks `path` flat instead of one level, for the host-wide
  `⌘P` quick-open — the same git-aware walk the chat-scoped recursive index
  uses (tracked + untracked-but-not-ignored files via `git ls-files` when
  `path` is a work-tree, a bounded manual walk otherwise), capped at
  `maxEntries` (default 20,000). `entries[].name` is a path relative to `path`
  rather than a bare filename.

## Host search

A surface can search file CONTENTS under one absolute directory on a host, with
no chat in between — the search-in-files half of the host-wide file browser
(`03-wire-protocol.md` § Host search; `14-design-web.md` § File browser — `⌘⇧F`).

- A SESSION, not a request/response: the surface mints `searchId`, opens with
  `patch.host_search.request`, and the host streams zero or more
  `patch.host_search.result` batches followed by exactly one
  `patch.host_search.done`. `patch.host_search.cancel` ends it early — the
  host stops the walk and sends nothing further for that `searchId`,
  `done` included.
- The query is a plain substring, never a regex — case-insensitive unless
  `caseSensitive` is set. There is no query language to get wrong.
- `root` must be absolute and already normal, exactly like host files' `path`
  (`path_invalid` otherwise); it must exist and be a directory (`not_found` /
  `not_a_directory`).
- Prefers `rg` (ripgrep) on the host's PATH: already gitignore-aware, already
  skips binary files, fast enough that most searches answer in one batch. A
  host with no `rg` falls back to its own walk — the same git-aware listing
  `recursive` host files / the chat-scoped index use, each file read (if UTF-8
  text, within the editor's size cap) and scanned line by line.
- Capped at 500 matches total; hitting the cap stops the walk and reports
  `truncated: true` rather than running unbounded over a huge tree.
- A search's own frames are per-surface the same way terminal output is
  (`forSurfaceId`, stamped by the hub from `request`/`cancel` since those are
  the only host-search frames a surface sends) — never fanned out to every
  connected surface.

## Model catalogue

The set of models a new chat can spawn on is read from each provisioned provider,
not hard-coded. The catalogue is per host: a chat's host is chosen
before its model, and the models offered are that host's. The host owns it because the host runs the providers
with the credentials the server hands it (`10-auth.md`) — no surface holds a model API key (`principles.md`).
On a `patch.models.request` it returns its cached catalogue across its own providers,
re-reading a provider's models endpoint whenever that entry is older than its TTL
(6 h). Entries are `{ id, label, backend }`, newest-first, so a model released
after the last deploy is selectable and a retired one stops being offered. A
chat's chosen model determines which provider runs it.

A missing or expired credential, or a non-2xx from a provider, is returned as an error against that provider, and the surface shows that error in the picker (`14-design-web.md` § Model selector) while models from the providers that answered stay selectable. A cached catalogue is served for its TTL even if a later refresh fails.

## Self-upgrade

See § Runtime and installation: the host checks for, downloads and applies its
own updates under the service manager, and reports its version and update state
per host.

## Provider-level context

Claude Code's own harness puts its own context into a session as entries of
their own, never inside a turn's prompt: environment (cwd, platform, shell),
model identity, the day's date, an instruction file that changed since last
read, a file the agent had read that changed on disk outside it (labelled "File
changed externally"; an image's bytes are never put in the text), the
skill/agent/deferred-tool listings, a remaining-token-count reminder, and a
handful of internal bookkeeping records. These are the provider's output: the
adapter records each as a `chat.provider_context` entry (`03-wire-protocol.md`)
carrying the provider's own name for its kind (`providerType`), a label and its
text, unaltered.

They recur constantly within one session (a token-count reminder alone can fire
hundreds of times), so a surface shows them per chat rather than per turn: one
collapsed row per `providerType`, holding the latest label and text with a
running count, among the chat's standing banners above the transcript. An entry
the surface already counted is not counted again when it is delivered a second
time. A `providerType` with no dedicated label still renders, under the Title
Case of its raw name, so a kind Claude Code adds is never dropped.

The panel's default expand state is an account-wide preference,
`providerContextVerbosity` (`off` / `summary` / `full` — Settings § Transcript):
`off` hides the panel, `summary` is the collapsed rows above and the default,
`full` opens every row. A per-row click overrides the default locally.

## Cross-refs

- Session spawn contract: `04-chats-and-folders.md`
- Wire messages host sends/receives: `03-wire-protocol.md`
- Job execution: `08-triggers-and-jobs.md`
- Cross-chat tools: `06-threads-manager-speakers.md`
