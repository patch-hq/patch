# Meeting mode v4

Agreed with Tom on 21 Oct 2026 over the "Meeting layout v4" Pad. It replaces v3's meeting in place of the chat, which left about 50px for the chat itself.

The screens (not committed: `python3 build.py` makes them) are built into a copy of the real web app's sidebar and pane (`shell.html`, `app.css` and `fonts/`), as for v3.

- **The chat stays a chat.** Its messages and the composer, nothing of the meeting above or below them except the Meeting button. The composer has no Note / Ask switch: what is typed goes to the agent, and its questions and answers stay in the chat.
- **One panel on the right.** Everything about the meeting lives there, flush to the window edge with only a hairline on its left: no border, box or inset.
- **Header row.** Timer (a red dot while live), the people on the call, Pause and End, or Resume once ended, and the settings button.
- **Tabs, at 15px.** Notes · My notes · Actions · Transcript, the same live and after. Actions shows how many are open.
- **Notes.** Points and research cards together at their times, oldest first, the newest point marked Now and the talk not yet summarised below it. After the meeting the summary heads Notes.
- **My notes.** Tom's own notes, kept apart from the points, each at the time he wrote it, with a box of its own to write the next one.
- **Actions.** The tab replaces the tray above the composer.
- **Settings.** The research switch ("Research as we go") moves here, with "Agent does its own actions" and the models, each label above its dropdown.
- **Errors.** One line each under the tabs, in full on click.
- **Folding.** An ended meeting can still fold away, to one thin line over the chat.
