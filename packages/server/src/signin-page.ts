// The page a browser sees when it opens a protected link directly. A browser
// navigation cannot attach a bearer, so the server answers with this instead of
// raw JSON. If this browser holds the SPA's stored credential, the page uses it
// to mint a signed link for the same resource and goes there; otherwise it
// points at the app. Failures are shown, never swallowed.

/** CSP for the page itself: its own inline script/style, same-origin fetch only. */
export const SIGNIN_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

const CREDENTIAL_KEY = 'patch.credential.v1';

/** True when the request is a browser navigation rather than an API call. */
export function wantsHtml(accept: string | undefined): boolean {
  return typeof accept === 'string' && accept.includes('text/html');
}

/** `shareUrl` is the POST endpoint that mints a signed link for this resource. */
export function signInPage(shareUrl: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Sign in to Patch</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,sans-serif;background:#fff;color:#111}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}a{color:#eee}}
main{max-width:22rem;padding:2rem;text-align:center}
h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}
p{margin:0 0 1rem;opacity:.7}
a{color:#111;font-weight:600}
</style></head><body><main>
<h1 id="title">Sign in to Patch</h1>
<p id="msg">This link needs you to be signed in.</p>
<a id="open" href="/">Open Patch</a>
</main>
<script>
(async()=>{
const jwt=localStorage.getItem(${JSON.stringify(CREDENTIAL_KEY)});
if(!jwt)return;
const t=document.getElementById('title'),m=document.getElementById('msg');
t.textContent='Signing you in';m.textContent='';
try{
const r=await fetch(${JSON.stringify(shareUrl)},{method:'POST',headers:{authorization:'Bearer '+jwt}});
if(!r.ok)throw new Error('HTTP '+r.status);
const j=await r.json();
location.replace(j.url);
}catch(e){t.textContent='Could not sign you in';m.textContent=String(e.message||e);}
})();
</script></body></html>`;
}
