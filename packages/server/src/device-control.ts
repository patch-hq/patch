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
import type { VoiceTimer } from '@patch/wire';

export const DEVICE_CONTROL_PATH = '/device/control';

/** How long a device stays open for a follow-up after a reply, unless Patch says otherwise. */
export const DEFAULT_FOLLOWUP_MS = 5000;

const AddDeviceBody = z.object({ label: z.string().trim().min(1).max(60) }).strict();

/** WebSocket close code for a refused credential (application range). */
const CLOSE_UNAUTHORISED = 4401;

/** Ping a device this often; a device silent for the timeout is dropped so it reconnects. */
const DEVICE_PING_INTERVAL_MS = 10_000;
const DEVICE_SILENCE_TIMEOUT_MS = 30_000;

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
  /** Text the session's host should speak as soon as the device joins (announcements). */
  queueSpeech?: (sessionId: string, text: string) => void;
  nowMs?: () => number;
  /**
   * Liveness probing of device sockets. A connection that dies without closing
   * (a proxy or the server restarting under it) would otherwise stay listed as
   * online while no wake ever arrives; with no pong or frame inside the timeout
   * the socket is terminated, so the device sees the drop and reconnects.
   */
  keepalive?: { pingIntervalMs: number; silenceTimeoutMs: number };
  /** Timers and alarms (spec/16 § Timers and alarms): read on connect, told when one is stopped. */
  timers?: { list: () => VoiceTimer[]; stop: (timerId: string) => boolean };
  /** Test seam: credential verifier. */
  verifyCredential?: typeof verifySurfaceCredential;
}

export interface DevicePresence {
  deviceId: string;
  label: string;
  muted: boolean;
  fwVersion: string;
  connectedAt: number;
  /** When the user last spoke to it (a wake), or 0. */
  lastUsedAt: number;
}

/** A spoken announcement for the house (`patch_speak`, spec/09 § speakers). */
export interface Announcement {
  /** The chat that is speaking; its host speaks the text. */
  chatId: string;
  message: string;
  /** A device id or name to speak on; otherwise the one used most recently, else every device. */
  deviceId?: string;
}

interface Socket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  terminate(): void;
  on(event: 'pong', handler: () => void): void;
  on(event: 'message', handler: (data: Buffer) => void): void;
  on(event: 'close', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
}

export interface DeviceControlHandle {
  /** Devices connected right now. */
  list(): DevicePresence[];
  /** Speak an announcement on the right device(s). Returns how many it went to (0: none reachable). */
  announce(a: Announcement): number;
  /** Tell every connected device the timers as they now stand. */
  syncTimers(timers: VoiceTimer[]): void;
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
  const live = new Map<string, { socket: Socket; presence: DevicePresence; accountId: string }>();

  const send = (socket: Socket, frame: DeviceControlOutbound): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(encodeDeviceControl(frame));
  };

  /**
   * What one device is told about the timers. Everything running (the ring
   * counts down the one the device set; others are there to show). A ringing
   * timer sounds on the device that set it, or on every device when the setter
   * is not connected, so an alarm is never lost to an unplugged speaker.
   */
  const timersFor = (deviceId: string, timers: VoiceTimer[]): DeviceControlOutbound => ({
    type: 'timers',
    serverNow: now(),
    timers: timers
      .filter(
        (t) =>
          t.state === 'running' ||
          t.deviceId === deviceId ||
          t.deviceId === undefined ||
          !live.has(t.deviceId),
      )
      .map((t) => ({
        id: t.id,
        label: t.label,
        kind: t.kind,
        endsAt: t.endsAt,
        totalMs: t.totalMs,
        state: t.state,
        own: t.deviceId === deviceId,
      })),
  });

  const syncTimers = (timers: VoiceTimer[]): void => {
    for (const [deviceId, e] of live) send(e.socket, timersFor(deviceId, timers));
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

  const openSession = (
    socket: Socket,
    deviceId: string,
    accountId: string,
    opts: { chatId: string; conversational: boolean; speak?: string },
  ): boolean => {
    const { chatId } = opts;
    const chat = deps.chatRegistry.get(chatId);
    if (!chat || !deps.isHostOnline(chat.hostId)) {
      deps.logger.warn({ deviceId, chatId }, 'device-control: no online host owns the target chat');
      if (opts.conversational)
        send(socket, { type: 'error', message: `${chatId} is not reachable right now` });
      return false;
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
    if (opts.speak !== undefined) deps.queueSpeech?.(sessionId, opts.speak);
    send(socket, {
      type: 'session_start',
      sessionId,
      voiceToken: token,
      accountId,
      chatId,
      conversational: opts.conversational,
      followupMs: (deps.followupMs ?? ((): number => DEFAULT_FOLLOWUP_MS))(),
    });
    deps.logger.info(
      { deviceId, sessionId, chatId, hostId: chat.hostId, announcement: opts.speak !== undefined },
      'device-control: session opened',
    );
    return true;
  };

  app.get(DEVICE_CONTROL_PATH, { websocket: true }, (socket: Socket, req) => {
    // Frames that arrive while the credential is being checked are held, so
    // the device's hello (sent the instant the socket opens) isn't lost.
    const held: Buffer[] = [];
    let ready: ((data: Buffer) => void) | null = null;
    let lastAlive = now();
    const { pingIntervalMs, silenceTimeoutMs } = deps.keepalive ?? {
      pingIntervalMs: DEVICE_PING_INTERVAL_MS,
      silenceTimeoutMs: DEVICE_SILENCE_TIMEOUT_MS,
    };
    const keepalive = setInterval(() => {
      if (now() - lastAlive > silenceTimeoutMs) {
        deps.logger.warn(
          { silentMs: now() - lastAlive },
          'device-control: device silent; dropping',
        );
        socket.terminate();
        return;
      }
      socket.ping();
    }, pingIntervalMs);
    keepalive.unref();
    socket.on('pong', () => {
      lastAlive = now();
    });
    socket.on('close', () => clearInterval(keepalive));
    socket.on('message', (data: Buffer) => {
      lastAlive = now();
      if (ready) ready(data);
      else held.push(data);
    });
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
                accountId,
                presence: {
                  deviceId,
                  label,
                  muted: frame.muted,
                  fwVersion: frame.fwVersion,
                  connectedAt: now(),
                  lastUsedAt: previous?.presence.lastUsedAt ?? 0,
                },
              });
              deps.logger.info(
                { deviceId, fwVersion: frame.fwVersion },
                'device-control: device online',
              );
              if (deps.timers) send(socket, timersFor(deviceId, deps.timers.list()));
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
              const entry = live.get(deviceId);
              if (entry) entry.presence.lastUsedAt = now();
              openSession(socket, deviceId, accountId, { chatId: target(), conversational: true });
              return;
            }
            case 'session_end':
              deps.logger.info({ deviceId, reason: frame.reason }, 'device-control: session ended');
              return;
            case 'timer_stopped':
              if (!deps.timers?.stop(frame.timerId)) {
                send(socket, { type: 'error', message: `no timer ${frame.timerId}` });
              }
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

  const announce = (a: Announcement): number => {
    const reachable = [...live.values()].filter((e) => !e.presence.muted);
    let chosen: typeof reachable;
    if (a.deviceId !== undefined) {
      const want = a.deviceId.toLowerCase();
      chosen = reachable.filter(
        (e) => e.presence.deviceId === a.deviceId || e.presence.label.toLowerCase() === want,
      );
    } else {
      const recent = reachable.filter((e) => e.presence.lastUsedAt > 0);
      recent.sort((x, y) => y.presence.lastUsedAt - x.presence.lastUsedAt);
      chosen = recent.length > 0 ? recent.slice(0, 1) : reachable;
    }
    let spoken = 0;
    for (const e of chosen) {
      const ok = openSession(e.socket, e.presence.deviceId, e.accountId, {
        chatId: a.chatId,
        conversational: false,
        speak: a.message,
      });
      if (ok) spoken++;
    }
    return spoken;
  };

  return {
    list: () => [...live.values()].map((e) => ({ ...e.presence })),
    announce,
    syncTimers,
    disconnect: (deviceId: string): void => {
      const entry = live.get(deviceId);
      if (entry) entry.socket.close(CLOSE_UNAUTHORISED, 'revoked');
    },
  };
}
