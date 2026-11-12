# Voice devices

A voice device is anything that listens for the user and plays Patch's reply: a smart speaker, a Raspberry Pi with a microphone, an ESP32 board. Patch does all the intelligence. A device streams the user's voice up, plays the audio that comes back, and shows what the session is doing. It never knows which agent answers or where that agent runs.

Patch's side is one endpoint on the server, described here. Device firmware lives outside Patch. The reference device is the Home Assistant Voice Preview Edition running the firmware in [patch-hq/patch-voice-pe](https://github.com/patch-hq/patch-voice-pe), which has its own releases, setup page and updates.

## Setting a device up

In Settings → Voice → Voice devices, **Add device** asks for a name and creates a long-lived device token, shown once. The device is given two things: the server's address and that token. The device keeps them and needs nothing else, so it works on any network.

The token is a surface credential of kind `voice-device` with no expiry. Revoking the device in the same list ends it: the server refuses the token from then on and closes a connection that is already open within a minute.

## Connection model

```
device ──control WSS──▶ server /device/control      (persistent)
       ──audio WSS────▶ server /audio/<sessionId>   (per conversation)
                          │
                          └── relayed to the host that owns the target chat
```

The device opens both connections to the server, over TLS. On a wake the server opens the session itself: it picks the target chat, checks that an online host owns it, mints the voice token and records which host the session belongs to. The audio WSS is then relayed to that host exactly as app voice sessions are (`07-voice-app.md`, `03-wire-protocol.md` § Audio relay over the host link). Speech recognition and speech run on that host.

Wake-word conversations go to the Manager. If no online host owns it, the server answers the wake with an `error` frame saying so and opens nothing.

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

`followupMs` is how long the device stays open for a follow-up after a reply, in milliseconds. Patch decides it (5000 today); a device that gets none uses its own default.

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

## Announcements

`patch_speak` and `patch_notify(channel: 'speakers')` are spoken on a connected device (`09-notifications.md` § speakers). The server opens a session on the chosen device for the calling chat, with `conversational: false`, and asks that chat's host to speak the message as soon as the device joins. The device then behaves as after any reply: it stays open for the follow-up window. With no device reachable, the notify is pushed instead.

## Not built yet

`patch_call` does not ring voice devices; calls reach the app surfaces only. Per-device target chats are not configurable: every device's wake-word conversations go to the Manager.

## Cross-refs

- App-surface voice and the voice config matrix: `07-voice-app.md`
- The Manager: `06-threads-manager-speakers.md`
- Audio relay over the host link: `03-wire-protocol.md`
- Surface credentials and revocation: `10-auth.md`
