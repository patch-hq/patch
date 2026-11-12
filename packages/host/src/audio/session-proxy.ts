// Carry a voice device's audio WSS on to the server (spec/16 § Connection
// model). A device reaches only the host it is paired to; when its session is
// for a chat another host runs, the server minted that session and knows which
// host to send it to, so this host forwards the device's frames verbatim in
// both directions and never decodes them.
//
// NO FALLBACK: if the server cannot be reached, the device is told why and its
// socket closed, rather than left connected to nothing.

import WebSocket from 'ws';
import type { Logger } from 'pino';
import { encodeAudio } from '@patch/wire/audio';

/** The WebSocket close code for "the far end went away" (RFC 6455 1011). */
const CLOSE_UPSTREAM_FAILED = 1011;

export interface ProxyDeps {
  logger: Logger;
  /** Test seam: substitute the upstream WebSocket client. */
  wsCtor?: new (url: string) => WebSocket;
}

/** Pipe `client` to `upstreamUrl`. Frames the device sends before the upstream opens are held, in order. */
export function proxyAudioSession(
  client: WebSocket,
  upstreamUrl: string,
  sessionId: string,
  deps: ProxyDeps,
): void {
  const Ctor = deps.wsCtor ?? WebSocket;
  const upstream = new Ctor(upstreamUrl);
  const held: { data: WebSocket.RawData; isBinary: boolean }[] = [];
  let open = false;

  client.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (open) upstream.send(data, { binary: isBinary });
    else held.push({ data, isBinary });
  });
  upstream.on('open', () => {
    open = true;
    for (const frame of held) upstream.send(frame.data, { binary: frame.isBinary });
    held.length = 0;
    deps.logger.info({ sessionId }, 'audio: device session carried on to the server');
  });
  upstream.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on('error', (err: Error) => {
    deps.logger.warn(
      { sessionId, err: err.message },
      'audio: server leg of a device session failed',
    );
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        encodeAudio({
          type: 'audio.error',
          code: 'host_unreachable',
          message: 'could not reach the server for this session',
        }),
      );
      client.close(CLOSE_UPSTREAM_FAILED, 'server unreachable');
    }
  });
  upstream.on('close', () => {
    if (client.readyState === WebSocket.OPEN) client.close();
  });
  const closeUpstream = (): void => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  };
  client.on('close', closeUpstream);
  client.on('error', closeUpstream);
}
