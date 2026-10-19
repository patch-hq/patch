// Phone updates, from the release this server follows (spec/11 § Mobile updates).
//
// Two things, both read from the downloads folder the release mirror fills:
//
// - `GET /api/mobile/updates` answers the app's update check (the Expo Updates
//   protocol, v1). The manifest in `mobile-update.json` was signed by CI and
//   names each file by its GitHub release URL, so this relays the signed bytes
//   untouched — the server cannot change what a phone runs, only whether it is
//   offered. A phone on another runtime (a different APK) is told there is
//   nothing for it: the bundle would not run on its native code.
//
// - `MobileUpdateNotifier` tells the phone once when a release needs a NEW APK —
//   the one thing an update check can never deliver. It remembers what it has
//   announced on disk, because this server restarts itself to install the very
//   release that carries the news.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { NotificationRouter } from './notifications/router.js';
import { readMirrorState } from './release-mirror.js';

export const MOBILE_UPDATE_FILE = 'mobile-update.json';

/** What CI writes as `mobile-update.json` (scripts/build-mobile-update.mjs). */
export interface MobileUpdate {
  platform: 'android';
  runtimeVersion: string;
  version: string;
  gitSha: string;
  builtAt: string;
  /** The manifest exactly as signed: these bytes, unchanged, are the response. */
  manifest: string;
  /** `expo-signature` header value over `manifest`. */
  signature: string;
}

export function readMobileUpdate(downloadsDir: string): MobileUpdate | null {
  const file = join(downloadsDir, MOBILE_UPDATE_FILE);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<MobileUpdate>;
  for (const key of ['runtimeVersion', 'manifest', 'signature'] as const) {
    if (typeof parsed[key] !== 'string' || parsed[key] === '') {
      throw new Error(`${MOBILE_UPDATE_FILE} has no ${key}`);
    }
  }
  return parsed as MobileUpdate;
}

/** The multipart/mixed body the Expo Updates protocol (v1) expects. */
export function manifestResponse(update: MobileUpdate): { boundary: string; body: string } {
  const boundary = `patch-${randomBytes(12).toString('hex')}`;
  const body =
    `--${boundary}\r\n` +
    'content-type: application/json; charset=utf-8\r\n' +
    'content-disposition: form-data; name="manifest"\r\n' +
    `expo-signature: ${update.signature}\r\n\r\n` +
    `${update.manifest}\r\n` +
    `--${boundary}\r\n` +
    'content-type: application/json\r\n' +
    'content-disposition: form-data; name="extensions"\r\n\r\n' +
    `${JSON.stringify({ assetRequestHeaders: {} })}\r\n` +
    `--${boundary}--\r\n`;
  return { boundary, body };
}

export function registerMobileUpdateRoutes(
  app: FastifyInstance,
  deps: { downloadsDir: string; logger: Pick<Logger, 'warn'> },
): void {
  // Unauthenticated, like the APK download beside it: expo-updates calls it from
  // native code with no surface credential, and everything it hands out is the
  // public release's own signed files.
  app.get('/api/mobile/updates', { logLevel: 'warn' }, async (req, reply) => {
    const platform = req.headers['expo-platform'];
    const runtime = req.headers['expo-runtime-version'];
    if (platform !== 'android') {
      return reply.code(400).send({ error: 'expo-platform must be android' });
    }
    if (typeof runtime !== 'string' || runtime === '') {
      return reply.code(400).send({ error: 'expo-runtime-version is required' });
    }
    let update: MobileUpdate | null;
    try {
      update = readMobileUpdate(deps.downloadsDir);
    } catch (err) {
      deps.logger.warn({ err: (err as Error).message }, 'mobile update: unreadable');
      return reply.code(500).send({ error: `mobile update unreadable: ${(err as Error).message}` });
    }
    // NO FALLBACK: a server with nothing published says so, rather than telling
    // every phone it is up to date.
    if (!update)
      return reply.code(404).send({ error: 'this server has no phone update published' });
    const headers = {
      'expo-protocol-version': '1',
      'expo-sfv-version': '0',
      'cache-control': 'private, max-age=0',
    };
    // Another runtime is another APK: this bundle would not run on it. The
    // install notice (MobileUpdateNotifier) is what moves that phone on.
    if (runtime !== update.runtimeVersion) return reply.code(204).headers(headers).send();
    const current = req.headers['expo-current-update-id'];
    const id = (JSON.parse(update.manifest) as { id?: string }).id;
    if (
      typeof current === 'string' &&
      id !== undefined &&
      current.toLowerCase() === id.toLowerCase()
    ) {
      return reply.code(204).headers(headers).send();
    }
    const { boundary, body } = manifestResponse(update);
    return reply
      .code(200)
      .headers(headers)
      .header('content-type', `multipart/mixed; boundary=${boundary}`)
      .send(body);
  });
}

const ANNOUNCED_FILE = 'announced-apk.json';

interface PublishedApk {
  version: string;
  file: string;
  runtimeVersion?: string;
}

/** Notifications need a chat id; this is not a chat. */
const UPDATE_CHAT_ID = 'app-update';

export class MobileUpdateNotifier {
  constructor(
    private readonly deps: {
      downloadsDir: string;
      dataDir: string;
      repo: string;
      router: Pick<NotificationRouter, 'route'>;
      logger: Pick<Logger, 'info' | 'warn'>;
    },
  ) {}

  /**
   * Announce the published APK if it needs installing — its runtime differs
   * from the last one announced, so no update check can bring a phone to it.
   * Resolves true when a notice went out.
   */
  async check(): Promise<boolean> {
    const sidecar = join(this.deps.downloadsDir, 'android-latest.json');
    if (!existsSync(sidecar)) return false;
    let apk: PublishedApk;
    try {
      apk = JSON.parse(readFileSync(sidecar, 'utf8')) as PublishedApk;
    } catch (err) {
      this.deps.logger.warn(
        { err: (err as Error).message },
        'app update: android-latest.json unreadable',
      );
      return false;
    }
    // A release built before the APK said its runtime cannot be told apart from
    // the last one: say nothing rather than guess.
    if (!apk.runtimeVersion) return false;
    const announced = this.readAnnounced();
    if (announced?.runtimeVersion === apk.runtimeVersion) return false;

    // The release's own copy, so the link works whether or not this server has
    // a public address — and on an app too old to install in place, which opens
    // the link in the browser (it is named in the text below).
    const tag = readMirrorState(this.deps.downloadsDir)?.tag;
    const deepLink = tag
      ? `https://github.com/${this.deps.repo}/releases/download/${tag}/${apk.file}`
      : undefined;
    await this.deps.router.route(
      {
        type: 'notify',
        chatId: UPDATE_CHAT_ID,
        channel: 'push',
        message: `Patch ${apk.version} needs installing. Tap to download it.`,
        // Never held back because the user is at a computer, and makes no
        // sound: it waits on the phone for the next time it is picked up.
        priority: 'silent',
        kind: 'app-update',
        ...(deepLink ? { deepLink } : {}),
      },
      {},
    );
    this.writeAnnounced({ runtimeVersion: apk.runtimeVersion, version: apk.version });
    this.deps.logger.info(
      { version: apk.version, runtimeVersion: apk.runtimeVersion },
      'app update: announced a new APK to the phone',
    );
    return true;
  }

  /** Check now and every `everyMs`; returns the stop function. */
  start(everyMs = 2 * 60 * 1000): () => void {
    const tick = (): void => {
      this.check().catch((err: unknown) =>
        this.deps.logger.warn({ err: (err as Error).message }, 'app update: announce failed'),
      );
    };
    tick();
    const timer = setInterval(tick, everyMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private readAnnounced(): { runtimeVersion: string; version: string } | null {
    const file = join(this.deps.dataDir, ANNOUNCED_FILE);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as { runtimeVersion: string; version: string };
    } catch (err) {
      // Re-derivable: at worst the phone hears about this APK twice.
      this.deps.logger.warn(
        { err: (err as Error).message },
        `app update: ${ANNOUNCED_FILE} corrupt`,
      );
      return null;
    }
  }

  private writeAnnounced(value: { runtimeVersion: string; version: string }): void {
    const file = join(this.deps.dataDir, ANNOUNCED_FILE);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(value)}\n`);
    renameSync(`${file}.tmp`, file);
  }
}
