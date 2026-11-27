# Voice calls batch (27 Nov 2026)

Defined with Tom on a call, built and released as one batch. The mockups are in
`design/voice-handoff-chat/` (settings, call menu, hand-off rows, direct call,
sounds) and `design/voice-state-model/` (who knows what, today and proposed).

## Items

1. **Undo** PRs #1122, #1125, #1126 and #1128. #1127 stays closed.
2. **Hand-off state for the voice agent**, the same on every provider:
   - "Pass to agent" answers at once with "received". The voice agent says it has passed it on and carries on talking.
   - A "check status" tool, called only when needed, returns each open hand-off (what was asked; waiting, being worked on or answered; time since sent) and the chat agent now (idle or working, the step it is in and for how long, its last message and its age).
   - The answer is pushed in when the chat agent finishes; the voice agent says the gist.
   - A chat agent reply that ends a turn during a call, not in answer to a hand-off, is pushed in the same way. Progress messages are not.
   - The voice agent no longer gets every chat-agent message as a background note.
   - Nothing interrupts the chat agent's work.
3. **Call start context** (also on a chat switch): chat name and goal; questions to the user still open; a catch-up of everything before the last 4 messages (what the chat is for, decisions, done, in progress, open), written by a cheap model while the call connects; the last 4 messages in full with their times; "look back" for anything older.
4. **Switch chat** voice tool: the call carries on in the other chat with that chat's start context. A pending answer from the old chat still arrives, labelled with its chat.
5. **Voice instructions are the user's**: a default the user edits in Settings, nothing added on top. No tone directions in the default.
6. **Settings → Voice**, one choice revealed after another:
   - Voice agent: provider (Gemini, OpenAI, ElevenLabs) → model (fetched from the provider) → voice (fetched) → How it sounds, only the provider's own controls:
     - ElevenLabs: speech model, tone, expressive mode, stability (Expressive ↔ Steady), similarity, speed (Slower ↔ Faster), reply eagerness (Patient / Normal / Eager).
     - OpenAI: tone, speed.
     - Gemini: tone, match my tone.
   - Tone is raw text kept per voice. It goes into the voice's instructions as written; for ElevenLabs v3 models any `[tags]` in it are also sent as suggested audio tags.
   - Calm defaults: ElevenLabs stability 0.7, speed 0.95, reply eagerness Patient.
7. **Direct calls** (no voice agent: speech to text → chat agent → read aloud, all on the device you call from):
   - Settings lists every linked device in one place. Each device: speech to text → its model → text to speech → its model → voice → its sound controls (ElevenLabs: tone, stability, similarity, style, speed; OpenAI: tone, speed; Kokoro: speed).
   - Only engines the device reports having (on-device ones it has installed, cloud ones the account has a key for). A device with none shows "No speech engine" and cannot make a direct call.
   - The call button always starts a voice-agent call. "Call direct" is in the call button's menu (right-click on desktop, long-press on the phone).
   - End of turn uses Smart Turn on the device.
8. **Agents can call you**: every chat's agent has a call tool and decides when to use it; it rings every device. Settings: "Agents can call you" and "Answer automatically in hands-free" (playback pauses, the agent speaks, waits for the answer, hangs up, playback resumes; needs native audio focus on Android).
9. **Pause**: a pause button next to hang up. A soft hang-up that leaves the call in the UI to resume. Headphones out pauses; back in resumes.
10. **End from the other device**: an End button next to "Switch call" on the device the call moved away from.
11. **Recovery**: the phone detects a lost connection from a host heartbeat (about 3 s with none), plays "reconnecting", keeps retrying, plays "reconnected". Nothing said while down is kept.
12. **Call sounds**, played by the device (see `design/voice-handoff-chat/sounds/`): connecting A, connected A, passed to agent A, reconnecting F, reconnected A, paused B, ended A, agent calling you C, direct-call agent working E.
13. **Hand-off rows in the chat** (version B): one collapsed row per hand-off, "Asked the agent", with waiting / working / answered in Ns; opens to Voice → Agent and Agent → Voice. Placed where it happened and labelled with who sent it.
14. **Phone call logs**: why audio stopped (signal, audio focus, device change), connection quality, per-step timing; sent to the host on reconnect.
15. **Silence timeout**: an option to pause the call after a set time with nothing said.
16. **Fixed timings review**: every fixed timing in the voice code either becomes a real signal, a setting, or gets a written reason.
17. **Interruption**: when the user interrupts, the voice agent's record of its own reply is cut to what was actually heard.
