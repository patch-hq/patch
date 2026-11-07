# Design kit

Patch designs for a Pad are built from the real app, never from lookalikes, and
always as both a desktop and a phone screen.

- Desktop: `capture-web.mjs` and `capture-settings.spec.ts` capture real markup
  and the real stylesheet from the web dev harness. Swap only the parts being
  redesigned; put new styles in a separate `proposal.css`. Hide `.sb`,
  `.sidebar-backdrop` and `.set-nav` under 760px so the screens also read on a
  phone. Worked example: `../voice-call-redesign/build.py`.
- Phone: the Android app is a different codebase. See `phone/`.
