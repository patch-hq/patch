# Voice devices

A voice device is anything that listens for the user and plays Patch's reply: a smart speaker, a Raspberry Pi with a microphone, an ESP32 board. Patch does all the intelligence. A device streams the user's voice up, plays the audio that comes back, and shows what the session is doing. It never knows which agent answers or where that agent runs.

Patch's side is one endpoint on the server, described here. Device firmware lives outside Patch. The reference device is the Home Assistant Voice Preview Edition running the firmware in [patch-hq/patch-voice-pe](https://github.com/patch-hq/patch-voice-pe), which has its own releases, setup page and updates.

## Setting a device up

In Settings → Voice → Voice devices, Add device asks for a name and creates a long-lived device token, shown once. The device is given two things: the server's address and that token. The device keeps them and needs nothing else, so it works on any network.

The token is a surface credential of kind `voice-device` with no expiry. Revoking the device in the same list ends it: the server refuses the token from then on and closes a connection that is already open within a minute.

## Connection model

```
device ──control WSS──▶ server /device/control      (persistent)
       ──audio WSS────▶ server /audio/<sessionId>   (per conversation)
                          │
                          └── relayed to the host that owns the target chat
```

The device opens both connections to the server, over TLS. On a wake the server opens the session itself: it picks the target chat, checks that an online host owns it, mints the voice token and records which host the session belongs to. The audio WSS is then relayed to that host exactly as app voice sessions are (`07-voice-app.md`, `03-wire-protocol.md` § Audio relay over the host link). Speech recognition and speech run on that host.

Every device's wake-word conversations go to the Manager. If no online host owns it, the server answers the wake with an `error` frame saying so and opens nothing.

## Control WSS

`wss://<server>/device/control`, with `Authorization: Bearer <device token>`. JSON frames.

```
device → server
  { type: "hello", deviceId, fwVersion, muted }   first frame; deviceId must be the token's own
  { type: "wake_detected" }                       start a conversation
  { type: "session_end", reason }                 "vad-timeout" | "user-button" | "agent-finished"
  { type: "mute_changed", muted }

server → device
  { type: "session_start", sessionId, voiceToken, accountId, chatId,
                           conversational, followupMs? }
  { type: "error", message }
```

A bad or revoked token, or a `hello` naming a different device, closes the socket with code 4401.

`followupMs` is how long the device stays open for a follow-up after a reply, in milliseconds. Patch decides it (5000); a device that gets none uses its own default.

## Audio WSS

`wss://<server>/audio/<sessionId>`. The first frame is `audio.session_start` with the `voiceToken`, `accountId`, `chatId` from `session_start`, `surfaceKind: "device"`, the device's `deviceId` and `role: "voice-device-conv"`. After that:

- Device → Patch: binary PCM16 mono at 16 kHz, about 20 ms per frame.
- Patch → device: binary PCM16 mono at 48 kHz (the reply), and JSON events:
  - `audio.state` with `state` one of `listening`, `transcribing`, `thinking`, `speaking`
  - `audio.transcript_final` once the user's words are in (`addressed: false` when Patch decided they weren't for it)
  - `audio.tts_chunk` when reply audio starts, `audio.tts_end` when it is complete
  - `audio.error`

Patch normalises reply audio to near full scale. How loud it plays, how it is shown and how interruption works are the device's business.

## A conversation

1. The device hears its wake word (or a button) and sends `wake_detected`.
2. It opens the audio WSS from `session_start` and streams the microphone.
3. Patch transcribes each utterance, posts it into the target chat tagged `[voice • device:<deviceId>]`, and speaks the reply.
4. After a reply the device stays open for `followupMs`. If the user speaks, the exchange continues without the wake word; if not, the device sends `session_end` and goes back to waiting for its wake word.

The target chat is persistent, so everything said by voice is there in text afterwards.

## Answering engines

The device setting in Settings → Voice chooses how a device's conversation is answered, the same matrix as the app surfaces (`07-voice-app.md` § Voice is a config matrix). The device is unaffected by the choice: it streams the same audio either way.

A hosted engine (OpenAI, Gemini, ElevenLabs) answers the device itself and hands real work to the Manager, so a reply does not wait for a Manager turn. OpenAI is the fastest of the three for a device: its session is ready in about a second, where ElevenLabs creates an agent per conversation and Gemini waits seconds for the end of speech.

## Speaking aloud

A device is heard out loud in a room, by whoever is there. Every device conversation, on any engine, carries the account's `voiceDevicePrompt`: the hosted voice has it in its instructions, and a turn that reaches the Manager from a device (a direct turn or a hand-off) carries it as a note. Patch's default asks for short spoken replies and nothing private said aloud unless the speaker may hear it. It is edited in Settings → Voice calls → Speaking aloud, and with `patch settings set voice-device-prompt`, so the Manager can change it when asked.

## Who is speaking

A voice profile is a person Patch recognises by voice (`voiceProfiles` in the shared settings, at most 20): a name, an access level, notes for when they speak, and a voiceprint. A voiceprint is the mean speaker embedding of the person's samples: 256 numbers from WeSpeaker's ResNet34 model, run by sherpa-onnx on the host, which sit close together for the same voice. A match needs a cosine similarity of at least `voiceMatchThreshold` and a lead of 0.05 over the next profile; otherwise the speaker is not recognised. Settings offers it as How sure to be: Relaxed (0.65), Normal (0.75, the default) or Strict (0.85). The default leans strict because a wrong match hands a stranger someone else's access, where a missed one only treats a person as a guest until they speak again. Measured on synthetic voices, which sit closer together than real people: the same voice scores 0.92 or more across sentences, different voices up to 0.83. Recent voices show their score, so the level can be chosen from what the devices actually hear.

| Access                   | The voice                                           | The agent                                                                                           |
| ------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Owner                    | Has the chat's briefing, `look_back` and live notes | Hand-offs go through, headed `[Spoken by <name>, the account's owner. …]`                           |
| Household                | No chat history                                     | Hand-offs go through, headed `[Spoken by <name>, a member of the household. About <name>: <notes>]` |
| Guest, or not recognised | No chat history                                     | No hand-off tool; a hand-off that arrives anyway is refused by the host and never reaches the agent |

Recognising speakers applies when the account has at least one profile with a voiceprint, the device runs on OpenAI, and the host has the speaker model (the `speaker` component, `02-host.md` § Optional components). Then:

- The session starts treating the speaker as not recognised.
- One reply at a time: a reply asked for while another is still going (a hand-off's answer being spoken) follows it.
- The provider's VAD no longer answers by itself. When an utterance ends, the host cuts it from its own copy of the microphone, takes its voiceprint (on a worker thread, 70–200 ms), settles who it was, updates the session's instructions and tools if the speaker changed, and only then asks for the reply.
- An utterance under a second ("yes", "thanks") is too short to tell, and the previous speaker stands.
- What the speaker said is written into the chat as `<name>: <words>`, or `Unrecognised voice: <words>`.

On another engine the profiles are not applied and the host logs so for each session; Settings says so beside the profiles. The rules are enforced in the host, not left to the prompt: a stranger gets no history and no agent whatever they say.

Every utterance on a device (with or without profiles) leaves its voiceprint and words in the host's recent voices, the last 20 in memory, so the user can enrol a person from what a device actually heard. Settings → Voice → Who is speaking adds people, sets their access and notes, and builds a voiceprint from either a sample recorded in the browser (8 s) or a recent voice ("This is Eleanor"). Each sample is folded into the running mean (`addVoiceSample`). The voiceprints are computed on the Manager's home host (`03-wire-protocol.md` § Voiceprints).

## Announcements

`patch_speak` and `patch_notify(channel: 'speakers')` are spoken on a connected device (`09-notifications.md` § speakers). The server opens a session on the chosen device for the calling chat, with `conversational: false`, and asks that chat's host to speak the message as soon as the device joins. The device then behaves as after any reply: it stays open for the follow-up window. With no device reachable, the notify is pushed instead. `patch_call` rings the app surfaces only, never a voice device.

## Timers and alarms

The voice has `set_timer`, `list_timers`, `change_timer` and `cancel_timer`. The state is Patch's, held on the server (`timers.json` in its data directory), not in the voice session: a conversation ends seconds after "set a timer", and the timer outlives it and a server restart. A host's voice tool asks the server over the host link (`voice.timers.request` / `voice.timers.response`); the answer is the sentence the voice says back.

- A timer is `seconds` from now; an alarm is a wall-clock time (London local). Each has an optional label and remembers the device that set it.
- "How are my timers" is `list_timers`, which only reads. Naming a timer by label or id picks it; an ambiguous name is reported back, never guessed.
- Every connected device gets a `timers` control frame on connect and after each change: the running timers with `endsAt` (and `serverNow`, so the device can convert to its own clock) and whether it set each (`own`). The device draws the ring from it: the countdown and its colours for its own timers, and the alarm sound when one is `ringing`.
- A ringing timer sounds on the device that set it, or on every connected device when the setter is offline. The device sends `timer_stopped` when the user stops it (button or voice); nobody stopping it silences it after ten minutes.
- Apps and displays receive `timers.changed` on the surface socket with every live timer, `running` or `ringing`, and draw their own countdown.

## Cross-refs

- App-surface voice and the voice config matrix: `07-voice-app.md`
- The Manager: `06-threads-manager-speakers.md`
- Audio relay over the host link: `03-wire-protocol.md`
- Surface credentials and revocation: `10-auth.md`
- Voiceprints over the host link: `03-wire-protocol.md` § Voiceprints
