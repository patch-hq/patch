# @patch/relay

The end-to-end encrypted relay (`spec/10-auth.md` § Relay): a rendezvous that
forwards bytes it cannot read, and the pieces both ends of a relayed connection
are made of.

| Entry                 | What                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| `@patch/relay`        | the handshake and session crypto, the tunnel protocol, the device client  |
| `@patch/relay/server` | the relay itself (`createRelayServer`)                                    |
| `@patch/relay/host`   | the server's half: ends devices' sessions on the server's loopback        |
| `@patch/relay/bridge` | a loopback listener that carries a page and its sockets through a session |

## Running a relay

```sh
PORT=8787 node dist/cli.js        # or the `patch-relay` bin
```

It keeps no state. Put TLS in front and give people the `wss://` address; with
Caddy:

```
relay.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

and a unit to keep it up:

```
[Service]
ExecStart=/usr/bin/node /opt/patch/relay/dist/cli.js
Environment=PORT=8787 HOST=127.0.0.1
Restart=on-failure
```

A server uses it with `PATCH_RELAY_URL=wss://relay.example.com`.

The project's public relay, `wss://relay.patchhq.dev`, is not this process but
the same protocol as a Cloudflare Worker (`packages/relay-worker`), and is the
address the desktop app hands its own server by default. This package's
behaviour tests run against either: `PATCH_RELAY_TEST_URL=wss://… pnpm test`
points them at a relay they did not start (`test/target.ts`).

## Keepalive

Both ends of a relayed connection ping, every 30 s by default (`keepaliveMs`):
the host sends WebSocket pings to the relay, and a device sends an encrypted
PING through its session, which the server answers. That keeps a quiet
connection from being dropped as idle, and two pings in a row without an answer
end a dead one — the host redials, and a device's `RelayConnection` dials a new
session the next time it is used. A device only treats silence as death once
its server has answered a ping, since a server from before PING never will.
