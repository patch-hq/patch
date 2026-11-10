// Synthetic end-to-end meeting test, run on a Mac beside the app someone is using.
//
//   pnpm --filter @patch/host exec tsx scripts/meeting-e2e/run.ts [--keep] [--work <dir>]
//
// A second, isolated Patch desktop instance (own data folder, hidden window, no tray, no
// hotkeys, no toasts) talks to its own server and host. Nothing reaches the speakers, the
// real microphone or the screen:
//   mic lane   Chromium's fake capture device plays mic.wav
//   call lane  `patch-audio tap` reads call.wav instead of Core Audio
//   events     the helper's mic-watch and speakers commands print lines the harness appends
//              to feed files (Teams opened/closed the mic; who is lit up on the call)
// The host transcribes with local Whisper and analyses with the real model; no paid
// transcription is used. Prints one PASS/FAIL line; the detail is in <work>/report.json.
//
// Exit codes: 0 pass, 1 fail, 2 cannot run here (a prerequisite is missing).
import { type ChildProcess, spawn, execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  openSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildScenarioAudio } from './audio.js';
import { evaluate, reportLine, type DesktopEventSeen, type Observed } from './evaluate.js';
import { CALL_APP_BUNDLE, OWNER_LABEL, PARTICIPANTS, type Timeline } from './scenario.js';
import { kokoroAvailable } from '../../test/helpers/syntheticCall.js';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const DESKTOP = join(ROOT, 'packages', 'desktop');
const HELPER = join(DESKTOP, 'build', 'native', 'patch-audio');
const WEB_DIST = join(ROOT, 'packages', 'web', 'dist');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const workArg = args.indexOf('--work');

const SERVER_PORT = 3301;
const HEALTHZ_PORT = 3311;
const AUDIO_PORT = 3313;
const CDP_PORT = 9334;
const INTERNAL_TOKEN = 'meeting-e2e-internal-token-0123456789';
const HOST_ID = 'e2e-host-1';

const t0 = Date.now();
const log = (m: string): void => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class CannotRun extends Error {}

function preflight(): void {
  const missing: string[] = [];
  if (process.platform !== 'darwin')
    missing.push('a Mac (the audio helper and Electron shell run there)');
  if (!existsSync(HELPER))
    missing.push(`the audio helper (${HELPER}): node packages/desktop/scripts/build-native.cjs`);
  if (!existsSync(join(DESKTOP, 'dist', 'main.js')))
    missing.push('the desktop build: pnpm --filter @patch/desktop build');
  if (!existsSync(join(WEB_DIST, 'index.html')))
    missing.push('the web build: pnpm --filter @patch/web build');
  if (!existsSync(join(ROOT, 'packages', 'server', 'dist', 'index.js')))
    missing.push('the server build: pnpm --filter @patch/server build');
  if (!kokoroAvailable()) missing.push('Kokoro (~/.patch/components/kokoro)');
  if ((process.env['WHISPER_BACKEND'] ?? 'local') !== 'local')
    missing.push('WHISPER_BACKEND=local (meetings use local Whisper)');
  if (!process.env['WHISPER_MODEL_PATH'] && !process.env['WHISPER_LOCAL_SIDECAR_URL']) {
    missing.push('WHISPER_MODEL_PATH or WHISPER_LOCAL_SIDECAR_URL (local Whisper)');
  }
  if (!process.env['CLAUDE_CODE_OAUTH_TOKEN'])
    missing.push('CLAUDE_CODE_OAUTH_TOKEN (the analysis model)');
  if (missing.length > 0) throw new CannotRun(`cannot run: ${missing.join('; ')}`);
}

const children: ChildProcess[] = [];
function run(
  cmd: string,
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; logFile: string },
): ChildProcess {
  const out = openSync(opts.logFile, 'a');
  const child = spawn(cmd, argv, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', out, out] });
  children.push(child);
  return child;
}

async function waitFor(
  what: string,
  fn: () => Promise<boolean> | boolean,
  ms: number,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function healthy(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

function pnpm(argv: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('pnpm', argv, { cwd: ROOT, env, encoding: 'utf8' });
}

interface Stack {
  jwt: string;
  patchHome: string;
}

async function bootStack(work: string): Promise<Stack> {
  const dataDir = join(work, 'data');
  const patchHome = join(dataDir, 'home');
  mkdirSync(patchHome, { recursive: true });
  const env = { ...process.env, PATCH_DATA_DIR: dataDir, PATCH_INTERNAL_TOKEN: INTERNAL_TOKEN };
  const credential = join(dataDir, 'web-credential.json');
  // Mint before the server boots: it loads its registry once, at start.
  pnpm(
    [
      '--filter',
      '@patch/server',
      'fixtures:mint-surface-jwt',
      '--account',
      'dev',
      '--surface',
      'e2e-web-1',
      '--kind',
      'web',
      '--data-dir',
      dataDir,
      '--ttl',
      '7200',
      '--output',
      credential,
    ],
    env,
  );
  pnpm(
    [
      '--filter',
      '@patch/server',
      'fixtures:mint-daemon-key',
      '--data-dir',
      dataDir,
      '--patch-home',
      patchHome,
      '--daemon-id',
      HOST_ID,
      '--label',
      'meeting-e2e',
    ],
    env,
  );
  const jwt = (JSON.parse(readFileSync(credential, 'utf8')) as { credential: string }).credential;

  run('node', [join(ROOT, 'packages', 'server', 'dist', 'index.js')], {
    cwd: ROOT,
    logFile: join(work, 'server.log'),
    env: { ...env, PORT: String(SERVER_PORT), HOST: '127.0.0.1', PATCH_WEB_DIST: WEB_DIST },
  });
  await waitFor('the server', () => healthy(`http://127.0.0.1:${SERVER_PORT}/api/healthz`), 60_000);

  run(join(ROOT, 'node_modules', '.bin', 'tsx'), ['src/index.ts'], {
    cwd: join(ROOT, 'packages', 'host'),
    logFile: join(work, 'host.log'),
    env: {
      ...env,
      PATCH_HOME: patchHome,
      PATCH_SERVER_WS_URL: `ws://127.0.0.1:${SERVER_PORT}/ws`,
      PATCH_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}`,
      PATCH_DAEMON_LOCAL_KEY: 'e2e-local-key',
      PATCH_DAEMON_HEALTHZ_PORT: String(HEALTHZ_PORT),
      PATCH_DAEMON_AUDIO_PORT: String(AUDIO_PORT),
      SDK_BACKEND: 'real',
      WHISPER_BACKEND: 'local',
      // mock-check:allow the host's voice stack is irrelevant to a meeting; Whisper (local) and the analysis model are real
      KOKORO_BACKEND: 'mock',
      // mock-check:allow as above: no call audio goes through the voice stack
      VAD_BACKEND: 'mock',
    },
  });
  await waitFor('the host', () => healthy(`http://127.0.0.1:${HEALTHZ_PORT}/healthz`), 90_000);
  return { jwt, patchHome };
}

async function createChat(jwt: string, folder: string): Promise<string> {
  mkdirSync(folder, { recursive: true });
  const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/chats`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hostId: HOST_ID, folder, name: 'Meeting e2e' }),
  });
  if (!res.ok) throw new Error(`creating the chat failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { chatId?: string; id?: string };
  const id = body.chatId ?? body.id;
  if (!id) throw new Error(`the chat response has no id: ${JSON.stringify(body)}`);
  return id;
}

/** The feeds the helper's mic-watch and speakers commands print from. */
class Feed {
  constructor(readonly path: string) {
    writeFileSync(path, '');
  }
  send(value: unknown): void {
    appendFileSync(this.path, `${JSON.stringify(value)}\n`);
  }
}

function labels(speaking: string | null): string[] {
  const all = [
    `${PARTICIPANTS.priya}, Unmuted`,
    `${PARTICIPANTS.marcus}, Unmuted`,
    `${OWNER_LABEL} (You)`,
  ];
  return speaking ? [...all, `${speaking} is speaking`] : all;
}

function scheduleSpeakers(speakers: Feed, timeline: Timeline, startAt: number): void {
  const at = (sec: number, fn: () => void): void =>
    void setTimeout(fn, Math.max(0, startAt + sec * 1000 - Date.now()));
  at(0, () => speakers.send({ labels: labels(null) }));
  for (const line of timeline.lines) {
    if (line.who === 'owner') continue;
    const name = PARTICIPANTS[line.who];
    at(line.start, () => speakers.send({ labels: labels(name) }));
    at(line.end, () => speakers.send({ labels: labels(null) }));
  }
}

function electronEvents(logPath: string): DesktopEventSeen[] {
  if (!existsSync(logPath)) return [];
  const out: DesktopEventSeen[] = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const m = /^\[desktop-event\] (.+)$/.exec(line);
    if (m) out.push(JSON.parse(m[1] as string) as DesktopEventSeen);
  }
  return out;
}

async function main(): Promise<number> {
  preflight();
  const work =
    workArg >= 0
      ? resolve(args[workArg + 1] as string)
      : mkdtempSync(join(tmpdir(), 'patch-meeting-e2e-'));
  mkdirSync(work, { recursive: true });
  log(`work dir ${work}`);

  log('voicing the call');
  const built = await buildScenarioAudio(work);
  const { timeline } = built;
  log(`call is ${Math.round(timeline.totalSeconds)}s long`);

  const stack = await bootStack(work);
  const chatId = await createChat(stack.jwt, join(work, 'folder'));
  log(`chat ${chatId}`);

  const micFeed = new Feed(join(work, 'mic-feed.jsonl'));
  const speakersFeed = new Feed(join(work, 'speakers-feed.jsonl'));
  const electronLog = join(work, 'electron.log');
  // The binary itself, not the `electron` wrapper script: the helper children are
  // parented to the real process.
  const electronBinary = createRequire(join(DESKTOP, 'package.json'))(
    'electron',
  ) as unknown as string;
  const electron = run(
    electronBinary,
    [
      'dist/main.js',
      `--remote-debugging-port=${CDP_PORT}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${built.micWav}%noloop`,
    ],
    {
      cwd: DESKTOP,
      logFile: electronLog,
      env: {
        ...process.env,
        PATCH_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}/app/chats/${chatId}?credential=${stack.jwt}`,
        PATCH_USER_DATA_DIR: join(work, 'electron-data'),
        PATCH_AUDIO_TAP_FILE: built.callWav,
        PATCH_AUDIO_MIC_FEED: micFeed.path,
        PATCH_AUDIO_SPEAKERS_FEED: speakersFeed.path,
      },
    },
  );

  const require_ = createRequire(join(ROOT, 'packages', 'web', 'package.json'));
  const { chromium } = require_('playwright') as typeof import('playwright');
  await waitFor(
    'the debugging port',
    () => healthy(`http://127.0.0.1:${CDP_PORT}/json/version`),
    60_000,
  );
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  await waitFor(
    'the app page',
    () =>
      browser
        .contexts()[0]
        ?.pages()
        .some((p) => p.url().includes('/app/')) ?? false,
    60_000,
  );
  const page = browser
    .contexts()[0]!
    .pages()
    .find((p) => p.url().includes('/app/'))!;

  // Count the microphone opens: the first, and one for each device change followed.
  await page.evaluate(`(() => {
    window.__micOpens = 0;
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => { window.__micOpens += 1; return orig(c); };
  })()`);

  // A call app opens the mic: the start prompt must fire (it is logged, not shown).
  micFeed.send({ processes: [{ pid: 4242, bundleId: CALL_APP_BUNDLE }] });
  await waitFor(
    'the start prompt',
    () => electronEvents(electronLog).some((e) => e.type === 'meeting:prompt-shown'),
    20_000,
  );
  log('start prompt fired');

  // Start the meeting the way the prompt's click would: the Meeting button, then Start.
  await page.getByTestId('meeting-btn').click();
  await page.getByTestId('meeting-setup-start').click();
  const meetingFile = join(
    stack.patchHome,
    'meetings',
    `${chatId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`,
  );
  const readState = (): Observed['state'] | null =>
    existsSync(meetingFile)
      ? (JSON.parse(readFileSync(meetingFile, 'utf8')) as { state: Observed['state'] }).state
      : null;
  await waitFor('the meeting to go live', () => readState()?.status === 'live', 30_000);
  const startAt = Date.now();
  log('meeting live');

  scheduleSpeakers(speakersFeed, timeline, startAt);
  const at = async (sec: number): Promise<void> => {
    await sleep(Math.max(0, startAt + sec * 1000 - Date.now()));
  };

  // Kill the mic watcher in the first silence: it must come back.
  const firstSilence = timeline.stretches.find((s) => s.kind === 'silence')!;
  await at(firstSilence.start + 3);
  const kids = execFileSync('pgrep', ['-P', String(electron.pid), '-f', 'mic-watch'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  if (kids.length !== 1 || kids[0] === '')
    throw new Error(`expected one mic-watch child, found ${kids.length}`);
  process.kill(Number(kids[0]), 'SIGKILL');
  await waitFor(
    'the mic watcher to restart',
    () => electronEvents(electronLog).some((e) => e.type === 'meeting:detection-restart'),
    20_000,
  );
  log('mic watcher restarted');

  // Switch the input device: the page must open a fresh mic and carry on.
  await at(timeline.switchAt);
  await page.evaluate(`navigator.mediaDevices.dispatchEvent(new Event('devicechange'))`);
  await waitFor(
    'the mic to be re-opened',
    async () => ((await page.evaluate('window.__micOpens')) as number) >= 2,
    10_000,
  );
  log('mic switched');

  // The call ends: Teams lets go of the mic. The meeting must end by itself.
  await at(timeline.totalSeconds);
  micFeed.send({ processes: [] });
  await waitFor(
    'the meeting to end itself',
    () => electronEvents(electronLog).some((e) => e.type === 'meeting:auto-ended'),
    60_000,
  );
  log('meeting auto-ended');
  await waitFor(
    'the write-up',
    () => {
      const s = readState();
      return (
        s?.status === 'ended' &&
        (s.writeup != null || (s as { writeupError?: string | null }).writeupError != null)
      );
    },
    240_000,
  );

  const micOpens = (await page.evaluate('window.__micOpens')) as number;
  const observed: Observed = {
    state: readState()!,
    lines: timeline.lines,
    events: electronEvents(electronLog),
    micOpens,
  };
  const verdict = evaluate(observed);
  writeFileSync(join(work, 'report.json'), JSON.stringify({ verdict, observed }, null, 2));
  console.log(reportLine(verdict));
  await browser.close().catch(() => undefined);
  if (!keep) rmSync(work, { recursive: true, force: true });
  else log(`kept ${work}`);
  return verdict.ok ? 0 : 1;
}

function stopAll(): void {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
}

main()
  .then((code) => {
    stopAll();
    process.exit(code);
  })
  .catch((err: unknown) => {
    stopAll();
    const msg = (err as Error).message;
    if (err instanceof CannotRun) {
      console.log(`SKIP meeting-e2e: ${msg}`);
      process.exit(2);
    }
    console.log(`FAIL meeting-e2e: ${msg}`);
    process.exit(1);
  });
