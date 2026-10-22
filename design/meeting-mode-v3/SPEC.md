# Meeting mode v3

Agreed with Tom on 21 Oct 2026 over the "Meeting mode v3" Pad. It replaces v2's side panel.

The screens (not committed: `python3 build.py` makes them) are built into a copy of the real web app's sidebar and pane (`shell.html`, `app.css` and `fonts/`). Those are captured from the dev harness and are not committed, so on a fresh checkout the screens render unstyled.

- **The meeting is the chat.** While a meeting is shown it takes the chat stream's place in the main panel, and there is no side panel. The composer stays below it.
- **One bar.** It holds the timer (a red dot while live, with no "Live" word), the people on the call (unnamed voices are counted as "N unknown"), the Summary / Transcript tabs, a settings button, and Pause/End or Resume. The controls stay in the same places live and after.
- **Summary.** It runs oldest first, so the newest item is at the bottom. It holds the generated points (softer ink), Tom's notes (full ink, 15px), research cards and his questions to the agent with its answers, each at the time it happened. While the meeting is live, the newest point is marked "Now", and below it the last minute or so of talk the notes have not taken in yet appears as "Not in the summary yet". There is no "add a point".
- **Closing summary.** After the meeting, the write-up closes the Summary. Regenerate and Copy are icon buttons.
- **Transcript.** It shows every line, with a copy icon button that stays at the top. An unnamed speaker shows as "Unknown" or "Unknown N", never "Them".
- **Note / Ask.** A switch sits inside the composer. Note writes a timed note into the Summary and is the default while the meeting runs. Ask sends the message to the agent and is the default once the meeting has ended.
- **Folding.** After the meeting, a fold button collapses it to one thin bar, which has Summary and Transcript buttons. The chat then gets the full height, and the meeting stays folded across reloads.
- **Actions.** The actions tray is one line until it is opened.
- **Permissions (setup screens).** On first run, a popover on the meeting button asks once, and can be closed. It lists Microphone, Call audio and Accessibility, each with an Allow button. Pressing Start meeting shows only what is still missing, plus "Start without names" if Accessibility is the only gap.
