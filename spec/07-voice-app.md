# Voice — App Surfaces (Phone + Web)

## Two kinds of call

Every voice interaction is a two-way exchange with a chat. A call comes in two kinds, and dictation sits beside them:

| Kind             | Who listens and speaks                                                                         | Where its speech engines run                      |
| ---------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Voice agent call | A hosted realtime voice agent, which talks with the user and passes work to the chat's agent   | The provider's cloud, relayed by the chat's host  |
| Direct call      | Nobody but the chat's agent: speech to text, a turn for the chat's agent, the reply read aloud | The device the call is made from (§ Direct calls) |
| Dictation        | Nobody: words into the composer                                                                | Per device (§ Dictation engines)                  |

The call button always starts a voice agent call; hands-free (§ Session modes) and a call an agent makes (§ Agent-initiated voice) are voice agent calls too. A direct call is chosen from the call button's menu (§ 2. Voice call). A voice device (`16-voice-device.md`) answers on the voice agent or directly, by its own setting; it has no speech engines of its own, so its direct conversations run speech on the chat's host (§ Host speech engines).

### The voice agent

The account has one voice agent setup, used by every voice agent call: a provider, a model, a voice, how it sounds (`14-design-web.md` § Voice), and the voice instructions (§ Voice instructions). The providers:

- Gemini — a Gemini Live session is the voice agent end to end: it hears and speaks directly, with no separate speech to text or text to speech step.
- OpenAI — an OpenAI Realtime session, the same way.
- ElevenLabs — ElevenLabs Agents: the host provisions a throwaway agent per session (its LLM is the chosen model; the start context in its prompt; its tools as client tools answered by the host), opens a conversation on a signed URL over a server-side WebSocket, relays 16 kHz mic PCM in and 24 kHz agent audio out, and deletes the agent and its tools when the session ends. Billed by the call minute ($0.08/min on every plan, plus the LLM's own per-minute charge from credits), recorded in the voice cost ledger by call length. Hands-free cannot stop the agent answering, so an unaddressed transcript is reported heard-but-not-sent and the agent's reply to it is dropped (its audio and words never reach the surface or the chat); unlike OpenAI it is still in the agent's context and still billed.

The model and voice lists are read from each provider's API, not built in, and Settings refreshes them on request. A stored model or voice the provider no longer lists is refused at session start, naming it, never swapped. Changing any part of the setup applies to the next session.

How it sounds is the provider's own controls and nothing more:

- ElevenLabs: speech model, tone, expressive mode, stability (Expressive ↔ Steady), similarity, speed (Slower ↔ Faster) and reply eagerness (Patient / Normal / Eager). Defaults are calm: stability 0.7, speed 0.95, reply eagerness Patient.
- OpenAI: tone and speed.
- Gemini: tone and match my tone.

Tone is raw text, kept per voice. It goes into the voice's instructions as written; on an ElevenLabs v3 speech model any `[tags]` in it are also sent as suggested audio tags.

### Voice instructions

What the voice agent is told is the user's. The account's voice instructions are a default the user edits in Settings → Voice calls, and the voice agent receives them, then the tone, then the start context (§ Keeping voice and text as one conversation), with nothing added on top. The default says what the voice agent is (the voice of this chat, not an assistant with no knowledge of the user) and gives no tone directions. Everything the voice agent needs to know about a tool is in that tool's own description.

### Provider keys and failures

The host relays every voice agent call. A surface opens the same audio WSS with the same `audio.session_start`, streams the same 16 kHz PCM16 up and plays the same 24 kHz PCM16 down whatever the provider; the host holds its own server-side connection to the provider and relays audio both ways (resampling where the provider's rate differs). No surface ever talks to a voice agent provider or holds a provider key or ephemeral token. The provider keys (`GEMINI_API_KEY`, `OPENAI_REALTIME_API_KEY`, `ELEVEN_LABS_API_KEY`) are shared by every host: set once from Settings → Keys, which fans the write out to every host that's online, and each host stores its own copy (or reads it from its own environment, with the Settings one winning) — `02-host.md` § Provider keys. A key set or revoked there applies to the next session on every host, with no restart. `OPENAI_REALTIME_API_KEY` is deliberately not `OPENAI_API_KEY`, which the agent processes a host runs would pick up and bill. A missing key never stops the host — voice is one setting, and every chat on the host would go down with it, and a host that is down cannot be given the key from Settings. Instead:

- At boot, whenever the voice setup changes, and whenever a key is set or revoked, the host logs an error if the chosen provider has no key on that host, naming the key.
- Every voice agent session there is refused at its start with `audio.error {code: 'voice_key_missing'}`, and the message is one fixed sentence every surface shows as is: _"The voice agent is set to Gemini, but GEMINI_API_KEY is not set on this host. Choose another provider in Settings → Voice calls."_ — provider, key, and the fix. Nothing falls back to another provider or to a direct call.
- Surfaces fail at the press: a call or hands-free session shows the sentence on the call bar.
- Each host reports which keys it holds on `host.host.voiceKeys: {gemini, openai, elevenlabs, deepgram}`, re-published whenever one is set or revoked. Settings → Voice calls marks the provider _"Not configured on <host>: <KEY> is missing. Calls there are refused."_ for each host that lacks it, and the line clears as soon as that host reports the key. A host that has not reported `voiceKeys` is not called unconfigured.

A provider's failure (other than a missing key) — it could not open, it errored, a reply failed or produced no audio, a transcription failed — reaches the surface as `audio.error {code: 'gemini_unavailable' | 'openai_unavailable' | 'elevenlabs_unavailable'}` naming what went wrong. If the provider's side of the session is gone (never opened, or closed under the host), the host also ends the surface's session, so the surface stops streaming into a dead engine and shows the failure with a retry (§ 2. Voice call).

A session whose microphone delivers nothing but digital silence for its first 5 seconds of audio is failing, not quiet: any working microphone delivers a non-zero sample well within that time. The host says so on the wire (`audio.error {code: 'mic_silent'}`) and the surface shows it, naming the likely cause — on macOS, an app without microphone permission is handed a silent stream rather than an error — and the place to fix it. Every session's closing log records the loudest sample it received.

## The voice agent and the chat's agent

A call is the chat it was started on, spoken. It is never a separate assistant. On a voice agent call two models share that one conversation:

- The voice agent holds the back-and-forth: anything it can answer from the conversation so far and its own knowledge.
- The chat's agent — the agent the chat already runs on (Claude or Codex, whatever the chat's harness and model are), with its tools, folder and session. The voice agent passes a request to it whenever it needs something only the chat's agent has: tools, files, the user's data, an action, or real work.

This works the same on every provider. The voice agent has two tools for it:

- Pass to agent — answers at once with "received". The request becomes a message in the chat for the chat's agent, which takes it when it is free; nothing interrupts the chat's agent's work, whatever it is doing. The voice agent says, in a few words of its own, that it has passed the request on, and carries on talking: anything else the user says gets a normal reply.
- Check status — called only when the voice agent needs it. Returns each open hand-off (what was asked; waiting, being worked on or answered; time since it was sent) and the chat agent now (idle or working; the step it is in and for how long; its last message and how old it is).

When the chat's agent answers a hand-off, Patch pushes the answer into the voice agent's conversation and the voice agent says the gist. A reply from the chat's agent that ends a turn during the call, not in answer to a hand-off (a typed message, a job, another surface), is pushed in the same way. Progress messages mid-turn are not pushed, and nothing else the chat's agent writes reaches the voice agent while the call is open. A pushed message would cut across speech, so the host holds it until neither the user nor the voice agent is talking, then sends it; pushes queue in the order they arrive. Speech the voice agent starts unprompted — not in reply to the user or to a push — is dropped beyond one acknowledgement per hand-off, neither played nor written into the chat.

Each hand-off is written into the chat the moment it is made, in order with what was said around it, as one row (`14-design-web.md` § Main chat panel — Hand-off rows); the chat's agent's answer belongs to that row, never a second copy at the bottom. A hand-off reaches the chat's agent as an ordinary message saying the request was spoken and to do only that. A hand-off that fails says so on its row. Silence or noise heard as an empty or punctuation-only utterance is never written as the user speaking.

### A call to the Manager

A voice agent call opened on the Manager chat works differently: the voice agent is the manager itself, and the Manager's own agent is not in the loop. The Manager's work is talking to other chats, so handing each request to the Manager's agent, which then sends it on with `patch_send_to`, put two agent hops between the user and the chat they meant. Instead the voice has no pass to agent or check status; it has tools of its own, answered by the host. The voice answers questions itself from the conversation (the Manager chat's start context) and acts directly on common requests; it hands real work to the Manager's agent only through `ask_agent`. Three of the tools concern chats:

- `find_chats` — the account's chats (every host, as `patch_list_chats` lists them), or those whose name or folder matches a few words, each with its name, id, whether it is working and when it was last active. The Manager itself and archived chats are left out. A list the host cannot get (the server link is down) is an error, never a shorter list.
- `chat_status` — where one chat stands: its status line, goal, open to-dos and last few messages. For a chat on another host only what the listing knows is available, and the answer says so.
- `send_to_chat` — delivers a message to a chat as `patch_send_to` does (a machine turn the recipient's agent processes as if the user had typed it; a visible sender, so the recipient comes into view).

Four more are quick actions, answered at once and never a search for a chat: `add_task` (a to-do, filed in Todoist through the `td` command on the host), `calendar_agenda` and `add_event` (read and write the calendar through the script named by `PATCH_CALENDAR_SCRIPT`; unset, the tool says the calendar is not set up), and `ask_agent` (passes a request to the Manager chat's own agent and returns at once; the result lands in the Manager chat, not in the call). A failed action is reported as failed, never as done.

A chat is named by its id or by what the user called it. An exact name wins; otherwise the words must pick out one chat. A name that fits none or several is handed back to the voice to ask the user, naming the choices, and nothing is sent; that is not an error. A message that was not delivered is an error the call shows.

A chat's reply comes back into the call the way a hand-off answer does: the send is answered once the chat has the message, and the reply is pushed in later naming the chat. The reply is caught by the delivered message's own id, so a reply belongs to the message that asked for it even when the chat was busy and took it later. One message per chat is awaited at a time: a second message to a chat still answering the first is handed back to the voice to say so. A chat on another host is sent to, but its reply stays in that chat and does not come back into the call; the voice is told so.

The Manager chat records the call as any call is recorded — the user's words and the voice's replies — plus one quiet line for each message sent (`-> "<chat>": <message>`) and one for each reply or failure (`<- "<chat>": <reply>`). Whether a call is a Manager call is fixed when it opens. A host that cannot provide the tools refuses a voice agent call to the Manager rather than opening it with the usual hand-off.

Who the voice is told it is comes from the account's `managerVoicePrompt` (Settings → Manager → Prompts → Voice), read at the start of each call, in place of the voice instructions and with nothing added on top; what the voice needs to know about each tool is in the tool's own description. A blank prompt uses the built-in one.

Calls on any other chat are unchanged.

On Gemini the address rule (§ Session modes) is applied before the audio reaches the provider, because Gemini Live cannot transcribe an utterance without answering it: the host turns Gemini's own activity detection off, cuts the mic into utterances with its local VAD, and sends Gemini an utterance (`activityStart`, audio, `activityEnd`) only once it is addressed. An utterance inside the 30-second follow-up window, and every utterance in `call`, streams live; any other is held, transcribed on the host's own speech-to-text, and either released whole (addressed, so its first word is delayed by that transcription) or reported as heard-but-not-sent and never sent to Gemini. If the host cannot transcribe a held utterance it reports the failure rather than guessing. On OpenAI it is: the provider is told not to answer on its own in `hands-free`, each finished transcript is run through the address rule, an addressed one is answered, and an unaddressed one is reported as heard-but-not-sent and removed from the provider's conversation. Barge-in on a voice agent call comes from the provider's own VAD; in `hands-free` on OpenAI another voice in the room does not cut a reply off.

### Keeping voice and text as one conversation

The voice agent and the chat's agent are separate models, so neither inherits the other's memory. Patch keeps them on one conversation:

- Start context. At session start the voice agent's instructions end with the chat as it stands: its name and goal; questions to the user still open; a catch-up of everything before the last 4 messages (what the chat is for, decisions made, what is done, what is in progress, what is open); and the last 4 messages in full, each with its time. Tool calls and their output are left out. The catch-up is written by a small job (`02-host.md` § Small jobs) while the call connects, so it costs the call no waiting and only cheap tokens; a catch-up that fails is shown on the call bar and the call opens without it. It is background the voice agent answers "what is this chat about" from, not a transcript replayed as turns (a replayed history of hundreds of short messages came back as "this is just a new chat", and cost most of a call's price in input tokens).
- Anything older, the voice agent gets with look back: the host searches the chat's saved messages for a few key words and answers at once (plain keyword matching; no model, no cost beyond the call's own tokens). Work or fresh data still goes to the chat's agent as a hand-off.
- The top of the instructions is never rewritten mid-call, so the provider's input caching keeps working; what changes reaches the voice agent as pushes (§ The voice agent and the chat's agent).
- Every spoken exchange is written into the chat's timeline as ordinary messages: the user's utterance as their message, tagged `[voice • <surfaceKind>]`, and the voice agent's reply as an agent message, streamed into the chat as it speaks. Everything the voice agent says is written, including its words about a pushed answer.
- The chat's agent never ran for exchanges the voice agent answered alone, so they are not in its session. The next turn the chat's agent does run on that chat — a hand-off or a typed message — carries the voice exchanges it has not seen, in order, as a note ahead of the new input (`04-chats-and-folders.md` § Notes to the agent), so the user can open it and read exactly what the chat's agent was given.

Open the chat in text later and the whole conversation, including the parts the voice agent handled alone, is there, and the chat's agent knows about them.

Words said in a call read differently from typed ones. On web, the user's spoken words, the voice agent's replies and a direct call's read-aloud replies are drawn in italics with a filled round call badge, level with the first line, leading the text, on the message's own side. Web and mobile draw all of this the same way.

### Call cost

Every call is costed when it ends, on every kind of call:

- The engine: provider and model, the session's length, and the tokens it used by kind (text and audio, in and out) as the provider reports them. A direct call or host-speech conversation counts what its cloud speech engines were sent (audio seconds, characters); on-device engines cost nothing.
- A cost in US dollars for the engine, from a fixed per-model price table on the host. The chat agent's turns a call runs (hand-offs, or every turn of a direct call) are the chat's own and are not costed, and neither is the start context's catch-up, a small job like any other: they ride on the subscription, and a call's expense is the voice alone. A model missing from the table shows its tokens and no price rather than a guess. An engine that reports no token usage, or an ElevenLabs balance that cannot be read, is left off the line rather than announced.

The summary lands in the chat as one quiet line when the session ends — `Call 0:52 · Gemini Flash · $0.012`, at the moment the call ends, with nothing to wait for. The host keeps every session's costing on disk and reports this month's and all-time totals per host on `host.host.voiceUsage` — calls, tokens (Gemini and OpenAI, as the providers reported them) and ElevenLabs credits (as ElevenLabs charged them, plus speech at its per-character rate), and the ElevenLabs plan's credits used this period as last read. Settings → Voice calls → Usage shows them summed across every host, in those units rather than dollars.

## Direct calls

A direct call has no voice agent. What the user says is turned into text on the device the call is made from, sent to the chat as the user's turn (tagged `[voice • <surfaceKind>]`), and the chat agent's reply is read aloud on the same device. It opens no audio session to the host, so it is held on its device only: it is not announced to other devices and does not move between them. It is chosen from the call button's menu (§ 2. Voice call) and runs in `call` mode only.

Each linked device has its own direct-call setup: a speech to text engine and its model, then a text to speech engine, its model, its voice and its sound controls (ElevenLabs: tone, stability, similarity, style, speed; OpenAI: tone, speed; Kokoro: speed). Only the engines the device reports having are offered (`05-surfaces.md` § Speech engines): on-device engines it has installed, and cloud engines the account has a key for. A cloud engine is reached through the chat's host, which holds the key, so the device never holds one. A device that reports no engine shows "No speech engine" and cannot make a direct call; Call direct says why rather than starting.

- End of turn. The device cuts the microphone into utterances and decides the user has finished with Smart Turn run on the device itself, on the same rule as dictation mode (§ Dictation mode → Knowing when the speaker has finished).
- While the chat's agent works, the call plays the agent-working sound (§ Call sounds) and the bar says `Agent working · 0:42`. Anything the user says meanwhile is sent as a queued message, as typing would be.
- Barge-in. Speech while a reply is being read stops the reading; the rest of that reply is not read.
- A failed engine (it could not load, a cloud request failed) shows on the call bar naming the engine, and the call stays open to retry. It is never answered by another engine.

## Host speech engines

A voice device's direct conversations (`16-voice-device.md`) run speech on the chat's host:

- Speech to text — `voiceConfig.speechToText` (§ Speech to text).
- Agent — the chat's agent, every utterance its turn.
- Text to speech — Kokoro (`hexgrad/Kokoro-82M`), 24 kHz PCM16 output.
- VAD — Silero (`silero_vad.onnx`), for end-of-utterance and barge-in.

The large model files are downloaded per host, on demand, from the app (`02-host.md` § Optional components). Kokoro is ~340 MB including voices; a local Whisper model is ~1.5 GB. `silero_vad.onnx` is ~2 MB and sits inside the host artifact instead (`02-host.md` § Installation), so VAD and barge-in work on every host with nothing downloaded.

A chat's voice agent calls and host-speech conversations run on that chat's own host, so they need the provider's key there, or Kokoro installed there. A surface disables the affordance where a component is missing and names the host and the component; on first use it offers the download or the key prompt in place, in a single prompt naming the size/cost and the host.

**Reaching a non-Manager host's audio WSS.** A surface only ever reaches the server, and a host is never itself internet-reachable (`02-host.md` § Runtime and installation — it only dials out and holds the connection), so `/audio/:sessionId` cannot be proxied straight to one host's port. `POST /api/voice/token` records which host minted the session (the chat's own host, from the server's chat index); `/audio/:sessionId` then carries it over whichever of two paths is available, in priority order:

1. **Direct (optimisation).** If that host has declared `host.host.audioRelayHost` — the address it self-reports the server can reach its own audio WSS at directly — the server dials it and relays every frame both ways verbatim. This is only EVER true by default for a host co-located with the server (loopback), since that is the only address a host can know in advance is reachable; `PATCH_DAEMON_AUDIO_RELAY_HOST` remains available to declare a different one explicitly (e.g. a Tailscale name) as a latency optimisation, but nothing requires it.
2. **Tunnelled over the host link (the default for everyone else, no setup).** Lacking a direct address, the server instead carries every frame of the session over the SAME outbound WS the host already holds to the server — `patch.audio_relay.*` frames multiplexed by `sessionId` (`03-wire-protocol.md` § Audio relay over the host link). The host on the other end bridges those frames to its own LOCAL audio WSS, exactly as a co-located surface would reach it, so the host's audio handling is the same whichever path carried the bytes. This is what makes voice on a host that is not running the Manager (a Mac, say) work with nothing configured: no Tailscale, no manually-set env var, no address to go stale across a self-update.

A session for a host that is offline is refused with `audio.error {code: 'host_unreachable'}` before any audio is accepted, same discipline as `session_not_found`; so is one whose host-side tunnelled bridge fails to connect locally (voice not installed on that host) — the failure always reads as that host's own, never silently running a different host's pipeline.

### Whisper transcription params

The Groq transcription request pins `language=en` and `temperature=0`.

### Latency

On a host-speech conversation or a direct call, time-to-first-audio for a reply is the chat agent's own response latency plus synthesis, roughly ~600ms–1s, because the chat agent's turn is the reply. Two optimisations apply:

- Kokoro kept warm — a host (or a device, for its own on-device Kokoro) that has the Kokoro component installed synthesises a throwaway phrase at startup, and again on a slow timer while it is idle, so the model load never lands on a call's critical path. Warming only at startup is not enough: the weights get paged out while the host does something else, and the first call after a quiet hour then waits out the whole load before it can say anything, which the user experiences as a call that never speaks.
- Warm agent session for the duration of a call (`02-host.md` § Per-turn process / warm sessions) — the agent process is opened when the call starts and kept alive across turns instead of being re-spawned every utterance. Barge-in interrupts the current turn without killing it.

A voice agent call has no separate speech stage to warm — the provider's session is already speech-to-speech — so the voice agent answers at its own speed, and a hand-off never delays it.

The user's words appear in the chat timeline as they speak, on every kind of call. On web and desktop that is an in-progress user message at the end of the call's chat, its text the live partial transcript in italics; on mobile it is the call bar docked above that chat's composer (`15-design-mobile.md` § Voice states). It becomes an ordinary user message when the transcript is final, and is replaced by the persisted message when that arrives, with the `[voice • …]` tag stripped for display. An utterance a hands-free session discarded is removed from the timeline rather than kept. The reply streams into the timeline beneath it like any agent reply.

### Live transcript

Host speech on Whisper and dictation on Whisper only — a voice agent call streams the user's words as the provider transcribes them, and the live dictation engines stream theirs (§ Dictation engines), each sent as `audio.transcript_partial` with no workaround needed.

No Whisper backend streams — each answers one whole clip at a time. An interim transcript is therefore produced by re-transcribing the growing utterance prefix about once a second while the user is still speaking, each answer going out as `audio.transcript_partial` (`03-wire-protocol.md`).

Whether that is worth doing is a per-backend decision, because every pass costs a whole extra transcription request. Groq answers a short clip in well under a second; a model running on the host's own CPU (`local`) is slower per pass, but the session keeps only one partial pass in flight and spaces passes by a second of new audio, so the final queues behind at most one pass. Both offer partials. An unconfigured backend has nothing to ask. A backend that offers no partials emits none at all, and its surfaces show the microphone's input level while the user speaks instead of words.

Two rules keep the interim text from costing the user the transcript that matters:

- A quota reserve. A partial is refused once the requests already made in the rolling minute reach the partial budget, which sits below the provider's per-minute limit. A long sentence can spend its whole allowance on the preview and the final — the request that becomes the user's words — still has slots to run in. A final is never refused to make room for a partial. A refused partial skips that pass only; the next second of speech asks again, so the preview slows down rather than freezing for the rest of the utterance.
- A hallucination filter, on partials only. Whisper answers a short or near-silent prefix with a stock phrase ("Thank you.", "you", subtitle credits) rather than with an empty string, and one of those painted into a user's input reads as words they said. A partial whose whole text is one of those phrases is dropped and the next pass gets the chance instead. A final is never filtered: if the user did say "Thank you.", that is the turn.

The interim text is a guess at a half-finished sentence, not a recognition, and each pass is independent of the last — so it rewrites itself as the user talks and a word can change after it has appeared. Every surface therefore renders it as a preview marked as in progress — the greyed placeholder ink on web/desktop; on mobile, where the words are the main thing on screen while the keyboard is away, full reading ink on an accent tint — and discards it outright the moment the authoritative transcript arrives. It is never left as text the user has to notice is wrong and edit.

Partials reach the composer's dictation preview (§ Dictation into the composer), a sustained session's bar, and a voice note's overlay on web/desktop and mobile. A voice note's authoritative transcript is still committed in one upload rather than streamed (§ End-to-end voice transport); the live words come from the same preview leg dictation uses — an audio session opened alongside the recording, fed from the same microphone, always closed as cancelled — and are dropped when the note is sent or cancelled. If that leg cannot open or breaks, the failure is shown and the note still records and sends.

The standalone voice device (`16-voice-device.md`) runs the same two tiers and the same light/heavy split, on ESP32-S3 hardware — its session lifecycle differs (opened by an on-device wake word rather than a gesture) but the turn semantics below are what it reuses for its wake-triggered conversations; see `16-voice-device.md` § A conversation.

## Surfaces covered here

- Web app — voice button in any chat. WSS audio session to host when active.
- Phone app (Android) — tap-to-talk button. Foreground service while voice is active. WSS audio session to host. Manager-call ringing via ConnectionService.

## Architecture (host speech)

```
phone/web ──audio WSS (PCM16 mic in, PCM16 audio out)──▶ patch host
                                                              │
                                                              ├── streaming Whisper STT
                                                              │     → text per utterance
                                                              │
                                                              ├── text → agent chat (currentChatId)
                                                              │     ← response text (streaming)
                                                              │
                                                              ├── streaming Kokoro TTS
                                                              │     → PCM16 frames
                                                              ▼
                                                          back to surface speaker
```

Cost: ~$3–5/month for Groq Whisper at heavy use, plus the cost of the host running the host + Kokoro.

Latency:

| Stage                                  | Time          |
| -------------------------------------- | ------------- |
| Audio WSS surface → host               | ~50–150 ms    |
| Groq Whisper streaming + EOS           | ~50–100 ms    |
| Agent response (short, no heavy tools) | ~500–800 ms   |
| Kokoro first audio byte                | ~150–200 ms   |
| host → surface speaker                 | ~50–150 ms    |
| Total time-to-first-audio              | ~600 ms – 1 s |

## A call stays on its chat

A call or hands-free session is aimed at the chat it was started on and stays there, whatever the surface goes on to look at. Every surface still emits `chat.focus_change {chatId}` on every navigation (`03-wire-protocol.md`; read by `09-notifications.md` § Chat completion), but the host does not use it to re-target a voice session: navigating to chat B mid-call leaves the call on chat A, and starting a call from another chat while one is live does nothing. The call bar names the chat the call is on.

The voice agent moves the call itself with its switch chat tool, when the user asks to talk to another chat: the call carries on, on the other chat, and the voice agent is given that chat's start context (§ Keeping voice and text as one conversation) as a push. The call bar and the announced call (§ A call can move between devices) name the new chat. An answer still pending from the old chat arrives as before, labelled with its chat, and lands in the old chat's record. A chat on another host is not a switch target; the voice agent is told so.

## A call can move between devices

A `call` session is on one device at a time. When an app surface (phone, web, desktop) opens or closes one, the host announces it to every surface as `voice.call {sessionId, surfaceId, surfaceKind, chatId, active, startedAt}` (`03-wire-protocol.md` § Audio session). A surface that is not on a call itself and sees one live elsewhere shows a call-in-progress strip naming the device and the chat — web and desktop as a slim strip under the focused chat's header (never across the window's top row, where it would sit on the desktop's window controls and the header's buttons), mobile as a pill on the tab layout and above a chat's composer — with Switch here and End buttons. A surface never shows its own call, and the strip goes the moment the host reports the call ended. The server is the record of which calls are live: it keeps each host's `voice.call` changes, replaces them with the host's `voice.calls` snapshot on every link (re)connect, and drops a host's calls when that host goes offline. Every surface gets the whole set as `voice.calls` in its greeting and whenever the set changes that way, and replaces its list with it, so a missed `active: false` cannot leave a strip up for a call that no longer exists. Hands-free sessions are not announced: hands-free is a mode left on, not a call.

Switch here opens a normal call on that chat with `takeOver: true` on `audio.session_start`. Once the new session is established, the host closes every other `call` session on the same chat with the close reason `transferred` and announces them ended before announcing the new one. A session that is refused (missing key, unreachable host) never takes anything over. The surface that was closed with `transferred` ends its call quietly — no "call dropped" error — and its strip then shows where the call went. Sessions on other chats are untouched, and a session opened without `takeOver` never closes another.

End hangs the call up wherever it is held: the host closes that session as the user ending it, and the device holding it plays the ended sound and clears its bar.

## A dropped call comes back

While a voice agent call is open the host sends a heartbeat on the audio socket every second. A surface that has heard nothing from the host for about 3 seconds (three missed heartbeats, so one late frame is not a drop) treats the line as lost, as it does a closed audio connection or the host going away mid-call (`host_unreachable`) during a server or host restart or a network change. The host only ends a call on its own when it moves to another device (`transferred`), when the agent ends it (`ended_by_agent`) or after an error it has already reported, so every other close is a drop.

The surface plays the reconnecting sound (§ Call sounds), the call bar shows `Reconnecting…`, and it redials, backing off over about two minutes (1, 2, 4, 8, 15, 20, 30 and 30 seconds), long enough to ride out a release restarting the server and the host; after that it keeps trying every 30 seconds until the user ends the call, saying once that it is still trying. Bringing the app to the foreground redials at once. When the line is back it plays the reconnected sound. Nothing said while the line was down is kept or sent.

A redial's `audio.session_start` carries `resumed: true`, and the host writes one line into the chat: `The call was interrupted, so Patch started a new one`. A call that was cut and picked up again is never silently a different call.

### Call logs

The phone records, for each call: why audio stopped whenever it did (signal lost, audio focus taken, output device changed), the connection's quality (round trip, lost and late heartbeats) and how long each step of each turn took. It sends the log to the host when it reconnects and when the call ends, and the host keeps it with the session's closing log.

## Fixed timings

Every fixed time in a call is either a setting or carries its reason beside it here. Anything a real signal can tell — the host's heartbeat, the provider's own events, the device's audio and headphone events — is taken from that signal, not timed.

## Turn semantics (host speech)

| Event                 | Direction            | Handling                                                                                            |
| --------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| User speech           | surface → host (PCM) | Whisper transcribes streaming; host emits user-turn message to `currentChatId` on end-of-utterance. |
| End-of-utterance      | host-side            | Silero VAD or Whisper EOS heuristics. Surface keeps WSS open.                                       |
| Agent response tokens | agent → host         | Streamed; host splits complete sentences off the growing reply and hands each to Kokoro.            |
| Kokoro audio          | host → surface (PCM) | Streaming, plays via surface speaker.                                                               |

Streaming end-to-end: Kokoro starts speaking on the first sentence boundary while the agent is still generating later tokens. The host accumulates streamed reply text, splits it at sentence boundaries (`.`/`!`/`?` + whitespace, or a newline), strips markdown before synthesis (headings, emphasis, list markers, rules, table pipes, fenced code and decorative emoji are not read aloud), and synthesises sentences in order — one `audio.tts_end` closes the whole reply. A barge-in cancels the in-flight sentence and drops the rest of the queue. If the model backend doesn't stream partial text, the host speaks the full (stripped) reply once the turn completes.

## Permission prompts during voice

If the chat becomes waiting for the user on a permission mid-voice-session, the host emits `chat.permission_request` over the WSS. Surface UI:

- Phone / Web: a banner with Approve / Deny + a "say yes / no" voice prompt. The user's spoken response goes through the same Whisper path; host parses "yes" / "no" and emits `chat.permission_response`.

The permission round-trip is text-only on the wire, but the user can answer it either by tap or by speaking.

## Agent-initiated voice

### Mechanism

- Every chat's agent, and every job, has the call tool `patch_call({ reason })` (`09-notifications.md` § `patch_call`) and decides for itself when to use it. The call is for the calling chat; it does not go through the Manager thread.
- With Agents can call you off (Settings → Voice calls), the tool answers that the user has turned calls off and nothing rings.
- A voice session already open → the reason is pushed into it (§ Which surface it reaches).
- Otherwise it rings every linked device (`09-notifications.md` § `patch_call`), with the agent-calling sound (§ Call sounds). On accept, a voice agent call opens on the calling chat with the reason at the end of its start context, and the voice agent opens with it.
- With Answer automatically in hands-free on, the device answers by itself instead of ringing: other playback pauses, the call opens in `hands-free`, the voice agent says why it called, waits for the answer, then hangs up, and playback resumes. On Android this takes full audio focus through a native audio-focus module, so the other app pauses rather than ducks and resumes when focus is released.

Manager initiates a voice call by exercising the same `patch_call` path any chat has.

### The agent ends the call

`patch_end_call({ message?, chatId? })` hangs up the open app call on the calling chat (or `chatId`) so a call the agent started can finish without the user touching a screen. With `message` the agent says it first; the host then closes the audio socket with the reason `ended_by_agent`. Clients treat that reason as a clean hang-up (hang-up sound, bar cleared, no redial, no error), like `transferred`. With no call open it returns `ended: false`. Voice devices are never hung up by it, and subagents do not get it.

### Other chats during a focused-chat voice session

Events from non-focused chats during a voice session are dropped from the audio path. Visual indicators (badges, banner, sidebar) still update. To hear those events spoken, the user switches focus to Manager voice; Manager's queue handling reads them aloud.

## Voice-mode hint to the agent

Patch tags the user-turn message with a `[voice • <surfaceKind>]` (or `[voice • device:<id>]`) prefix before forwarding to the agent, marking the input as spoken. Same metadata pattern as the voice device (`16-voice-device.md`).

Patch adds nothing unseen to the agent's prompt (`principles.md` § No hidden prompt content) — the prefix is metadata-as-data, not a directive. For spoken-friendly replies, the user puts that instruction in the CLAUDE.md of the chat's folder, which the agent reads itself. Absent that, the model's default style stands.

## Concurrency on the host

Multiple voice surfaces can have audio sessions open at the same time (phone + voice device, e.g. partner using kitchen device while user is on phone Manager call). With Groq doing STT remotely, only Kokoro and the AEC pipeline run on the host — the baseline host sizing (`11-deployment.md`) has headroom for ~3 concurrent sessions. Beyond that, size up. With local Whisper the larger sizing handles ~2–3 concurrent.

## Barge-in

The user can interrupt a streaming agent response by speaking. Mechanism (host-side):

- Continue feeding mic audio to Silero-VAD even while Kokoro is streaming TTS to the surface.
- When VAD fires (user is speaking), host stops the Kokoro stream, drops in-flight TTS audio, and routes the new utterance to Whisper.
- Phone and web speakers have hardware/OS-level AEC, so the agent's own TTS playback isn't picked up as user speech. Voice device needs host-side AEC (see `16-voice-device.md`).

On every kind of call, an interrupted reply is cut in the record to what the user actually heard: the voice agent's own record of its reply (on a voice agent call, truncated in the provider's conversation at the point playback stopped) and the reply written into the chat both end there, so the voice agent never believes it said what was never played.

## Voice-input modes — four gestures

Voice into a chat happens in one of four ways. They share the host's STT pipeline but differ in user-facing gesture and overlay UI.

### 1. Voice note (single turn) — press-and-hold OR toggle

Sends a single audio utterance as one user turn into a target chat. Two equivalent gestures:

- Press-and-hold the chat row's mic button (sidebar) or the menu-bar global hotkey, speak, release → sends.
- Tap the same control to start a Superwhisper-style toggle session, speak, `⏎` to send (or tap the control again).

Either gesture, `esc` cancels without sending.

The keyboard hotkeys (`⌘;` in a focused chat, `⌃Space` for Manager) carry the same two gestures, with the keydown as the press and the keyup as the release. Which one it was is decided by how long the key was held: a press shorter than the tap threshold is a tap and opens the sustained session; only a longer press commits on release. A chord is struck and released far faster than anyone can speak, so without that threshold every hotkey press would commit a clip no longer than the keypress itself and the only possible outcome would be a failed transcription.

On a brand-new chat (the `+ New chat` composer's mic, before any first message), the mic dictates into the input exactly as in an open chat: the live words appear in the input itself, after whatever was already typed, and the mic (or the dictate chord) pressed again stops it, leaving the transcript in the box. Nothing is sent until the user presses Send. The live leg needs a real chat on the host, so the composer creates the chat in the chosen folder when the mic starts, the same create-then-act path attachments use, and stays on the new-chat screen.

A note started from a composer APPENDS to what is in it; it never replaces it. The text already typed there travels with the note as its prefix, leads the committed turn, and the transcript follows it, joined by a single space — the same join dictation uses (§ Dictation into the composer). It is ONE turn, not two, and the transcript is never sent on its own while the typed half is dropped. An empty composer sends the transcript alone, with no leading space; a clip that transcribes to nothing still delivers the typed text. The turn as injected is what the surface echoes into its timeline, so the persisted copy reconciles against it rather than duplicating.

Because starting the note lifts that text out of the composer, a note that does not deliver has to give it back. On a failed upload, a failed transcription, an `esc`, or a gesture released before the mic ever started, the typed text returns to the target chat's composer — leading anything typed in the meantime — and the failure itself is surfaced. There is no path on which the words are both un-sent and un-returned: losing a half-written message to an error is the failure this whole mechanism exists to prevent.

Overlay on web/desktop is just the transcript — deliberately NOT a call bar. A single bottom-centred line, persistent across alt-tab, showing `…` until the transcript lands. It carries no other chrome:

- No mic glyph or ripple.
- No chat-name / `LISTENING` / `SENDING` label — while the utterance is committing the same line simply dims (`data-sending="true"`).
- No waveform visualiser.
- No `⏎ send · esc cancel` hint (the gesture that started the note is still held/armed; the keys are in `14-design-web.md` § Keyboard).

That one line must still show that the mic is live. A note is uploaded in one go rather than streamed, so no words are recognised until it is committed and an unchanging `…` is indistinguishable from a dead mic. For the note's whole length the line therefore tracks the recorder's input level (`data-level`, bucketed `0`–`4`), so it visibly answers speech. This is the substitute for the waveform, not a waveform: still one line, still no chrome.

A single-turn note must not look like an ongoing session: the timer and mute/end controls belong to mode 2 only, and they live in the top voice bar, not over the page. Frame 2 of `design/web-hi-fi-menubar.html` shows the superseded heavy capsule.

Mobile keeps its controls. With no keyboard there is nowhere else to put send/cancel, so the mobile voice-note overlay retains its send and cancel buttons, and it names its state instead of tracking level: `Recording… 0:05` with a running timer while the mic is live and the words recognised so far beneath it (the same preview leg dictation uses, fed by a second microphone tap; if it cannot open the failure is shown and the note still records and sends), `Transcribing…` while the clip uploads, then the whole transcript of what was heard (`15-design-mobile.md` § Voice states).

The overlay is pure visual feedback; focus stays with the underlying app so the user can keep typing in it.

An in-flight note owns `⏎` and `esc` wherever focus is — including inside a text field. The overlay carries no controls of its own, so those two keys are the only way to commit or drop it; a handler that bails out when the target is an `<input>`/`<textarea>` leaves the note unendable and uncancellable. The new-chat flow makes that the DEFAULT case: it navigates into the chat it just created, whose composer auto-focuses. So while `voiceStore.note` is set, the composer's own bindings stand down — `⏎` commits the note instead of sending the typed text (which is left untouched in the field), `esc` cancels the note ahead of every other `esc` binding.

For the same reason the composer's mic button ends an in-flight note rather than opening a second, overlapping recording — a note started from the sidebar row, the `⌘;` / `⌃Space` hotkey, or the new-chat composer is still running when the chat composer's mic is the one under the user's cursor.

After send, the audio is committed as a user turn (with the `[voice • <surfaceKind>]` prefix per `principles.md` § No hidden prompt content). The agent's reply routes per the channel-aware rule (see `06-threads-manager-speakers.md` § Reply routing) — typically text in the surface where the gesture happened.

### 2. Voice call (persistent, bidirectional) — sustained session

A continuous voice session, like a phone call. The user opens it by:

- Tapping the phone icon on the Manager row in the menu-bar dropdown.
- Tapping the sustained-voice control — the phone icon in the mobile chat-detail top bar (`15-design-mobile.md` § Chat detail), or the Call button in the web/desktop composer (`14-design-web.md` § Main chat panel). On mobile the composer mic is not a call control: it dictates into the composer only (§ Dictation into the composer), and the call is this separate top-bar phone icon.
- Tapping the hands-free control, which opens the same session in `hands-free` (below) — on the Manager from the web sidebar and the phone's Manager card, and on any chat from the phone's chat-detail top bar.
- Accepting an agent-initiated incoming call (see Agent-initiated voice).

The call control always starts a voice agent call. Its menu — right-click on desktop and web, long-press on the phone — offers Call, Call direct (§ Direct calls), Hands-free and Voice settings, which opens Settings → Voice calls.

The host keeps the WSS audio stream open; the agent speaks via TTS, the user replies, repeated until the user ends the call.

The device plays a sound for each change in the call's state (§ Call sounds), so the user is never left in silence wondering whether the line is live.

A sustained session is NOT a floating capsule. It is a **voice bar**: a strip in flow at the top of the window, present for as long as the session is, in both modes. A capsule was a call UI, and hands-free is not a call — it is a mode left switched on, in which most of what the mic hears is deliberately dropped. Shown as a floating "on call" pill it read as a call that ignored the user.

The bar carries, left to right:

- `ON CALL` / `ON CALL · DIRECT` / `HANDS-FREE` · `<chat>`, naming the mode and the target. The target is the chat's title; a chat that has no title yet reads `New chat`, never its id, and the label does not change while the session is open.
- What the line is doing right now, as one short status: `Connecting…`, `Listening` (call at rest) / `Waiting for you to say “<address word>”` (hands-free at rest), `Hearing you`, `Thinking…`, `Speaking`, `Agent working · 0:42` (a direct call), `Reconnecting…`, `Paused`, or `<what it heard> — not addressed, so not sent` greyed for 8s, long enough to read, when a hands-free session discarded an utterance. The words themselves are in the chat timeline (§ Latency), not the bar.
- Running session timer (`02:14`).
- A mute-mic button, a mode switch (not on a direct call), a pause button, and an end (red phone) button beside it.

Being in flow, the bar pushes the app down rather than covering the transcript, and it persists across alt-tab. On desktop the bar starts clear of the window controls and is draggable like the title bar it sits in. Its text is high-contrast on its background in every state. Mobile foreground service keeps audio alive when the app backgrounds.

While a session is open on a chat, that chat's call control shows it: lit in the live colour, and pressing it ends the session.

On mobile the session lives inside the chat it is on rather than across the top of the window. The chat's own message stream is the transcript — spoken turns and replies land in it as ordinary messages — and the bar docks above that chat's composer. Away from the chat, a small pill stands in for it (`15-design-mobile.md` § Voice states).

On mobile, until the host has acknowledged the session the line is connecting, not listening, and the bar says so in a neutral colour distinct from the live states. A session not acknowledged within 15 seconds (long enough for the host to open a provider's session over a slow network) has failed: its audio is released and the bar stays up naming the failure, with retry and end. A connection lost after that is a drop (§ A dropped call comes back).

#### Pause

Pause is a soft hang-up. The voice session closes, so nothing is listening and nothing is billed, but the call stays in the UI — the bar (or pill) reads `Paused` with Resume and End — and the paused sound plays. Resume opens a new session on the same chat, with a fresh start context, and plays the connected sound. A call pauses:

- from the pause button;
- when headphones are taken out, resuming when they are put back in;
- after the silence timeout, when it is on: Pause when quiet for (Settings → Voice calls; off by default) pauses a call in which nothing has been said by either side for that long. Resume is then by the button only.

A paused call is not announced as live to other devices, and an agent's call rings rather than speaking into it.

#### Call sounds

The device plays each sound itself; none comes from the provider or costs anything. The sounds are defined once (`packages/web/src/lib/callSoundSynth.ts`): the web and desktop app play them from that definition, and the phone plays the same definitions rendered to files.

| State                             | Sound                                                  |
| --------------------------------- | ------------------------------------------------------ |
| Connecting                        | A soft single-note pulse, repeating until connected    |
| Connected                         | A short rising two-note                                |
| Passed to agent                   | A single low tick                                      |
| Reconnecting                      | A muted two-tone, repeating, like a line searching     |
| Reconnected                       | The connected sound                                    |
| Paused                            | Two soft descending notes                              |
| Ended                             | A descending three-note                                |
| Agent calling you                 | A rising three-note triplet, repeated while it rings   |
| Agent working (direct calls only) | Two quiet alternating notes, continuous while it works |
| Failed (the call cannot go on)    | A low falling triple                                   |

#### Session modes

A sustained session runs in one of two modes. Both hold the microphone open for as long as the session lasts; they differ only in what a spoken utterance means. The user switches between them mid-session from the bar; nothing is torn down or reopened, because the transport, the chat and the audio plane are identical.

| Mode         | Your speech                           | Its speech            |
| ------------ | ------------------------------------- | --------------------- |
| `call`       | every utterance is a turn             | every reply is spoken |
| `hands-free` | only an addressed utterance is a turn | every reply is spoken |

`call` is the phone call: a continuous conversation with your attention on it. Like any phone call it carries on when the phone goes in a pocket.

`hands-free` is the line left open — for plastering a wall, for a long drive. It never ends itself on silence, so there is nothing to re-open when the user has something to say an hour later, and it does not treat every noise in the room as a turn. Because the mic is open throughout, it cannot share the device with a podcast; the user who wants one plays it under `auto-notify` instead (`09-notifications.md` § Reaching the user).

An utterance in `hands-free` is addressed when it opens with the address word — tolerating a one-character STT mishearing for address words of 4+ characters, since Whisper regularly returns "Patch" as "Hatch" or "Catch" and an exact match silently drops a deliberately addressed utterance — or when it lands within 30 seconds of Patch last finishing speaking, so answering, and continuing that exchange, needs no address word and no gesture. Everything else the mic hears is discarded at the host after transcription and never reaches a chat, which is what makes it safe to leave a headset mic open in a room with other people in it. The address word defaults to `patch` and is set in Settings.

Barge-in, mute and permission prompts behave identically in both, and both hold audio focus and the mobile foreground service for the session's whole length: the session IS what the device is doing.

This addressed-or-continuing rule — what counts as a turn once a session is open — is the piece the voice device (`16-voice-device.md`) reuses for its own wake-triggered conversations. Its session _lifecycle_ is different: there's no toggle to hold it open on a standalone speaker, so a device session opens on the on-device wake word and closes once the exchange lapses past the continuation window, rather than staying open until the user explicitly ends it. A one-line request and a ten-minute conversation both fit the same rule — the length is whatever the pauses in the conversation say it is, never a fixed timeout.

#### Which surface it reaches

A deliberate interrupt goes to the surface the user is actually at. When a sustained session is open, that session is the answer. When several are, it is the one whose surface most recently showed activity — a heartbeat, a keystroke, an utterance — because that is the host the user is in front of. With no session open at all, what happens is the reach setting's business (`09-notifications.md` § Reaching the user).

#### Speaking with no session open

Under `auto-notify` an interrupt is spoken on a surface that is not in a session at all (`09-notifications.md` § Reaching the user). The surface opens a short audio session for it — role `voice-call`, mic never started — plays the synthesised message, and closes. Because no microphone is held, a podcast can play underneath: the surface takes transient-exclusive audio focus for the length of the message, which pauses it, and releases focus when the message ends, at which point it resumes on its own.

There is no reply path. `auto-notify` is monitoring, not conversation: to answer, the user opens a session.

## Dictation into the composer

The composer's mic, on web/desktop and on mobile, dictates: it puts words into the chat's input for the user to edit and send. It never commits a turn of its own — the composer decides that.

On the Whisper engine (§ Dictation engines), the host's Whisper transcribes both the upload and the preview session. The clip is captured locally and the authoritative transcript comes back from a single upload on the gesture end, so nothing the user said depends on a socket having opened in time and a fast tap-and-release cannot lose the recording. Alongside that capture, and fed from the same microphone rather than a second one, the surface opens an audio session purely to receive the interim transcript (§ Live transcript). That session is always ended as cancelled, so the host never treats a dictation as a note.

Nothing but opening the capture itself sits between the press and the first recorded audio, so the speaker's first word is not lost and a brief gesture still records something. On mobile that means the permission check and the audio-mode switch are resolved when the composer appears rather than on the press, since a hold gesture is only recognised after a hold threshold has already elapsed. On mobile a tap starts a dictation and a second tap ends it; a long-press is dictation mode (§ Dictation mode), not hold-to-talk.

The interim transcript renders in the input as a preview (§ Live transcript), following whatever the user has already typed and updating as they speak. On the gesture end the preview is dropped and the uploaded transcript lands in its place as ordinary editable text.

On web/desktop the input keeps focus throughout but is read-only while the mic is live and while the transcript uploads, because the live words are written into it; it is editable again as soon as they land. A dictation is ended only by the gesture (the mic, the dictate shortcut again, or a release after a hold) and never sends; only the send button or ⏎ does. The dictate shortcut reaches the new-chat screen's composer in the same way. On mobile, starting a dictation dismisses the soft keyboard — there is nothing to type while talking, and the keyboard would take the space the live words need. A listening strip above the input says the mic is live (a pulsing indicator, `Listening`, and the elapsed time), then `Transcribing…` until the words land. The keyboard does not come back on its own when they do; the input stays editable, so a tap on it brings the keyboard back to edit.

While voice is live — a dictation recording or a note in flight — the input shows no placeholder. The preview is drawn in the same box as the input's own placeholder, so on an empty composer the two render on top of each other and the live words are read through `Type a message`. Naming an empty field is pointless while the user is talking into it; the placeholder returns when voice ends.

The preview is the expendable half of that pair. If its session cannot open, or breaks mid-recording, the recording carries on and the transcript still lands — but the failure is surfaced, since a live leg that has quietly stopped working is otherwise indistinguishable from a quiet one. On a backend that offers no partials no preview appears and nothing else about dictation changes.

A dictation that produces no text says which of three things happened: no audio was captured at all, the clip was too short to hold an utterance and was not uploaded, or the clip was transcribed and held no speech. None of the three is silent, because a dictation that appears to do nothing is indistinguishable from a broken microphone.

An in-flight dictation is discarded without transcribing by `esc` on web/desktop, and on mobile by a clear control at the left of the action row, which stands in for the attach buttons while a dictation is in flight.

### Speech to text

What reads speech in a host-speech conversation (§ Host speech engines) is the account setting `voiceConfig.speechToText`, not the host's `WHISPER_BACKEND`. Settings → Dictation → Speech to text offers `Groq Whisper` (`groq`, the default), `Whisper on host` (`whisper`), `Parakeet on host` (`parakeet`) and `ElevenLabs Scribe` (`elevenlabs`). It is read on every new session, so a change applies to the next call. The dictation tidy-up row (**Tidy up each phrase with …**) uses the same engine.

Each host resolves the choice itself: `groq` and `elevenlabs` need that key on the host, `whisper` needs the Whisper component installed (its model present), `parakeet` needs `PARAKEET_MODEL_DIR`. A host that cannot run the chosen engine refuses the session with `audio.error {whisper_unavailable}` whose message names the engine and what is missing — never answered by another engine. `WHISPER_BACKEND` still decides the host's own Whisper for dictation, voice notes and meetings.

### Dictation engines

Each signed-in device picks where its dictation's words come from (`deviceDictation`, keyed by surface id). Settings → Dictation → Engine lists every device at once, each with only the engines it can run — a phone: `Built-in` · `Deepgram` · `ElevenLabs` · `Host server` · `Whisper`; the desktop app: `Deepgram` · `ElevenLabs` · `Host server` · `Parakeet (free, on device)` · `Whisper`; a browser: the same without Parakeet — then **Tidy up each phrase with** the Speech to text engine. A dictation runs on its device's own engine (`audio.session_start.surfaceId`; a voice-note upload carries `surfaceId` too); a device that has not picked one runs on its kind's engine in `voiceConfig.dictation`, whose default is the phone's own recogniser and the host's Whisper. A stored choice the device cannot run is refused with a sentence naming the fix, never swapped. Meeting transcription is on its own page, Settings → Meetings.

- **`Whisper`** — the host's Whisper, the flow above: a local recording uploaded on the gesture end, with a preview made by re-reading the recording so far. Whisper does not listen continuously, so the preview arrives about once a second at best, slows as the recording grows, and is rationed by the Whisper provider's request limit. It is free on a host running Whisper itself.
  - **Host transcriber `parakeet`** (the speech setting `parakeet`, with `PARAKEET_MODEL_DIR`): the host's Whisper is NVIDIA Parakeet TDT v3 run on the host's own CPU through sherpa-onnx — no network trip, no request limit, no per-minute cost, and it punctuates and capitalises itself. Used for the upload on stop, every tidy-up and the `On this host` engine's per-phrase read. It is an offline model, so as the preview of the `Whisper` engine it re-reads the recording (bounded: sentences settled more than about five seconds behind the live edge are kept as read). A compressed clip (a phone's m4a) is decoded with `ffmpeg`, which the host must have; a missing model, broken install or missing `ffmpeg` is an error, never another engine's answer. The model loads when the host starts.
- **`On this host`** — no key, no network, no per-minute cost. Two models on the host, neither re-reading audio for the live words. A streaming speech model (NVIDIA's cache-aware streaming FastConformer transducer, 480 ms chunks, through sherpa-onnx; `PARAKEET_STREAMING_MODEL_DIR`) takes each chunk of the microphone once and keeps its state, so the words appear as they are spoken — lower-case and unpunctuated, for watching. When the speaker pauses (half a second of quiet after speech, or a phrase of 25 seconds), the phrase just finished is cut from the session's own copy of the audio and read once by the host's accurate transcriber (Parakeet TDT, above) and its text replaces the live words in place while the speaker carries on. On the gesture end the surface asks the host to finish (`audio.dictation_finish`); the host flushes the streaming model, waits for the last phrase's accurate read, and answers with the phrases joined as one `audio.transcript_final`. Stopping therefore waits for one phrase, never for the whole recording, and can never land text worse than the preview the user was looking at; the recording is not uploaded or read a second time, and the tidy-up setting does not apply (every phrase is always read accurately). Measured on the netcup host (16 cores): the streaming model costs about 0.17 of one core per dictation while the speaker talks, the first words show about half a second behind speech, and stop-to-text was about one second for a short phrase. A streaming model that will not load or dies fails the dictation and says so; a failed accurate read is reported once and that phrase keeps its live words. A host with no `PARAKEET_STREAMING_MODEL_DIR` refuses the session, naming it. A host loads both models when it starts. An older client that has not learned this engine cannot read a setting that chooses it, so it is chosen deliberately in Settings and is not the default.
- **`Deepgram`** — with its key in Settings → Keys. The host streams the microphone to Deepgram as it arrives and the words come back as they are spoken, in well under a second. On the gesture end the phone asks the host to finish (`audio.dictation_finish`); the host flushes the stream and answers with the whole dictation as one `audio.transcript_final`. A stream that cannot open or dies mid-dictation fails the dictation and says so; it is never answered by another engine. On web and desktop the live words come from the same stream, and the gesture end asks the host to finish (`audio.dictation_finish`) and lands its `audio.transcript_final` — the tidied text when tidy-up is on; the recording is not uploaded or read a second time. A stream that has failed fails the dictation.
- **`On this host`** — needs `PARAKEET_STREAMING_MODEL_DIR` (a streaming FastConformer transducer, run through sherpa-onnx in worker threads) and a host transcriber, ideally `parakeet`. Nothing leaves the host and nothing re-reads audio for the live words: the streaming model takes each chunk of the microphone once and keeps its state, so words appear as they are spoken (lower-case, unpunctuated). When the speaker pauses (about half a second, or after 25 seconds without one) the phrase just finished is cut from the session's own copy of the audio and read once by the host's accurate transcriber, whose version replaces the live words in place. The final is those accurate reads joined. Stopping (`audio.dictation_finish`, as on Deepgram; the recording is not uploaded) flushes the streaming model and waits only for the last phrase's accurate read, so what lands on stop is never worse than the preview. Measured on the netcup host: about 0.17 of a core per live dictation, first words within about a second and a half of the start, and about a second from stop to the final. A streaming model that will not load or dies fails the dictation and says so (`whisper_unavailable`); a failed accurate read is reported once and that phrase keeps its live words. A host with no streaming model refuses the session with the same code. Tidy up with Whisper is not needed on this engine: the accurate read is always on. A settings value of `host` is unknown to clients older than this change, so choosing it is opt-in per account.
- **`Parakeet on this computer`** (computer only; `dictation.computer: 'local'`) — the same two Parakeet models as `On this host`, run by the desktop app on the computer being dictated into rather than on the chat's host: no network trip, and it settles which machine is meant when the account has a Mac and a Linux host. The app keeps its own copy of the models under its user-data folder, downloaded on demand from Settings → Dictation (the row shows `Not downloaded` with the size and a Download button, then `Downloaded on this computer`). The composer opens no audio session: it passes the microphone's PCM to the app over IPC and the app answers with live words and, on the gesture end, the final — each finished phrase read once by the accurate model, exactly as on the host. A dictation without the models fails naming what is missing and pointing at Settings → Dictation; in a browser the engine says it only runs in the desktop app. A host refuses a session or clip upload that asks for it (`whisper_unavailable` / `transcription_failed`), and Keep dictating is not offered on it. Nothing falls back to another engine.
- **`Built-in`** (phone only) — the phone's speech recogniser makes the words on the phone, fed the same microphone capture Patch is already recording (never a second capture of the microphone). It needs Android 13 or newer and a speech recognition service on the phone, and says so when either is missing. A clip from a phone on this engine — a voice note, a dictation-mode utterance — is read by the host's Whisper.

- **`ElevenLabs`** — Scribe, with `ELEVEN_LABS_API_KEY` in Settings → Keys. Streams exactly as Deepgram does (realtime `scribe_v2_realtime`; the finish commits what Scribe still holds), clips are read by `scribe_v2`, and a failure is `elevenlabs_unavailable`, never another engine. Tidy up does not apply to it. The same key serves the local voice tier: the speech setting `elevenlabs` reads each utterance with Scribe and streams the live words as they are spoken. Scribe's dollar rate is not published per hour, so its usage (audio seconds) is recorded in the voice ledger and its cost is left off the summary line.

On the two live engines, Deepgram and Built-in, the live words are the transcript: nothing is transcribed a second time when the user stops. **Tidy up with Whisper** applies to both: each time the speaker pauses, the phrase just finished is read once by the host's Whisper and Whisper's version replaces it in place while the speaker carries on, so by the time they stop only the last phrase is left to tidy and the finish waits for it for as long as it takes (bounded by Whisper's own request timeout), so stopping never lands text worse than the tidied preview. A failed tidy-up is reported once and the live words for that phrase stand. A phrase's stretch of audio runs to the end of the recording when its last words were still interim at the stop, so Whisper hears them.

A dictation setting saved before the phone and the computer had their own engines is read as follows: `deepgram` stays Deepgram on both, the phone-recogniser switch becomes the phone's Built-in, and the retired `local` / `gemini` / `openai` transcribers become Whisper.

### Dictation mode

The composer mic can be left open. A plain click or tap is ordinary dictation; right-click it on web/desktop, or long-press it on mobile, and a small menu offers **Keep dictating** and **Voice settings**, which opens the Voice page of Settings. Chosen, the mic stays listening: the user keeps talking, and each time they finish what they were saying it is transcribed and sent as its own message, then the mic carries on listening for the next thing. It is dictation, not a call — nothing speaks back and no agent voice is involved — but it can sit open in the background so the user can talk message after message without returning to the composer.

- **Cutting utterances.** The surface listens to its own microphone capture and cuts it into utterances: speech begins on the first loud frame (a little audio from before it is kept so a soft start is not clipped). A blip shorter than about 0.3 seconds is not an utterance and is dropped. An utterance that runs two minutes without a pause is cut there anyway. Silence alone never sends anything. Timing is counted in audio samples, not clock time, so the same audio always cuts the same way.
- **Knowing when the speaker has finished.** A pause is not the end of a thought, so a fixed silence either cuts people off mid-sentence or makes every message wait. With **Detect when I've finished** on (the default), each 0.7-second pause after speech sends the utterance so far to `POST /api/voice/turn-check`; the server relays it to the host (`patch.voice.turn_check_request`), which runs Smart Turn (pipecat-ai/smart-turn v3.2, BSD-2, shipped in the host artifact as `smart_turn.onnx`) on its last eight seconds and answers with the probability the speaker has finished. At 0.5 or more the utterance ends there and is sent; below it the mic keeps listening and the next pause asks again. A verdict that arrives after speech has resumed is ignored, so it can never cut a sentence that carried on. Whatever the model says, a long silence — **Send anyway after a pause of**, 10 seconds by default (2, 3, 5, 8, 10 or 15 s in Settings → Dictation → When to send; any value from 1 to 30 s through `patch settings set dictation-pause`) — ends the utterance. With detection off, that pause alone decides. Both are shared settings, so every surface behaves the same way.
- **Sending.** Each utterance is uploaded and transcribed exactly as a tap-dictation clip is (§ Dictation into the composer), strictly in the order spoken, and its text is sent as a message. Anything already typed in the composer leads the transcript, joined by a single space, as with a voice note. A transcript that is empty sends nothing. If the message cannot be sent, the words are put in the input and the failure shown.
- **Not mistaking noise for speech.** Speech models invent text from silence and steady noise ("Thank you.", "Thanks for watching", "[BLANK_AUDIO]"). A transcript that is only a bracketed sound tag, or only one of a short list of stock phrases over less than two seconds of actual speech, is dropped rather than sent. The same phrase spoken for longer than that is sent.
- **Leaves the scroll alone.** A message sent by dictation mode does not scroll the chat to the bottom, as a message the user sends themselves does (spec/14 § Main chat panel): they may be reading a reply. If they were already following the latest message, it stays followed.
- **Live preview.** While an utterance is being spoken its interim words show greyed in the input, as in tap-dictation (§ Dictation into the composer), so the speaker can see what is being captured; they clear when the utterance ends and the message is sent. A preview failure is shown and never ends the mode.
- **Status and ending.** While it is open the composer shows `Dictating` (on web/desktop `Dictating…`), changing to a sending state while a transcript is pending, and the mic reads as active. Clicking or tapping the mic, `esc` on web/desktop, the clear control on mobile, or leaving the chat ends it and releases the microphone; whatever was said but not yet cut into an utterance is dropped. It cannot be started while a tap-dictation or a voice note is in progress.
- **Failures are shown.** A microphone that cannot open, a failed transcription, a failed turn check (a host without the model, or one too old to answer within ten seconds) and a refused backend each surface as an error and are never silent; none of them ends the mode. A failed turn check leaves that utterance to the long pause.

## Overlay surfaces — placement summary

The same overlay vocabulary applies wherever voice is initiated:

| Initiated from                                       | Overlay                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| Sidebar row mic button (web)                         | Voice-note overlay                                         |
| Long-press chat row (mobile)                         | Voice-note overlay                                         |
| Menu-bar global hotkey                               | Voice-note overlay (target = Manager)                      |
| Menu-bar dropdown mic icon on Manager row            | Voice-note overlay (target = Manager)                      |
| Menu-bar dropdown phone icon on Manager row          | Voice bar in `call` (target = Manager)                     |
| Chat-header voice control                            | Voice bar in `call` (target = current chat)                |
| Composer mic (mobile or web/desktop chat)            | None — dictation lands in the composer input               |
| Chat-detail phone icon (mobile)                      | Call bar docked in that chat (target = current chat)       |
| Call menu → Call direct (any surface)                | Call bar in `call`, direct (target = current chat)         |
| Hands-free control (web sidebar, mobile chat detail) | Voice bar (mobile: call bar) in `hands-free` (Manager)     |
| Long-press the bottom Voice tab (mobile)             | Voice-note overlay (target = Manager)                      |
| Agent-initiated incoming call (Manager)              | Incoming-call banner → on accept, the voice bar / call bar |

## End-to-end voice transport

The host STT/TTS engine above is shared, but the surface→host transport differs by gesture and by surface. Both legs are defined here so the full path is unambiguous.

### Voice note (single utterance)

- Every surface records the clip locally and commits it as ONE upload to `POST /api/voice/note` on the gesture end. The server hands it to the chat's host, which runs Whisper once over the whole clip and injects exactly one user turn tagged `[voice • <surfaceKind>]`; cancelling discards the clip without transcribing it. Nothing is streamed, so no interim transcript exists for a note; the overlay shows input level (web/desktop) or a running timer (mobile) instead (§ 1. Voice note).
- The upload path is chosen over a streamed one because a note must survive the gesture that is hardest to serve: a tap-and-release shorter than a socket takes to open. With the audio buffered locally there is no round trip on the critical path and no way for a fast note to end up empty. A failed record or upload is surfaced to the user, so a dropped note is visible.

### Voice call (sustained)

- All surfaces get a one-shot token from `POST /api/voice/token`, where the server mints it, open the audio WSS, exchange `audio.session_start`, then stream PCM16 both directions (`audio.pcm16` up, `audio.tts_chunk` down) alongside `audio.transcript_*`, `audio.barge_in`, and `audio.session_end`.
- On mobile the PCM transport is native (`expo-av` alone cannot stream PCM): the up leg is `PatchVoiceMic` (an `AudioRecord` PCM16 tap) and the down leg is `PatchVoiceTts` (an `AudioTrack` streaming sink that plays the host's 24 kHz PCM as it arrives, so the user hears the reply — barge-in flushes it). The same two modules carry every backend: a hosted engine's audio arrives as the same 24 kHz PCM on the same socket. If either native module can't init, the call is torn down with a surfaced error. Mobile voice calls also take Android `AUDIOFOCUS_GAIN` (full, not duck) through a native audio-focus module, since `expo-av` only offers ducking.

## Cross-refs

- Voice device (same engine, different hardware): `16-voice-device.md`
- Notification-via-voice channel routing: `09-notifications.md`
- Manager / speakers thread role: `06-threads-manager-speakers.md`
- Focused-session state (`chat_state`): `04-chats-and-folders.md`
- Host sizing for concurrent voice sessions: `11-deployment.md`
