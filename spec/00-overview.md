# Patch — Overview

Patch runs and steers coding agents from anywhere. Each agent is a provider reached through an adapter: Claude Code and Codex directly, and any agent that speaks the Agent Client Protocol (ACP). It adds multi-surface access (terminal, web, phone, standalone voice device), external triggers (cron, webhooks, Todoist), voice (host-hosted Whisper + Kokoro across all surfaces), and cross-chat management. It also gives agents their own tools for working with Patch: goals, background sub-agents, watches, wakes, pads, notifications and messaging other chats.

Surfaces, hosts and one server. A host is any machine whose files and commands the agent works with: an always-on box, a laptop, a work machine. It is installed on each machine and runs as an OS-managed service, starting at boot and running independently of any surface. See `02-host.md`.

The server is a role, not a machine. It holds every chat's record, decides every chat's status and is the one place surfaces read from. It runs on its own always-on box, or on a user's Mac as its own background service that the desktop app is only a window onto. Its data is one self-contained folder. A server with no public address is reached through an optional relay, which holds no state. See `01-server.md` and `11-deployment.md`.

The server and hosts are separate roles even when they share a machine, because a host is usually unreachable and is only a worker. Hosts dial out to the server and hold that connection, which is what lets a laptop behind NAT be a host at all. A server on an always-on box also gives webhooks and push a fixed address to arrive at while every host is asleep; a server on a Mac stops when that Mac sleeps or shuts down.

## Principles

See `principles.md` for each in full.

- Gateway. Patch passes through what the provider does and forces nothing it does not; features follow the provider's native capabilities. There is no second permission system.
- Nothing hidden. Patch reaches the model only through real, visible messages sent through the provider's official interface.
- Patch owns the state the user must see or that must outlive a turn — the chat record, subagents, background tasks, goals, wakes, watches, memory, artifacts, pads, settings — and adds it as tools over MCP, with the provider's native equivalents switched off.
- Agent-neutral. Every provider is an adapter; Patch's own features never depend on one provider's internals, and the chat core never branches on a provider by name.
- The server holds the record and decides status, each chat's host is its one writer, and surfaces display what the server sends.
- Copy from Happy where it works. Wire protocol, voice architecture, QR-code auth linking, host model.
- All surfaces together. Every change is made for all surfaces (phone, web, voice) in parallel, never for one only.
- No fallbacks. Failures surface immediately; we don't paper over them (portfolio repo convention).

## Component map

```
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ Terminal │  │ Web app  │  │ Phone    │  │ Desktop  │
│  (TUI)   │  │          │  │ (native) │  │  (Mac)   │
└────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │             │             │
     └─────────────┴──────┬──────┴─────────────┘
                          │  WebSocket
                          ▼
                  ┌───────────────┐
                  │ Relay         │   optional, stateless
                  └───────┬───────┘
                          ▼
                  ┌───────────────┐
                  │  Patch Server │  ◀── Todoist
                  │  record,      │  ◀── Webhook URLs
                  │  status       │
                  └───┬───────┬───┘
             WebSocket│       │WebSocket
                      ▼       ▼
        ┌───────────────┐   ┌───────────────┐
        │ Host          │   │ Host          │   one per machine
        │ always-on box │   │ laptop        │
        │  adapters     │   │  adapters     │
        │  machine      │   │  machine      │
        │  access       │   │  access       │
        └───────────────┘   └───────────────┘
```

- Server — one Node/Fastify process, on an always-on box or as a background service on a Mac. Chat records, chat index, derived status, account update feed, held messages for offline hosts, provider credentials, presence, push fanout, webhook ingress, voice token mint. See `01-server.md`.
- Relay — optional and stateless; carries connections to a server that has no public address. See `11-deployment.md` § Relay.
- Host — one native process per machine. Runs provider sessions with that machine's access through one adapter per provider, sends its chats' new entries to the server, runs jobs. See `02-host.md`.
- Surfaces — terminal CLI, web, phone, desktop. They read only from the server and keep a local copy of recent chats. See `05-surfaces.md`.
- Special threads — Manager, Speakers. Long-running chats with cross-chat tools. See `06-threads-manager-speakers.md`.

## Glossary

| Term       | Meaning                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Server     | The role that holds chat records and status. Runs on an always-on box or as a service on a Mac.                                    |
| Relay      | An optional stateless forwarder for reaching a server with no public address.                                                      |
| Host       | A machine running the Patch host service. Identified by `hostId`, labelled by a user-editable host name.                           |
| Provider   | An agent Patch drives (Claude Code, Codex, any ACP agent). Local models and routers are endpoints inside one, not providers.       |
| Adapter    | The host's driver for one provider: runs turns, translates its events into Patch's record, declares its capabilities.              |
| Chat       | One conversation with one provider, on one host and a folder on it for its whole life. Its host is its only writer. Lives forever. |
| Project    | Emergent. Any folder with ≥1 chat. No registration step. Scoped to its host.                                                       |
| Surface    | A client UI (CLI, web, phone, desktop).                                                                                            |
| Thread     | A long-lived chat. May be a project chat or one of the two special threads.                                                        |
| Job        | A trigger + action, stored as JSON on the server.                                                                                  |
| Patch tool | A tool exposed to the agent inside a chat, prefixed `patch_*` to avoid colliding with the agent's built-ins.                       |

## Spec files

| File                             | Scope                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `principles.md`                  | What patch is and isn't. Project scope. Read this first.                                                                                    |
| `day-in-the-life.md`             | The product test. End-to-end scenario the spec must serve.                                                                                  |
| `00-overview.md`                 | This file. Shape, principles, component map, glossary.                                                                                      |
| `01-server.md`                   | Server: chat records, status, account feed, presence, push, webhooks.                                                                       |
| `02-host.md`                     | Host: provider adapters, outbox, session lifecycle, job runner.                                                                             |
| `03-wire-protocol.md`            | Event protocol between server and clients (Happy-Wire-based).                                                                               |
| `04-chats-and-folders.md`        | Chat model, folder pinning, history, provider switch.                                                                                       |
| `05-surfaces.md`                 | Terminal, web, phone, desktop. Editor. Presence.                                                                                            |
| `06-threads-manager-speakers.md` | The two special threads and their cross-chat tools.                                                                                         |
| `07-voice-app.md`                | Phone + web app voice. Audio streams to host's Whisper + Kokoro stack. Focus-follow, Manager-call mechanics.                                |
| `08-triggers-and-jobs.md`        | Cron, webhook, Todoist. JSONata filtering.                                                                                                  |
| `09-notifications.md`            | `patch_notify` tool. Push routing. Desktop native.                                                                                          |
| `10-auth.md`                     | Provider accounts. Host key. Trust model.                                                                                                   |
| `11-deployment.md`               | Deployment requirements, topology, server placement, relay.                                                                                 |
| `12-error-and-offline.md`        | Chat statuses. Offline, restart and interruption.                                                                                           |
| `13-design-terminal.md`          | `patch` CLI UX — minimal wrapper over the agent.                                                                                            |
| `14-design-web.md`               | Web SPA layout, navigation, routes.                                                                                                         |
| `15-design-mobile.md`            | Android-native (Expo), tabs, voice, push.                                                                                                   |
| `16-voice-device.md`             | Standalone voice surface — HA Voice Preview Edition with custom firmware. ESP32-S3 streams PCM to host, host runs Whisper + Kokoro locally. |
| `17-cli.md`                      | `patch` CLI subcommands and agent-facing primitives.                                                                                        |
| `18-tech-stack.md`               | Languages, frameworks, libraries, build tools. Decisions made upfront.                                                                      |
| `19-testing.md`                  | The five test layers, which layers a change requires, and the verification gate.                                                            |
| `20-hooks.md`                    | User-defined checks Patch runs on a message before it reaches the agent, and on the agent's reply — pass/advise/block.                      |

## Permission model

The provider's own permission layer is the only one.

Turns run under `auto` by default, where a model classifier approves or denies
each tool call. Every chat carries its own mode, stamped from the host default
when the chat is created and changed only from within that chat; the host
default is set in Settings and steers the chats created after it. A change takes
effect on the next turn. See `02-host.md` § Permission mode.
