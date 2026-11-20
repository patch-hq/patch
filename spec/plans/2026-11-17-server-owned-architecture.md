# Server-owned architecture

The decisions agreed for Patch's storage, provider, restart, account, loading and status model, and the order they are built in. The spec files carry the resulting behaviour; this file is the brief they were rewritten from and the build order.

## Decisions

### Shape

1. Surfaces, hosts and one server, with an optional stateless relay for reaching a server that has no public address. The server is a role, not a machine: it runs on its own always-on box, or on a user's Mac as a background service. It stays light enough to run on a Mac (no external database). Each account's data is kept separate on disk.
2. On a Mac the server is its own OS service (launchd), like the host. The desktop app is only a window onto it; quitting the app does not stop the server. The server stops when the user turns it off or the machine sleeps or shuts down.
3. The server's data is one self-contained folder, so moving the server to another machine is carrying that folder across.
4. Hosts are workers. A chat lives on one host for its whole life. Chats are not moved between hosts automatically; "replace this host" (a new machine taking over an old host's chats, its folders and provider session files carried across unchanged) is a deliberate, guided step.
5. The Manager and Speakers are special chats with their own code and interface. The Manager has a home host the user chooses; changing it is a visible handover (decision 13). There is no automatic failover. Speakers is its own special thread. The Telegram thread does not exist.

### The gateway principle

6. Patch is a gateway to the provider on a device. It passes through what the provider does and does not force what it does not.
7. Patch writes into a provider's conversation only by sending real messages through the provider's official interface. It never fakes turns, rebuilds or reconstructs sessions, writes a provider's session files, strips or alters a provider's output, or injects hidden prompt content. Anything Patch sends the model is an ordinary message in the chat's record that the user can see. The one exception is the patch-tools guidance: set through the provider's official system-prompt option, shown in full in Settings → Agent, editable there, removed by emptying it and restored by a reset (`principles.md` § No hidden prompt content).
8. Features follow capability. Edit, rewind, branch, resume and switching off native tools are offered only where the provider supports them natively through its official interface. Where it does not, the feature is absent for that provider. A provider session that is gone stays gone: the chat stays readable from Patch's record and cannot continue with the model's memory.
9. Each provider's own settings (session retention and auto-delete among them) are exposed per provider in Settings for the user to choose. Patch does not override them.
10. Patch owns the state the user needs to see or that must outlive a turn: the chat record, subagents (`patch_agent`), background tasks, goals, wakes, watches, memory, artifacts, pads and settings. It adds these through official channels only: its tools reach every provider over MCP, and the provider's native equivalents are switched off with the provider's own setting. Where a provider cannot switch off a native equivalent, Patch's version is off for that provider and the native one is used.

### Storage

11. The server holds Patch's record of every chat: one append-only log per chat, in Patch's format. It is the source for display, search, paging and every surface. Each entry carries the provider's own message or turn id (`nativeRef`), which is how native edit and rewind are offered.
12. A chat has exactly one writer, its host. The host numbers the chat's entries (`seq`); the server stores them in that order and never renumbers. A host taking over a chat (replace host, Manager home change) continues from the server's high-water mark.
13. Switching provider is the one lift-and-shift: it starts a new chat linked to the old one. Context carries over only as a visible first message the user can read and edit (Patch may offer a drafted summary). The two chats are shown as one continuing thread with the switch marked.
14. The provider's session stays on the host in the provider's own format. Patch never reads it for display and never edits it.
15. Hosts send the server what is new through one outbox per host, numbered host-wide. The server commits each event durably, then acknowledges the outbox position; after a reconnect the host resends everything after the last acknowledgement. There is no per-chat comparison, the server never asks a host for history, and a host never answers a surface's history request.

### Providers

16. One adapter per provider. An adapter runs turns, translates the provider's events into Patch's record, reports account state, and declares its capabilities: resume, edit or rewind at a message, branch at a turn, switch off native tools, interrupt, steer. Adding or removing a provider is adding or removing its adapter; the chat core never branches on a provider by name.
17. The Agent Client Protocol (ACP) is the default adapter: any ACP agent can be added as a provider through it. Claude Code (Agent SDK) and Codex (app-server) have direct adapters because they expose more than ACP does.
18. Local models and routers (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, LiteLLM) are a model endpoint inside a harness Patch already drives, not providers of their own. Patch does not run its own agent loop.

### Restarts and offline

19. A host restart keeps work running: turns, terminals, watches and background jobs run as their own processes and the host reattaches to them. The host loads only chats with live or owed work at startup; every other chat is opened on demand.
20. A server restart breaks nothing: hosts and surfaces reconnect, hosts resend what was not acknowledged, and nothing is marked failed because a connection dropped.
21. A message to a chat whose host is offline is held by the server and delivered when the host returns. Surfaces can always read and send.
22. A turn genuinely cut off (its process died with the machine) shows as interrupted with a Continue action. Continue resumes through the provider's own resume where it has one, otherwise it sends a visible message. Automatic continue is a user setting.

### Accounts

23. A provider is signed in once in Patch and is available on every host. Credentials are stored on the server, encrypted, and handed to hosts. Each host reports which providers and models it can run.
24. Each account has one state: ready, near limit, limited until a reset time, out (billing or credit, needs the user), signed out, or broken (with the provider's message). States come from the provider's own signals through the adapter.
25. A turn that meets a temporary limit pauses visibly with the reset time; the user's chosen behaviour then applies: resume at reset, continue on another account of the same provider, or switch provider (decision 13). Out of credit and signed out stop and ask; they are never retried. Sign-in is available from every surface, with a device-code flow for headless hosts. Only transient errors retry automatically, and each attempt is shown.

### Loading

26. Surfaces read only from the server. Opening a chat never waits on its host.
27. A surface asks for what is new since a position, and for older pages before a position. Live events and history are one stream: reconnecting continues from the surface's position.
28. One update feed per account tells each device what changed anywhere (chat list entries, statuses, new entries for chats it follows). Each device keeps a local copy of its recent and active chats, so the list and those chats show instantly and then catch up.
29. A chat opens on its last screen; older entries load as the reader scrolls up. Large tool output loads when expanded.
30. A surface never shows a chat as empty or finished while it is still loading. The chat list comes from a server index with paging.
31. Load targets are tested: the chat list and followed chats render from the device copy with no network wait, any chat's last screen renders within one second of opening, and nothing a device has shown is lost on reconnect.

### Status

32. The server alone decides a chat's status. Hosts report facts (turn started, turn ended with outcome, question pending or answered, host connected or gone), accounts report their state, and the server derives one status per chat.
33. The statuses are: idle, running, waiting for the user, queued for an offline host, host restarting, host offline, interrupted, paused until a reset, waiting for sign-in, and failed (with reason). Snoozed, archived and pinned are user flags, kept apart from status.
34. The server enforces the allowed transitions. A host going silent mid-turn makes the chat "host offline", never a stale "running" or a false "failed".
35. Surfaces display the status the server sends and store it with their copy of the chat; they never derive it.

## Build order

Each phase ships on its own and leaves Patch working.

1. Foundation. The host outbox with server acknowledgement (decision 15); the server's log becomes the record, holding every logged event type and turn boundary with `nativeRef`; one import of existing host logs into the server; surfaces' history requests answered only by the server; server-derived status with enforced transitions. Removes log sync, the host's replay to surfaces, and status computed on surfaces.
2. Loading. The account update feed, server paging (new since / older than a position), the device copy, the paged chat index replacing `chat-registry.json`, and the load targets as tests.
3. Restarts. Every long-lived piece of host work in its own process with reattach; lazy chat loading on the host; the server as its own launchd service on a Mac; the restart statuses.
4. Accounts. Server-held encrypted credentials for every provider, the account states, the limit choices, sign-in from every surface, provider settings exposed.
5. Provider plug. The chat core split from provider adapters (Claude Code and Codex first), capability declarations, an end to session reconstruction, transcript stripping and hidden prompt injection (system reminders become visible messages); then the ACP adapter with one ACP provider; local models as harness endpoints.
6. Special chats. The Manager on a chosen home host with no failover; Speakers as its own thread.
7. Removal. Pre-migration native transcript copies, the Telegram thread, the server's chat mirror, Manager failover stitching, and the remaining reconstruction code.
