// Screenshots of the real web app for the website, taken from the web dev
// harness with demo chats in place of its fixtures. Start the harness first:
//
//   cd packages/web && npx vite --port 5199 --strictPort
//   node ../../site/tools/capture.mjs ../../site/img
//
// Run from packages/web so Playwright resolves.
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const { chromium } = require('playwright');
const outDir = process.argv[2];
if (!outDir) throw new Error('usage: capture.mjs <out-dir>');

const BASE = 'http://localhost:5199/app/dev-harness.html';

async function stage(page, { openChat, timeline, theme, collapsed }) {
  await page.evaluate(
    async ({ openChat, timeline, theme, collapsed }) => {
      const { useChatStore } = await import('/app/src/stores/chatStore.ts');
      const now = Date.now();
      const min = 60_000;
      const row = (chatId, name, folder, ago, extra = {}) => ({
        chatId,
        hostId: 'd1',
        permissionMode: 'auto',
        name,
        folder,
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: now - ago * min,
        model: 'claude-opus-4-6',
        ...extra,
      });
      const special = useChatStore.getState().chats;
      const keep = ['thread_manager', 'thread_speakers'].map((id) => special[id]).filter(Boolean);
      useChatStore
        .getState()
        .hydrate([
          ...keep,
          row(openChat, 'Fix flaky checkout test', '/home/dev/shop', 2),
          row('d_rate', 'Rate limit the public API', '/home/dev/shop', 6, { activity: 'running' }),
          row('d_refund', 'Refund webhook retries', '/home/dev/shop', 41),
          row('d_dark', 'Dark mode for settings', '/home/dev/site', 12, { activity: 'running' }),
          row('d_react', 'Upgrade to React 19', '/home/dev/site', 95),
          row('d_copy', 'Pricing page copy', '/home/dev/site', 180),
          row('d_certs', 'Renew staging certificates', '/home/dev/infra', 300),
          row('d_backup', 'Nightly backup check', '/home/dev/infra', 520),
          row('d_logs', 'Trim log retention', '/home/dev/infra', 1440),
        ]);
      useChatStore.setState((s) => ({ timelines: { ...s.timelines, [openChat]: timeline } }));
      if (theme) document.documentElement.dataset.theme = theme;
      const { useUiStore } = await import('/app/src/stores/uiStore.ts');
      useUiStore.getState().setSidebarWidth(300);
      if (collapsed) useUiStore.getState().setSidebarCollapsed(true);
    },
    { openChat, timeline, theme, collapsed },
  );
  await page.waitForTimeout(800);
  // Harness-only furniture: the dev source badge, stub-fetch error toasts,
  // and the sign-in banner the harness shows because nothing is signed in.
  await page.evaluate(() => {
    const kill = (el) => el && el.remove();
    // A collapsed sidebar's expand control sits over the back arrow.
    document.querySelectorAll('.sidebar-expand-btn').forEach(kill);
    document.querySelectorAll('*').forEach((el) => {
      if (el.children.length > 2) return;
      const t = el.textContent ?? '';
      if (/^\s*LOCAL/.test(t) && el.closest('[class*="badge"], [class*="source"]')) kill(el);
    });
    document
      .querySelectorAll(
        '[class*="toast"], [class*="Toast"], [class*="dev-error"], [class*="devsource"], [class*="dev-source"]',
      )
      .forEach(kill);
    document.querySelectorAll('[role="alert"], [class*="banner"]').forEach((el) => {
      if (/signed in|section counts|HTTP/i.test(el.textContent ?? '')) kill(el);
    });
  });
  await page.waitForTimeout(300);
}

const t = (seq, e) => ({ seq, at: Date.now() - (40 - seq) * 20_000, ...e });
const timeline = [
  t(1, {
    kind: 'message',
    role: 'user',
    content: 'The checkout test fails about one run in ten. Find out why and fix it.',
  }),
  t(2, { callId: 'c2', kind: 'tool_call', tool: 'Grep', toolArgs: { pattern: 'checkout' } }),
  t(3, {
    callId: 'c2',
    kind: 'tool_result',
    tool: 'Grep',
    toolResult: { files: ['e2e/checkout.spec.ts'] },
  }),
  t(4, {
    callId: 'c4',
    kind: 'tool_call',
    tool: 'Read',
    toolArgs: { file_path: 'e2e/checkout.spec.ts' },
  }),
  t(5, { callId: 'c4', kind: 'tool_result', tool: 'Read', toolResult: { lines: 88 } }),
  t(6, {
    callId: 'c6',
    kind: 'tool_call',
    tool: 'Bash',
    toolArgs: {
      command: 'pnpm e2e checkout --repeat-each 30',
      description: 'Run the test 30 times',
    },
  }),
  t(7, { callId: 'c6', kind: 'tool_result', tool: 'Bash', toolResult: { code: 1 } }),
  t(8, {
    kind: 'message',
    role: 'assistant',
    content:
      'Found it. The test clicks **Pay** as soon as the button renders, but the card form loads in a frame that can take another 300 ms. When it is late, the click lands on nothing.',
  }),
  t(9, {
    callId: 'c9',
    kind: 'tool_call',
    tool: 'Read',
    toolArgs: { file_path: 'e2e/helpers/pay.ts' },
  }),
  t(10, { callId: 'c9', kind: 'tool_result', tool: 'Read', toolResult: { lines: 40 } }),
  t(11, {
    callId: 'c11',
    kind: 'tool_call',
    tool: 'Bash',
    toolArgs: {
      command: 'pnpm e2e checkout --repeat-each 50',
      description: 'Run the test 50 times',
    },
  }),
  t(12, { callId: 'c11', kind: 'tool_result', tool: 'Bash', toolResult: { code: 0 } }),
  t(13, {
    kind: 'message',
    role: 'assistant',
    content:
      'Fixed: the test now waits for the card form to be ready before it pays.\n\n- 50 runs in a row, no failures\n- Run time up 0.4 s\n\nWant me to open a PR?',
  }),
];

const voice = (seq, role, content) => ({
  seq,
  kind: 'message',
  role,
  content,
  voice: true,
  at: Date.now() - (10 - seq) * 15_000,
});
const callTimeline = [
  voice(1, 'user', 'How did the checkout fix go?'),
  voice(
    2,
    'assistant',
    'It passed fifty runs in a row. The test now waits for the card form before it pays.',
  ),
  voice(3, 'user', 'Great. Open a PR and put the run numbers in the description.'),
  voice(4, 'assistant', 'Opening it now.'),
];

const b = await chromium.launch();
const shots = [
  { name: 'desktop-light', w: 1440, h: 900, theme: 'light' },
  { name: 'desktop-dark', w: 1440, h: 900, theme: 'dark' },
  {
    name: 'call-light',
    w: 1000,
    h: 720,
    theme: 'light',
    query: '&voice=call',
    timeline: callTimeline,
    collapsed: true,
  },
  {
    name: 'call-dark',
    w: 1000,
    h: 720,
    theme: 'dark',
    query: '&voice=call',
    timeline: callTimeline,
    collapsed: true,
  },
  { name: 'chat-light', w: 760, h: 860, theme: 'light', timeline, collapsed: true },
  { name: 'chat-dark', w: 760, h: 860, theme: 'dark', timeline, collapsed: true },
];
for (const s of shots) {
  const page = await b.newPage({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 2 });
  await page.goto(`${BASE}?chat=chat_tools${s.query ?? ''}`, { timeout: 180_000 });
  await page.waitForTimeout(2500);
  await stage(page, {
    openChat: 'chat_tools',
    timeline: s.timeline ?? timeline,
    theme: s.theme,
    collapsed: s.collapsed,
  });
  await page.screenshot({ path: path.join(outDir, `${s.name}.png`) });
  await page.close();
}
await b.close();
console.log('captured →', outDir);
