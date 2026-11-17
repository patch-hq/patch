# @patch/relay-worker

The relay (`spec/10-auth.md` § Relay) as a Cloudflare Worker: the project's
public relay at `wss://relay.patchhq.dev`. It speaks exactly the protocol of the
Node relay in `packages/relay/src/server.ts`, with one Durable Object per
channel. Sockets are accepted with the WebSocket Hibernation API, and what each
one is (server or device, its device number, a pending challenge) lives in its
tags and serialized attachment, so a quiet channel costs nothing and the object
can be evicted between any two events. The hello timeout is an alarm.

It runs on the Workers free plan: Durable Objects there must be SQLite-backed
(`new_sqlite_classes` in `wrangler.jsonc`), and nothing here writes storage
except the alarm.

| Command                                     | What                                                           |
| ------------------------------------------- | -------------------------------------------------------------- |
| `pnpm test`                                 | the relay's behaviour tests against it under `wrangler dev`    |
| `node test/run.mjs wss://relay.patchhq.dev` | the same tests against the deployed relay                      |
| `pnpm run deploy`                           | deploy (needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) |

The release workflow deploys it from `main` when `packages/relay-worker` or
`packages/relay/src` changes, then checks `/healthz` repeatedly. A deploy
restarts every channel's object, which drops every relayed connection once;
both ends redial on their own.

`/healthz` reports the relay's limits (devices per channel, largest message,
hello timeout) so tests can read them instead of assuming; it has no counts,
since no one object sees every channel.
