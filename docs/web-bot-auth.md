# Web Bot Auth — Cloudflare / Akamai verified-agent registration

Each Patch deployment creates and stores its own identity. No environment
variable, bundled key or host setup is involved. Registration is external:
the deployment operator submits its live directory from its own dashboard.
Patch exposes the complete setup under Settings → Agent identity on web,
desktop and Android.

- Key directory: `https://<deployment>/.well-known/http-message-signatures-directory`
- Description page: `https://<deployment>/agent`
- Key: Ed25519, generated on the server's first start and held in Patch's encrypted secrets store

## Deployment check

`https://<deployment>/.well-known/http-message-signatures-directory` returns
200 on a fresh install and retains the same public key after a restart. Every
connected host asks its paired server for each short-lived request signature.
The private key never leaves the server.

## Verifying

`https://crawltest.com/cdn-cgi/web-bot-auth` returns 401 `unknown public key or
unknown verified bot ID for keyid` until registered — i.e. the signature is
parsed and only the registration is missing.

## Cloudflare submission values

Open Protect & Connect → Application Security → BotBase → Submission form.

- Bot name: the deployment operator's name for their Patch agent
- Operator: the deployment operator and their contact address
- Description / info URL: `https://<deployment>/agent`
- Signature-Agent / key directory: `https://<deployment>/.well-known/http-message-signatures-directory`
- keyid and public key: read them from the live key directory after deployment
- Signed components: `@authority`, `signature-agent`; tag `web-bot-auth`
- Verification method: Request Signature
- Operator: Direct
- Behaviour/content use: User-driven agent; reference use

## Validation

Run Cloudflare's `http-signature-directory` validator against the live HTTPS
route. The directory must be valid and `signature_verified: true` before
submission. Each independently installed Patch server is registered separately;
no installation relies on the maintainer's identity or devices.
