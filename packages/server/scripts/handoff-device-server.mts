// A real hub (buildAll) with a scripted stand-in for the host, so the browser
// hand-off bar can be exercised on a real Android screen without deploying.
//
//   cd packages/server && npx tsx scripts/handoff-device-server.mts <port> <frameDir>
//
// Prints `LINK <pairing deep link>` once up, then `INPUT <json>` for every
// browser event the phone sends back (the host side of the hand-off), and
// answers a scroll with the second frame so a drag visibly moves the page.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const [port = '4455', frameDir = '.'] = process.argv.slice(2);
const frame = (name: string): string => readFileSync(join(frameDir, name)).toString('base64');
const top = frame('top.jpg');
const scrolled = frame('scrolled.jpg');
const W = 1280;
const H = 800;

const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
const registry = Registry.load(mkdtempSync(join(tmpdir(), 'patch-handoff-device-')));
registry.bootstrapAccount({ keypair: user });
registry.upsertSurface({ surfaceId: 'srf-emu', surfaceKind: 'mobile', label: 'emulator', issuedAt: 1 });
const hostLink = new InProcessHostLink();
const built = await buildAll({ logger: { level: 'info' }, registry, hostLink });
await built.app.listen({ port: Number(port), host: '127.0.0.1' });
const jwt = await mintSurfaceCredential({
  userPrivateKey: user.privateKey,
  surfaceId: 'srf-emu',
  surfaceKind: 'mobile',
  label: 'emulator',
});
console.log(`LINK patch://x?credential=${jwt}&server=${encodeURIComponent(`http://localhost:${port}`)}`);

let handedOff = false;
const emitFrame = (data: string): void =>
  hostLink.emit({
    type: 'patch.browser_view.frame', chatId: 'c1', tabId: 't1', data,
    width: W, height: H, url: 'https://accounts.example.com/signin', title: 'Sign in',
  } as WireEvent);
const seedChat = (): void => {
hostLink.emit({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '/tmp/handoff-chat' } as WireEvent);
hostLink.emit({
  type: 'chat.tool_call', chatId: 'c1', tool: 'mcp__patch__patch_browser_open',
  args: { url: 'https://accounts.example.com/signin' }, callId: 'k1', seq: 1,
} as WireEvent);

};
if (!process.env.NOCHAT) seedChat();
// The phone may connect after the chat was announced; keep announcing until it watches.
const reseed = setInterval(() => (handedOff || process.env.NOCHAT ? clearInterval(reseed) : seedChat()), 4000);

let seen = 0;
const TRIGGER = join(frameDir, 'handoff');
setInterval(() => {
  // `touch <frameDir>/handoff` puts the hand-off into the chat, as the agent would.
  if (existsSync(TRIGGER)) {
    rmSync(TRIGGER);
    handedOff = true;
    seedChat();
    hostLink.emit({
      type: 'patch.browser_handoff.state', chatId: 'c1', handoffId: 'h1', tabId: 't1',
      status: 'waiting', reason: 'Sign in to continue', startedAt: Date.now(),
    } as WireEvent);
    emitFrame(top);
  }
  const mine = hostLink.sent.map((s) => s.event);
  for (const e of mine.slice(seen)) {
    if (!e.type.startsWith('patch.browser_')) continue;
    console.log(`INPUT ${JSON.stringify(e)}`);
    if (e.type === 'patch.browser_view.watch' && (e as { watch: boolean }).watch) emitFrame(top);
    if (e.type === 'patch.browser_handoff.input' && (e as any).input.kind === 'scroll') emitFrame(scrolled);
  }
  seen = mine.length;
}, 100);
