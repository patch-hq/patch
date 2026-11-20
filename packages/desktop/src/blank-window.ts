// A window that loaded but never painted the app.
//
// The shell IS the SPA, served by the host, so a shell and a host that disagree
// (an older shell under a newer host, or a stale session left by an app-id
// change) can load the document fine and then throw before React mounts. The
// window stays white: no `did-fail-load`, no crashed renderer, nothing to see.
// This is the check for that state, and the page that replaces it with text.

/** How long after a finished load the app has to put something in #root. */
export const MOUNT_DEADLINE_MS = 12_000;

/** Run in the page: true when the SPA has rendered. */
export const MOUNT_PROBE = `(() => { const r = document.getElementById('root'); return !!r && r.childElementCount > 0; })()`;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The page shown instead of a blank window. */
export function blankWindowPage(info: { url: string; shellVersion: string }): string {
  const url = esc(info.url);
  return `<!doctype html><meta charset="utf-8"><title>Patch</title>
<body style="font:15px system-ui;margin:0;padding:48px;max-width:560px;color:#222">
<h1 style="font-size:20px;font-weight:600">Patch did not start</h1>
<p>The app loaded from ${url} but showed nothing. The app and the server it connects to are probably on different versions.</p>
<p style="opacity:.6">This app is version ${esc(info.shellVersion)}. Install the latest Patch, then reopen it.</p>
<p><a href="${url}" style="color:inherit;font-weight:600">Try again</a></p>`;
}
