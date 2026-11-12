// Voice devices connect to the server (spec/16 § Connection model). A device
// holds only the server's address and its own credential, so it works on any
// network and needs no host's LAN address. On a wake the server mints the voice
// session itself and records which host owns the target chat, so the device's
// audio WSS (`/audio/:sessionId`, audio-relay.ts) reaches that host: the
// device never knows or cares where the agent runs.
//
// NO FALLBACKS: a bad credential, a revoked device, a hello for a different
// device or a chat no host owns is refused loudly.

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import WebSocket from 'ws';
import { mintSurfaceCredential, verifySurfaceCredential } from '@patch/auth';
import { ulid } from 'ulid';
import { z } from 'zod';
import { requireAuth } from './folder-routes.js';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import {
  decodeDeviceControl,
  encodeDeviceControl,
  type DeviceControlOutbound,
} from '@patch/wire/device-control';
import type { Registry } from './registry.js';
import type { ChatRegistry } from './chat-registry.js';
import { mintVoiceToken } from './voice/token.js';

export const DEVICE_CONTROL_PATH = '/device/control';

/** How long a device stays open for a follow-up after a reply, unless Patch says otherwise. */
export const DEFAULT_FOLLOWUP_MS = 5000;

const AddDeviceBody = z.object({ label: z.string().trim().min(1).max(60) }).strict();

/** WebSocket close code for a refused credential (application range). */
const CLOSE_UNAUTHORISED = 4401;

export interface DeviceControlDeps {
  logger: Logger;
  registry: Registry;
  chatRegistry: ChatRegistry;
  internalToken: string;
  isHostOnline: (hostId: string) => boolean;
  recordSessionHost: (sessionId: string, hostId: string) => void;
  /** The chat a wake-word conversation goes to. Defaults to the Manager. */
  targetChatId?: () => string;
  /** The follow-up window sent with each session. */
  followupMs?: () => number;
  nowMs?: () => number;
  /** Test seam: credential verifier. */
  verifyCredential?: typeof verifySurfaceCredential;
}

export interface DevicePresence {
  deviceId: string;
  label: string;
  muted: boolean;
  fwVersion: string;
  connectedAt: number;
}

interface Socket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', handler: (data: Buffer) => void): void;
  on(event: 'close', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
}

export interface DeviceControlHandle {
  /** Devices connected right now. */
  list(): DevicePresence[];
  /** Close a device's connection (after its token is revoked). */
  disconnect(deviceId: string): void;
}

export function registerDeviceControlRoute(
  app: FastifyInstance,
  deps: DeviceControlDeps,
): DeviceControlHandle {
  const now = deps.nowMs ?? Date.now;
  const verify = deps.verifyCredential ?? verifySurfaceCredential;
  const target = deps.targetChatId ?? ((): string => SPECIAL_THREAD_IDS.manager);
  const live = new Map<string, { socket: Socket; presence: DevicePresence }>();

  const send = (socket: Socket, frame: DeviceControlOutbound): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(encodeDeviceControl(frame));
  };

  const authenticate = async (
    header: string | undefined,
  ): Promise<{ deviceId: string; label: string; accountId: string }> => {
    if (!header || !header.startsWith('Bearer ')) throw new Error('missing bearer');
    const account = deps.registry.getAccount();
    if (!account) throw new Error('no account');
    const claims = await verify(header.slice('Bearer '.length).trim(), {
      userPublicKey: account.userPublicKey,
      expectedSurfaceKind: 'voice-device',
      // A device credential carries no exp by design; revocation ends it.
      expectAnyExp: true,
      now: Math.floor(now() / 1000),
    });
    if (deps.registry.isRevoked(claims.surface_id)) throw new Error('device revoked');
    return { deviceId: claims.surface_id, label: claims.label, accountId: account.accountId };
  };

  const openSession = (socket: Socket, deviceId: string, accountId: string): void => {
    const chatId = target();
    const chat = deps.chatRegistry.get(chatId);
    if (!chat || !deps.isHostOnline(chat.hostId)) {
      deps.logger.warn({ deviceId, chatId }, 'device-control: no online host owns the target chat');
      send(socket, { type: 'error', message: `${chatId} is not reachable right now` });
      return;
    }
    const sessionId = randomBytes(12).toString('hex');
    const { token } = mintVoiceToken({
      secret: deps.internalToken,
      accountId,
      surfaceId: deviceId,
      sessionId,
      chatId,
      nowMs: now(),
    });
    deps.recordSessionHost(sessionId, chat.hostId);
    send(socket, {
      type: 'session_start',
      sessionId,
      voiceToken: token,
      accountId,
      chatId,
      conversational: true,
      followupMs: (deps.followupMs ?? ((): number => DEFAULT_FOLLOWUP_MS))(),
    });
    deps.logger.info(
      { deviceId, sessionId, chatId, hostId: chat.hostId },
      'device-control: session opened',
    );
  };

  app.get(DEVICE_CONTROL_PATH, { websocket: true }, (socket: Socket, req) => {
    // Frames that arrive while the credential is being checked are held, so
    // the device's hello (sent the instant the socket opens) isn't lost.
    const held: Buffer[] = [];
    let ready: ((data: Buffer) => void) | null = null;
    socket.on('message', (data: Buffer) => (ready ? ready(data) : held.push(data)));
    const header = req.headers['authorization'];
    void authenticate(typeof header === 'string' ? header : undefined).then(
      ({ deviceId, label, accountId }) => {
        let helloed = false;
        const handle = (data: Buffer): void => {
          let frame;
          try {
            frame = decodeDeviceControl(data);
          } catch {
            send(socket, { type: 'error', message: 'malformed control frame' });
            return;
          }
          switch (frame.type) {
            case 'hello': {
              if (frame.deviceId !== deviceId) {
                deps.logger.warn(
                  { deviceId, hello: frame.deviceId },
                  'device-control: hello for another device',
                );
                socket.close(CLOSE_UNAUTHORISED, 'hello deviceId mismatch');
                return;
              }
              helloed = true;
              const previous = live.get(deviceId);
              if (previous && previous.socket !== socket) previous.socket.close(1000, 'replaced');
              live.set(deviceId, {
                socket,
                presence: {
                  deviceId,
                  label,
                  muted: frame.muted,
                  fwVersion: frame.fwVersion,
                  connectedAt: now(),
                },
              });
              deps.logger.info(
                { deviceId, fwVersion: frame.fwVersion },
                'device-control: device online',
              );
              return;
            }
            case 'mute_changed': {
              const entry = live.get(deviceId);
              if (entry) entry.presence.muted = frame.muted;
              return;
            }
            case 'wake_detected': {
              if (!helloed) {
                send(socket, { type: 'error', message: 'wake_detected before hello' });
                return;
              }
              openSession(socket, deviceId, accountId);
              return;
            }
            case 'session_end':
              deps.logger.info({ deviceId, reason: frame.reason }, 'device-control: session ended');
              return;
            case 'ring_accepted':
            case 'ring_dismissed':
              // Rings are not routed through the server yet; nothing to accept.
              return;
          }
        };
        ready = handle;
        for (const data of held.splice(0)) handle(data);
        socket.on('close', () => {
          const entry = live.get(deviceId);
          if (entry && entry.socket === socket) {
            live.delete(deviceId);
            deps.logger.info({ deviceId }, 'device-control: device offline');
          }
        });
      },
      (err: Error) => {
        deps.logger.warn({ err: err.message }, 'device-control: refused');
        socket.close(CLOSE_UNAUTHORISED, 'unauthorised');
      },
    );
    socket.on('error', () => undefined);
  });

  // A revoked token cuts the device off within a minute, even mid-connection.
  const sweep = setInterval(() => {
    for (const [deviceId, entry] of live) {
      if (deps.registry.isRevoked(deviceId)) entry.socket.close(CLOSE_UNAUTHORISED, 'revoked');
    }
  }, 60_000);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  // Settings → Voice devices → Add device: a long-lived token the device is set
  // up with. It is shown once; revoking it (POST /api/auth/revoke) cuts the
  // device off, including a connection that is already open.
  app.post('/api/voice-devices', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    const parsed = AddDeviceBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_input', message: 'label is required (1-60 characters)' });
    }
    const key = deps.registry.getAccountPrivateKey();
    if (!key) return reply.code(503).send({ error: 'no_account' });
    const surfaceId = ulid();
    const token = await mintSurfaceCredential({
      userPrivateKey: key,
      surfaceId,
      surfaceKind: 'voice-device',
      label: parsed.data.label,
    });
    deps.registry.upsertSurface({
      surfaceId,
      surfaceKind: 'voice-device',
      label: parsed.data.label,
      issuedAt: Math.floor(now() / 1000),
    });
    deps.logger.info({ surfaceId }, 'device-control: voice device added');
    return reply.code(200).send({ surfaceId, label: parsed.data.label, token });
  });

  return {
    list: () => [...live.values()].map((e) => ({ ...e.presence })),
    disconnect: (deviceId: string): void => {
      const entry = live.get(deviceId);
      if (entry) entry.socket.close(CLOSE_UNAUTHORISED, 'revoked');
    },
  };
}
