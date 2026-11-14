// Screenshots of the real web app for the website, taken from the web dev
// harness with demo content in place of its fixtures. Start the harness first:
//
//   cd packages/web && npx vite --port 5199 --strictPort
//   node ../../site/tools/capture.mjs ../../site/img [shot…]
//
// Run from packages/web so Playwright resolves. Each shot is written as
// <name>-light.png and <name>-dark.png; site/tools/webp.sh turns them into
// the .webp files the page uses. Naming shots on the command line takes just
// those.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const { chromium } = require('playwright');
const outDir = process.argv[2];
if (!outDir) throw new Error('usage: capture.mjs <out-dir> [shot…]');
const only = process.argv.slice(3);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAD_PUBLIC = path.join(HERE, '../../packages/server/src/pads/public');
const BASE = 'http://localhost:5199/app/dev-harness.html';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------- the server

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'openai/gpt-5.5-codex', label: 'GPT-5.5 Codex' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
];

const ACCOUNTS = {
  claude: [
    { id: 'c1', label: 'Personal Max', connected: true, email: 'me@example.com' },
    { id: 'c2', label: 'Work Team', connected: true, email: 'me@work.example' },
    { id: 'c3', label: 'Side project', connected: true, email: 'builds@example.com' },
  ],
  codex: [
    { id: 'o1', label: 'ChatGPT Pro', kind: 'chatgpt', connected: true, email: 'me@example.com' },
  ],
};

const ago = (ms) => Date.now() - ms;

const JOBS = [
  {
    id: 'j_triage',
    name: 'Triage new issues',
    group: 'Shop',
    enabled: true,
    trigger: { type: 'webhook', scheme: 'github' },
    filter: '$.payload.action = "opened"',
    action: { type: 'spawn', hostId: 'd2', folder: '/srv/shop', prompt: 'Triage this issue.' },
    queueing: { mode: 'queue', concurrency: 2 },
    createdAt: ago(20 * DAY),
    updatedAt: ago(2 * DAY),
  },
  {
    id: 'j_deps',
    name: 'Weekly dependency updates',
    group: 'Shop',
    enabled: true,
    trigger: { type: 'cron', expression: '0 7 * * 1', timezone: 'Europe/London' },
    filter: null,
    action: {
      type: 'spawn',
      hostId: 'd2',
      folder: '/srv/shop',
      prompt: 'Update dependencies and open a PR.',
    },
    createdAt: ago(40 * DAY),
    updatedAt: ago(9 * DAY),
  },
  {
    id: 'j_review',
    name: 'Review after deploy',
    group: 'Shop',
    enabled: true,
    trigger: { type: 'follows', jobId: 'j_deps', on: 'success' },
    filter: null,
    action: { type: 'spawn', hostId: 'd2', folder: '/srv/shop', prompt: 'Check the deploy.' },
    createdAt: ago(12 * DAY),
    updatedAt: ago(3 * DAY),
  },
  {
    id: 'j_todo',
    name: 'Tasks tagged @agent',
    group: 'Personal',
    enabled: true,
    trigger: { type: 'webhook', scheme: 'todoist' },
    filter: '"agent" in $.payload.event_data.labels',
    action: {
      type: 'continue',
      hostId: 'd1',
      folder: '/Users/dev/notes',
      key: '{{payload.event_data.id}}',
      prompt: 'Do this task.',
    },
    createdAt: ago(30 * DAY),
    updatedAt: ago(DAY),
  },
  {
    id: 'j_photos',
    name: 'Sort new photos',
    group: 'Personal',
    enabled: true,
    trigger: { type: 'cron', expression: '*/10 * * * *' },
    gate: {
      hostId: 'd1',
      folder: '/Users/dev/photos',
      command:
        'n=$(ls inbox | wc -l)\n[ "$n" -gt 0 ] || { echo "inbox empty"; exit 1; }\necho "$n new"',
    },
    window: { days: [1, 2, 3, 4, 5, 6, 0], start: '08:00', end: '22:00' },
    wakeHost: true,
    filter: null,
    action: {
      type: 'spawn',
      hostId: 'd1',
      folder: '/Users/dev/photos',
      prompt: 'Sort {{gate.stdout}}.',
    },
    createdAt: ago(15 * DAY),
    updatedAt: ago(4 * DAY),
  },
  {
    id: 'j_backup',
    name: 'Nightly backup check',
    group: 'Infra',
    enabled: true,
    trigger: { type: 'cron', expression: '30 2 * * *', timezone: 'Europe/London' },
    filter: null,
    action: {
      type: 'spawn',
      hostId: 'd2',
      folder: '/srv/infra',
      prompt: 'Check last night’s backup.',
    },
    createdAt: ago(60 * DAY),
    updatedAt: ago(10 * DAY),
  },
];

const LATEST = {
  j_triage: { ts: ago(25 * MIN), status: 'ok' },
  j_deps: { ts: ago(4 * DAY), status: 'ok' },
  j_review: { ts: ago(4 * DAY), status: 'ok' },
  j_todo: { ts: ago(2 * HOUR), status: 'ok' },
  j_photos: { ts: ago(4 * MIN), status: 'gate-held' },
  j_backup: { ts: ago(14 * HOUR), status: 'ok' },
};

const RUNS = {
  j_photos: [
    {
      ts: ago(4 * MIN),
      jobId: 'j_photos',
      status: 'gate-held',
      trigger: 'cron',
      output: 'inbox empty',
    },
    { ts: ago(14 * MIN), jobId: 'j_photos', status: 'ok', trigger: 'cron', chatId: 'd_photos' },
  ],
};

const PAD = {
  id: 'p_checkout',
  name: 'Checkout redesign',
  app: 'Shop',
  chatId: 'd_pad',
  device: 'desktop',
  createdAt: ago(3 * HOUR),
  updatedAt: ago(4 * MIN),
  pending: 2,
  working: false,
  screens: [
    { id: 'payment', name: 'Payment', path: 'payment.html', pending: 2, thumbUrl: null },
    { id: 'confirmed', name: 'Confirmed', path: 'confirmed.html', pending: 0, thumbUrl: null },
  ],
  screensError: null,
  frameUrl: '/api/padx/p_checkout/sig/',
  share: null,
  thumbUrl: null,
  thumbError: null,
};

const PAD_CHANGES = [
  {
    id: 'ch1',
    kind: 'text',
    screen: 'payment',
    status: 'pending',
    createdAt: ago(6 * MIN),
    target: { selector: '#pay', label: 'button "Pay £48.00"' },
    before: 'Pay £48.00',
    after: 'Pay now · £48.00',
    viewport: { w: 900, h: 760 },
  },
  {
    id: 'ch2',
    kind: 'note',
    screen: 'payment',
    status: 'pending',
    createdAt: ago(4 * MIN),
    target: { selector: '.summary', label: 'Order summary' },
    text: 'Make the total bigger than the line items',
    offset: { x: 24, y: -12 },
    viewport: { w: 900, h: 760 },
  },
];

const PAD_SCREEN = (
  body,
) => `<!doctype html><html><head><meta charset="utf-8"><title>Payment</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, system-ui, sans-serif; color: #1d1d1f; background: #f6f5f2; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 28px 28px; display: grid; grid-template-columns: 1.3fr 1fr; gap: 28px; }
  h1 { grid-column: 1 / -1; margin: 0; font-size: 26px; letter-spacing: -0.01em; }
  .card { background: #fff; border-radius: 14px; padding: 22px; box-shadow: 0 1px 2px rgb(0 0 0 / 6%); }
  label { display: block; font-size: 13px; color: #6b6b70; margin: 0 0 6px; }
  .field { border: 1px solid #dcdad5; border-radius: 9px; padding: 11px 12px; margin-bottom: 14px; color: #8a8a8f; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  #pay { width: 100%; border: 0; border-radius: 10px; padding: 14px; background: #2f6b3a; color: #fff; font: 600 16px system-ui; }
  .summary .line { display: flex; justify-content: space-between; padding: 6px 0; color: #4a4a4f; }
  .summary .total { border-top: 1px solid #ebe9e4; margin-top: 8px; padding-top: 12px; font-weight: 600; color: #1d1d1f; }
</style></head><body>${body}</body></html>`;

const PAYMENT = PAD_SCREEN(`<div class="wrap">
  <h1>Checkout</h1>
  <div class="card">
    <label>Card number</label><div class="field">1234 1234 1234 1234</div>
    <div class="row"><div><label>Expiry</label><div class="field">MM / YY</div></div><div><label>CVC</label><div class="field">123</div></div></div>
    <label>Name on card</label><div class="field">Full name</div>
    <button id="pay">Pay £48.00</button>
  </div>
  <div class="card summary">
    <div class="line"><span>Linen shirt</span><span>£36.00</span></div>
    <div class="line"><span>Delivery</span><span>£4.00</span></div>
    <div class="line"><span>VAT</span><span>£8.00</span></div>
    <div class="line total"><span>Total</span><span>£48.00</span></div>
  </div>
</div>`);
const PAYMENT_AFTER = PAYMENT.replace('>Pay £48.00<', '>Pay now · £48.00<').replace(
  '.summary .total { border-top',
  '.summary .total { font-size: 22px; } .summary .total { border-top',
);
const CONFIRMED = PAD_SCREEN(`<div class="wrap"><h1>Thanks — order placed</h1></div>`);

/** A matcher for the server's own paths only — never the app's /app/src/api modules. */
function api(pattern) {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*') +
      '$',
  );
  return (url) => re.test(url.pathname + url.search) || re.test(url.pathname);
}

async function stubServer(page) {
  const json = (body, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  const me = {
    account: { accountId: 'acct-1', userPublicKey: 'acct-1', createdAt: 1 },
    surface: { surfaceId: 'web-1', surfaceKind: 'web', label: 'web', issuedAt: 2 },
  };
  const { DEFAULT_SHARED_SETTINGS } = await import(
    path.join(process.cwd(), '../wire/dist/index.js')
  );
  const preferences = {
    ...DEFAULT_SHARED_SETTINGS,
    suppressProviderSwitchWarning: true,
    accountStrategy: { claude: 'least-used', codex: 'priority' },
  };
  const shared = {
    version: 1,
    settings: preferences,
    secrets: {
      claude: ACCOUNTS.claude,
      codex: ACCOUNTS.codex,
      providerKeys: [],
    },
    hosts: [],
  };
  // Anything not stubbed below answers 404, as an absent endpoint does.
  await page.route(api('/api/**'), (r) => r.fulfill(json({ error: 'not_found' }, 404)));
  await page.route(api('/api/auth/me'), (r) => r.fulfill(json(me)));
  await page.route(api('/api/settings'), (r) =>
    r.fulfill(
      json({
        account: me.account,
        devices: [],
        push: { tokenCount: 1 },
        daemon: { registered: true, status: 'online', lastConnectedAt: Date.now() },
        projectFolders: [],
        preferences,
        shared: { version: 1, secrets: shared.secrets, hosts: [] },
      }),
    ),
  );
  await page.route(api('/api/settings/shared'), (r) => r.fulfill(json(shared)));
  await page.route(api('/api/models*'), (r) =>
    r.fulfill(json({ models: MODELS, fetchedAt: new Date().toISOString() })),
  );
  await page.route(api('/api/chats/counts*'), (r) =>
    r.fulfill(json({ archived: 4, hidden: 1, snoozed: 2, deleted: 0, automations: 0 })),
  );
  await page.route(api('/api/chats/folders*'), (r) => r.fulfill(json({ folders: [] })));
  await page.route(api('/api/usage-report**'), (r) =>
    r.fulfill(
      json({ since: ago(7 * DAY), until: Date.now(), at: Date.now(), samples: [], chats: [] }),
    ),
  );
  await page.route(api('/api/jobs**'), (r) => {
    const u = new URL(r.request().url());
    const m = u.pathname.match(/^\/api\/jobs\/([^/]+)\/runs/);
    if (m) return r.fulfill(json({ runs: RUNS[m[1]] ?? [] }));
    const one = u.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (one) return r.fulfill(json(JOBS.find((j) => j.id === one[1]) ?? {}));
    return r.fulfill(json({ jobs: JOBS.map((j) => ({ ...j, latestRun: LATEST[j.id] ?? null })) }));
  });
  await page.route(api('/api/pads**'), (r) => {
    const u = new URL(r.request().url());
    const live = page.padLive;
    const view = live
      ? {
          ...PAD,
          pending: live.changes.filter((c) => c.status === 'pending').length,
          working: live.batches.some((b) => b.status === 'sent'),
        }
      : PAD;
    if (u.pathname === '/api/pads') return r.fulfill(json({ pads: [view] }));
    return r.fulfill(json(view));
  });
  await page.route(api('/api/padx/**'), (r) => {
    const u = new URL(r.request().url());
    const rest = u.pathname.replace(/^\/api\/padx\/[^/]+\/[^/]+\//, '');
    const types = {
      html: 'text/html',
      js: 'text/javascript',
      css: 'text/css',
      svg: 'image/svg+xml',
    };
    if (rest === '' || rest === 'editor.js' || rest === 'editor.css' || rest === 'icon.svg') {
      const file = rest === '' ? 'editor.html' : rest;
      return r.fulfill({
        status: 200,
        contentType: types[file.split('.').pop()],
        body: readFileSync(path.join(PAD_PUBLIC, file)),
      });
    }
    const live = page.padLive;
    if (live && rest.startsWith('api/')) {
      const method = r.request().method();
      const body = r.request().postData() ? r.request().postDataJSON() : {};
      if (method === 'POST' && rest === 'api/changes') {
        const change = {
          id: `ch${live.changes.length + 1}`,
          status: 'pending',
          createdAt: Date.now(),
          ...body,
        };
        live.changes.push(change);
        return r.fulfill(json(change));
      }
      const m = rest.match(/^api\/changes\/(.+)$/);
      if (m && method === 'PATCH') {
        const c = live.changes.find((x) => x.id === m[1]);
        Object.assign(c, body);
        return r.fulfill(json(c));
      }
      if (m && method === 'DELETE') {
        live.changes = live.changes.filter((x) => x.id !== m[1]);
        return r.fulfill(json({ ok: true }));
      }
      if (rest === 'api/send') {
        const ids = live.changes.filter((c) => c.status === 'pending').map((c) => c.id);
        live.changes.forEach((c) => {
          if (c.status === 'pending') Object.assign(c, { status: 'sent', batch: 'b1' });
        });
        live.batches.push({ id: 'b1', sentAt: Date.now(), changeIds: ids, status: 'sent' });
        live.onSend?.();
        return r.fulfill(json({ ok: true }));
      }
    }
    if (rest === 'api') {
      return r.fulfill(
        json({
          design: {
            id: PAD.id,
            name: PAD.name,
            working: live ? live.batches.some((b) => b.status === 'sent') : false,
          },
          rev: live ? live.rev : 1,
          screens: PAD.screens.map(({ id, name, path: p }) => ({ id, name, path: p })),
          changes: live ? live.changes : PAD_CHANGES,
          batches: live ? live.batches : [],
          device: 'desktop',
        }),
      );
    }
    if (rest === 'f/payment.html')
      return r.fulfill({
        status: 200,
        contentType: 'text/html',
        body: live && live.rev > 1 ? PAYMENT_AFTER : PAYMENT,
      });
    if (rest === 'f/confirmed.html')
      return r.fulfill({ status: 200, contentType: 'text/html', body: CONFIRMED });
    return r.fulfill(json({ error: 'not_found' }, 404));
  });
}

// ------------------------------------------------------------ the demo chats

/** Two machines, three projects, chats on both. */
async function stageChats(
  page,
  { theme, openChat, timelines = {}, models = {}, extra = {}, collapsed = false },
) {
  await page.waitForFunction(() => '__store' in window && '__presenceStore' in window);
  await page.evaluate(
    async ({ theme, openChat, timelines, models, extra, collapsed }) => {
      const { useChatStore } = await import('/app/src/stores/chatStore.ts');
      const { usePresenceStore } = await import('/app/src/stores/presenceStore.ts');
      const now = Date.now();
      const min = 60_000;
      const presence = usePresenceStore.getState();
      const base = presence.hosts['d1'].host;
      const account = (hostId, backendId) => ({
        type: 'host.account',
        hostId,
        backendId,
        connected: true,
        accountEmail: 'me@example.com',
      });
      presence.setHostReport({ ...base, type: 'host.host', hostId: 'd1', hostName: 'laptop' });
      presence.setHostReport({
        ...base,
        type: 'host.host',
        hostId: 'd2',
        hostName: 'server',
        runsManager: false,
      });
      presence.setHostOnline('d2', true);
      for (const hostId of ['d1', 'd2']) {
        presence.setHostAccount(account(hostId, 'claude-code'));
        presence.setHostAccount(account(hostId, 'codex'));
      }
      presence.setHostFolders('d1', ['/Users/dev/shop', '/Users/dev/site', '/Users/dev/notes'], []);
      presence.setHostFolders('d2', ['/srv/shop', '/srv/infra'], []);

      const row = (chatId, hostId, name, folder, agoMin, more = {}) => ({
        chatId,
        hostId,
        permissionMode: 'auto',
        name,
        folder,
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: now - agoMin * min,
        model: models[chatId] ?? 'claude-opus-5-5',
        ...more,
        ...(extra[chatId] ?? {}),
      });
      const special = useChatStore.getState().chats;
      const keep = ['thread_manager'].map((id) => special[id]).filter(Boolean);
      useChatStore.getState().hydrate([
        ...keep,
        row('d_checkout', 'd1', 'Fix flaky checkout test', '/Users/dev/shop', 2),
        row('d_pad', 'd1', 'Checkout redesign', '/Users/dev/shop', 4),
        row('d_refund', 'd1', 'Refund webhook retries', '/Users/dev/shop', 41),
        row('d_rate', 'd2', 'Rate limit the public API', '/srv/shop', 6),
        row('d_load', 'd2', 'Load test the cart', '/srv/shop', 9, { activity: 'running' }),
        row('d_dark', 'd1', 'Dark mode for settings', '/Users/dev/site', 12, {
          activity: 'running',
        }),
        row('d_copy', 'd1', 'Pricing page copy', '/Users/dev/site', 180),
        row('d_certs', 'd2', 'Renew staging certificates', '/srv/infra', 300),
        row('d_backup', 'd2', 'Nightly backup check', '/srv/infra', 520),
        row('d_index', 'd2', 'Rebuild the search index', '/srv/shop', 1),
      ]);
      useChatStore.setState((s) => ({ timelines: { ...s.timelines, ...timelines } }));
      if (theme) document.documentElement.dataset.theme = theme;
      const { useUiStore } = await import('/app/src/stores/uiStore.ts');
      useUiStore.getState().setSidebarWidth(320);
      if (collapsed) useUiStore.getState().setSidebarCollapsed(true);
      if (openChat) {
        const { useLayoutStore } = await import('/app/src/stores/layoutStore.ts');
        useLayoutStore.getState().showChat(openChat);
      }
    },
    { theme, openChat, timelines, models, extra, collapsed },
  );
  await page.waitForTimeout(600);
}

/** Harness-only furniture: the dev source badge, toasts, sign-in banners. */
async function clean(page) {
  await page.evaluate(() => {
    // Hidden, not removed: React still owns these nodes.
    const kill = (el) => el && el.style.setProperty('display', 'none', 'important');
    // A collapsed sidebar's expand control sits over the header.
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
      if (/signed in|section counts|HTTP|not_found/i.test(el.textContent ?? '')) kill(el);
    });
  });
  await page.waitForTimeout(200);
}

const at = (n) => Date.now() - (60 - n) * 25_000;
const msg = (seq, role, content, extra = {}) => ({
  seq,
  kind: 'message',
  role,
  content,
  at: at(seq),
  messageAt: at(seq),
  ...extra,
});
const tool = (seq, callId, name, args, result) => [
  { seq, callId, kind: 'tool_call', tool: name, toolArgs: args, at: at(seq) },
  { seq: seq + 1, callId, kind: 'tool_result', tool: name, toolResult: result, at: at(seq) },
];

const checkoutTimeline = [
  msg(1, 'user', 'The checkout test fails about one run in ten. Find out why and fix it.'),
  ...tool(2, 'c2', 'Grep', { pattern: 'checkout' }, { files: ['e2e/checkout.spec.ts'] }),
  ...tool(
    4,
    'c4',
    'Bash',
    { command: 'pnpm e2e checkout --repeat-each 30', description: 'Run the test 30 times' },
    { code: 1 },
  ),
  msg(
    6,
    'assistant',
    'Found it. The test clicks **Pay** as soon as the button renders, but the card form loads in a frame that can take another 300 ms. When it is late, the click lands on nothing.',
  ),
  ...tool(7, 'c7', 'Edit', { file_path: 'e2e/helpers/pay.ts' }, { ok: true }),
  ...tool(
    9,
    'c9',
    'Bash',
    { command: 'pnpm e2e checkout --repeat-each 50', description: 'Run the test 50 times' },
    { code: 0 },
  ),
  msg(
    11,
    'assistant',
    'Fixed: the test waits for the card form before it pays. 50 runs in a row, no failures.',
  ),
];

const providerTimeline = [
  msg(1, 'user', 'Add rate limiting to the public API: 100 requests a minute per key.'),
  ...tool(2, 'r2', 'Read', { file_path: 'src/api/server.ts' }, { lines: 140 }),
  ...tool(4, 'r4', 'Edit', { file_path: 'src/api/limit.ts' }, { ok: true }),
  msg(
    6,
    'assistant',
    'Added a token-bucket limiter keyed on the API key, with a `429` and a `Retry-After` header when a key runs out.',
  ),
  msg(7, 'user', 'Get Codex to review it and write the load test.'),
  {
    seq: 8,
    kind: 'handoff',
    content: 'Handed off to GPT-5.5 Codex',
    at: at(8),
  },
  ...tool(
    9,
    'r9',
    'Bash',
    { command: 'k6 run load/limit.js', description: 'Load test the limiter' },
    { code: 0 },
  ),
  msg(
    11,
    'assistant',
    'Reviewed. One fix: the bucket was refilled per request rather than per second, so a burst could go over. Load test at 300 requests a minute: 100 succeed, the rest get `429`.',
  ),
];

const padTimeline = [
  msg(1, 'user', 'The checkout page feels cramped. Show me a cleaner layout.'),
  ...tool(2, 'p2', 'Write', { file_path: 'design/checkout/payment.html' }, { ok: true }),
  msg(
    4,
    'assistant',
    'Here’s a two-column version: the card form on the left, the order summary beside it, and one clear Pay button. It’s on the Pad. Change anything there and send it back.',
  ),
];

// ------------------------------------------------------------------- shots

const REPORT = `<!doctype html><html><head><meta charset="utf-8"><title>Flaky test report</title>
<style>
  body { margin: 0; font: 15px/1.55 -apple-system, system-ui, sans-serif; color: #1d1d1f; background: #fff; }
  main { max-width: 640px; margin: 0 auto; padding: 36px 32px; }
  h1 { font-size: 24px; margin: 0 0 6px; letter-spacing: -0.01em; }
  p { color: #55555a; margin: 0 0 24px; }
  .bars { display: grid; gap: 10px; }
  .bar { display: grid; grid-template-columns: 120px 1fr 48px; gap: 12px; align-items: center; font-size: 14px; }
  .track { height: 10px; border-radius: 6px; background: #eeede8; overflow: hidden; }
  .fill { height: 100%; background: #46802f; }
  .fill.bad { background: #c2410c; }
  @media (prefers-color-scheme: dark) {
    body { background: #1f1e1a; color: #ebe7dc; }
    p { color: #a29b8c; }
    .track { background: #34322b; }
    .fill { background: #77a966; }
  }
</style></head><body><main>
  <h1>Checkout test, 80 runs</h1>
  <p>Before and after waiting for the card form.</p>
  <div class="bars">
    <div class="bar"><span>Before · pass</span><div class="track"><div class="fill" style="width:90%"></div></div><span>27/30</span></div>
    <div class="bar"><span>Before · fail</span><div class="track"><div class="fill bad" style="width:10%"></div></div><span>3/30</span></div>
    <div class="bar"><span>After · pass</span><div class="track"><div class="fill" style="width:100%"></div></div><span>50/50</span></div>
    <div class="bar"><span>After · fail</span><div class="track"><div class="fill bad" style="width:0%"></div></div><span>0/50</span></div>
  </div>
</main></body></html>`;

const LOAD_REPORT = REPORT.replace('Checkout test, 80 runs', 'Rate limiter, 300 requests a minute')
  .replace('Before and after waiting for the card form.', 'One key, sixty seconds.')
  .replace(
    /<div class="bars">[\s\S]*?<\/div>\n<\/main>/,
    `<div class="bars">
    <div class="bar"><span>Allowed</span><div class="track"><div class="fill" style="width:33%"></div></div><span>100</span></div>
    <div class="bar"><span>429</span><div class="track"><div class="fill bad" style="width:67%"></div></div><span>200</span></div>
  </div>
</main>`,
  );

const MISSING_REPORT = REPORT.replace('Checkout test, 80 runs', 'Products missing from search')
  .replace('Before and after waiting for the card form.', 'Before and after the index swap fix.')
  .replace(
    /<div class="bars">[\s\S]*?<\/div>\n<\/main>/,
    `<div class="bars">
    <div class="bar"><span>Before</span><div class="track"><div class="fill bad" style="width:42%"></div></div><span>1,240</span></div>
    <div class="bar"><span>After</span><div class="track"><div class="fill bad" style="width:0%"></div></div><span>0</span></div>
  </div>
</main>`,
  );

/** The page each published artifact serves, by its id. */
function reportFor(url) {
  if (url.includes('load-test')) return LOAD_REPORT;
  if (url.includes('missing-products')) return MISSING_REPORT;
  return REPORT;
}

const artifact = (seq, chatId, id, title) => ({
  seq,
  kind: 'artifact',
  artifactId: id,
  artifactTitle: title,
  artifactUrl: `/api/chats/${chatId}/artifact/${id}`,
  artifactPath: `out/${id}.html`,
  at: at(seq),
});

const statusTimeline = [
  msg(
    1,
    'user',
    'Some products never show up in search. Find out why, fix it, and keep the index healthy.',
  ),
  ...tool(2, 's2', 'Grep', { pattern: 'indexProduct' }, { files: ['src/search/index.ts'] }),
  msg(
    4,
    'assistant',
    'Products added during a rebuild are dropped: the rebuild swaps in an index that was snapshotted before they arrived. I’ve fixed the swap and started a full reindex in the background.',
  ),
  artifact(5, 'd_index', 'missing-products', 'Missing products'),
  msg(6, 'user', 'Once it’s done, run it against staging too.', { queued: true }),
];

const SHOTS = {
  /** The model picker open over a chat that has switched from Claude to Codex. */
  async providers(page, theme, opts = {}) {
    await page.goto(`${BASE}?chat=d_rate&hosts=two`, { timeout: 180_000 });
    await stageChats(page, {
      theme,
      openChat: 'd_rate',
      collapsed: true,
      timelines: { d_rate: providerTimeline },
      models: { d_rate: 'openai/gpt-5.5-codex' },
    });
    await clean(page);
    if (opts.picker) {
      await page.getByTestId('chat-model').first().click();
      await page.waitForTimeout(400);
    }
  },

  /** Settings → Usage: three Claude accounts, their bars, and the strategy. */
  async accounts(page, theme) {
    await page.goto(`${BASE}?route=/settings/usage&hosts=two`, { timeout: 180_000 });
    await stageChats(page, { theme, collapsed: true });
    const now = Date.now();
    await page.evaluate(
      ({ now, accounts }) => {
        const store = window.__presenceStore.getState();
        const w = (u, resetH) => ({
          status: u > 0.9 ? 'allowed_warning' : 'allowed',
          utilization: u,
          resetsAt: now + resetH * 3_600_000,
        });
        const usage = {
          c1: { session: w(0.62, 2.5), week: w(0.41, 70), at: now - 2 * 60_000 },
          c2: { session: w(0.18, 4), week: w(0.27, 110), at: now - 3 * 60_000 },
          c3: { session: w(0.86, 0.6), week: w(0.74, 30), at: now - 60_000 },
          o1: { session: w(0.33, 3), week: w(0.22, 90), at: now - 4 * 60_000 },
        };
        for (const [backendId, list] of [
          ['claude-code', accounts.claude],
          ['codex', accounts.codex],
        ]) {
          store.setHostAccount({
            type: 'host.account',
            hostId: 'd1',
            backendId,
            connected: true,
            accountEmail: 'me@example.com',
            accounts: list.map((a) => ({
              id: a.id,
              label: a.label,
              connected: true,
              accountEmail: a.email,
              usage: usage[a.id],
            })),
          });
        }
      },
      { now, accounts: ACCOUNTS },
    );
    await page.waitForTimeout(500);
    await clean(page);
    // Start at the accounts: the period summaries above them are empty here.
    await page.evaluate(() => {
      const heading = [
        ...document.querySelectorAll('h2, h3, h4, .set-section-title, .set-group-title, div, span'),
      ].find((el) => el.children.length === 0 && el.textContent.trim().toUpperCase() === 'CLAUDE');
      heading.scrollIntoView({ block: 'start' });
      const scroller =
        heading.closest('[class*="scroll"], main, .settings-main') ?? document.scrollingElement;
      scroller.scrollTop -= 24;
    });
    await page.waitForTimeout(300);
  },

  /** Chats on two machines, grouped by project, moving one to the other. */
  async machines(page, theme, opts = {}) {
    await page.goto(`${BASE}?chat=d_checkout&hosts=two`, { timeout: 180_000 });
    await stageChats(page, {
      theme,
      openChat: 'd_checkout',
      timelines: { d_checkout: checkoutTimeline },
    });
    await clean(page);
    await page.getByTestId('action-more').first().click();
    if (opts.dialog) {
      await page.getByTestId('action-move').click();
      await page.getByTestId('move-chat-modal').waitFor();
    } else {
      await page.getByTestId('action-move').hover();
    }
    await page.waitForTimeout(300);
  },

  /** The picker open: Claude and Codex models in one list. */
  async models(page, theme) {
    await SHOTS.providers(page, theme, { picker: true });
  },

  /** The Move dialog over the two-machine sidebar. */
  async move(page, theme) {
    await SHOTS.machines(page, theme, { dialog: true });
  },

  /** The jobs list. */
  async jobs(page, theme) {
    await page.goto(`${BASE}?route=/jobs&hosts=two`, { timeout: 180_000 });
    await stageChats(page, { theme, collapsed: true });
    await page.waitForTimeout(800);
    await clean(page);
  },

  /** A Pad beside the chat that owns it. */
  async pad(page, theme) {
    await page.goto(`${BASE}?chat=d_pad&hosts=two`, { timeout: 180_000 });
    await stageChats(page, {
      theme,
      openChat: 'd_pad',
      collapsed: true,
      timelines: { d_pad: padTimeline },
    });
    await page.evaluate(async () => {
      const { openPadBesideChat } = await import('/app/src/lib/openPad.ts');
      openPadBesideChat('p_checkout', 'd_pad');
    });
    await page.waitForTimeout(3000);
    await clean(page);
  },

  /** Two chats side by side, tabs in each, the status list under the header. */
  async panes(page, theme) {
    await page.route(api('/api/chats/*/artifact/**'), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'text/html',
        body: reportFor(r.request().url()),
      }),
    );
    await page.goto(`${BASE}?chat=d_checkout&hosts=two`, { timeout: 180_000 });
    await stageChats(page, {
      theme,
      openChat: 'd_checkout',
      collapsed: true,
      timelines: {
        d_checkout: [
          ...checkoutTimeline,
          artifact(12, 'd_checkout', 'flaky-report', 'Flaky test report'),
        ],
        d_rate: [...providerTimeline, artifact(12, 'd_rate', 'load-test', 'Load test results')],
      },
      models: { d_rate: 'openai/gpt-5.5-codex' },
      extra: {
        d_checkout: {
          goal: 'The checkout test passes 50 runs in a row',
          goalProgress: {
            startedAt: Date.now() - 14 * 60_000,
            turnsEvaluated: 3,
            tokensSpent: 410_000,
            lastVerdict: 'met',
            lastReason: '50 consecutive passing runs',
          },
        },
      },
    });
    await page.evaluate(async () => {
      const { useLayoutStore } = await import('/app/src/stores/layoutStore.ts');
      useLayoutStore.getState().showChat('d_rate', { newGroup: true });
      useLayoutStore.getState().openTab(
        {
          kind: 'page',
          page: 'artifact',
          chatId: 'd_rate',
          artifactId: 'load-test',
          url: '/api/chats/d_rate/artifact/load-test',
        },
        { placement: 'tab' },
      );
    });
    await page.waitForTimeout(1200);
    await clean(page);
  },

  /** Everything a chat has going on, under its header: nothing hidden. */
  async status(page, theme) {
    const now = Date.now();
    await page.route(api('/api/chats/d_index/watch'), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tasks: [
            {
              taskId: 't1',
              description: 'Reindex products',
              command: 'pnpm reindex --all',
              outputFile: '/tmp/reindex.log',
              status: 'running',
              startedAt: now - 7 * MIN,
              lastLine: '41,200 of 96,000 products',
              checkInSec: 600,
              nextCheckInAt: now + 6 * MIN,
              lastOutputAt: now - 2000,
            },
          ],
        }),
      }),
    );
    await page.route(api('/api/chats/*/artifact/**'), (r) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: reportFor(r.request().url()) }),
    );
    await page.goto(`${BASE}?chat=d_index&hosts=two`, { timeout: 180_000 });
    await stageChats(page, {
      theme,
      openChat: 'd_index',
      collapsed: true,
      timelines: { d_index: statusTimeline },
      extra: {
        d_index: {
          activity: 'running',
          backgroundTasks: 1,
          goal: 'Search returns every product, and the nightly rebuild passes',
          goalProgress: {
            startedAt: now - 38 * MIN,
            turnsEvaluated: 4,
            tokensSpent: 1_900_000,
            lastVerdict: 'not_met',
            lastReason: 'The rebuild is still running',
          },
          todos: [
            { text: 'Find why products go missing', status: 'completed' },
            { text: 'Rebuild the index', status: 'in_progress' },
            { text: 'Schedule it nightly', status: 'pending' },
            { text: 'Add a test for the gap', status: 'pending' },
          ],
          pendingWake: { message: 'check the reindex has finished', fireAt: now + 12 * MIN },
        },
      },
    });
    await page.evaluate(async () => {
      const { useChatStore } = await import('/app/src/stores/chatStore.ts');
      useChatStore.setState((s) => ({
        delegateUpdates: {
          ...s.delegateUpdates,
          d_index: {
            a1: {
              label: 'Audit the search filters',
              status: 'running',
              since: Date.now() - 4 * 60_000,
            },
            a2: { label: 'Check the product feed', status: 'running', since: Date.now() - 90_000 },
          },
        },
      }));
    });
    await page.waitForTimeout(1200);
    await clean(page);
  },

  /** The queued message under the working dots (cropped below). */
  async queued(page, theme) {
    await SHOTS.status(page, theme);
  },

  /** A published page open in a tab (the right-hand group, cropped below). */
  async artifact(page, theme) {
    await SHOTS.panes(page, theme);
  },

  /** Settings → Prompts: every prompt Patch sends, editable. */
  async prompts(page, theme) {
    await page.goto(`${BASE}?route=/settings/prompts&hosts=two`, { timeout: 180_000 });
    await stageChats(page, { theme, collapsed: true });
    await page.waitForTimeout(800);
    await clean(page);
    // From the link summary on: short prompts, several to a screen.
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('body *')].find(
        (e) => e.children.length === 0 && e.textContent.trim() === 'Link summary',
      );
      el.scrollIntoView({ block: 'start' });
      let s = el.parentElement;
      while (s && s.scrollHeight <= s.clientHeight) s = s.parentElement;
      if (s) s.scrollTop -= 40;
    });
    await page.waitForTimeout(300);
  },

  /** A side thread off one message, beside the chat. */
  async threads(page, theme) {
    await page.goto(`${BASE}?chat=d_checkout&hosts=two`, { timeout: 180_000 });
    await stageChats(page, {
      theme,
      openChat: 'd_checkout',
      collapsed: true,
      timelines: { d_checkout: checkoutTimeline },
    });
    await clean(page);
    const msg = page.locator('.msg-assistant').first();
    await msg.click({ button: 'right' });
    await page.getByText('Open side thread').click();
    await page.waitForTimeout(300);
    await page.keyboard.type('Would retrying the click have hidden a real bug?');
    await page.waitForTimeout(300);
  },
};

const VIEW = {
  queued: { w: 1000, h: 860, crop: 'queued' },
  artifact: { w: 1280, h: 820, crop: 'artifact' },
  status: { w: 1000, h: 860 },
  prompts: { w: 1100, h: 760 },
  threads: { w: 1200, h: 760 },
  providers: { w: 780, h: 720 },
  models: { w: 780, h: 720 },
  move: { w: 1040, h: 740 },
  // The accounts card itself, with its heading: the page around it is empty here.
  accounts: { w: 1280, h: 980, region: ['[data-testid="accounts-claude-code"]', 'CLAUDE'] },
  machines: { w: 1040, h: 740 },
  jobs: { w: 980, h: 700 },
  pad: { w: 1200, h: 760 },
  panes: { w: 1040, h: 760 },
};

// Phone variants: either the same shot in a phone-width window (the app lays
// itself out for it), or one region of the desktop shot.
const PHONE = {
  status: { view: { w: 430, h: 860 } },
  providers: { view: { w: 430, h: 820 } },
  accounts: { view: { w: 430, h: 860 } },
  jobs: { view: { w: 430, h: 900 }, below: '.job-row' },
  machines: { clip: '.sb', height: 720 },
  pad: { clip: '[data-testid="pad-pane"]' },
  panes: { clip: '.group-card' },
};

async function regionOf(page, selector, height) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`nothing matches ${selector}`);
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: Math.min(box.height, height ?? box.height),
  };
}

// ------------------------------------------------------------------ videos
//
// `capture.mjs <out-dir> --videos [name…]` records short scripted clips of the
// harness through the DevTools screencast (crisper than Playwright's own
// recorder), then encodes each as <name>-<theme>.webm/.mp4 plus a poster.

/** A drawn pointer, since a screencast shows none. Moves are eased. */
async function cursor(page) {
  await page.evaluate(() => {
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 9-6.6 1.6L9 20z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transform: 'translate(-100px, -100px)',
      filter: 'drop-shadow(0 1px 2px rgb(0 0 0 / 30%))',
    });
    document.body.appendChild(c);
    // Hover tooltips linger in a recording; the clips go without them.
    const style = document.createElement('style');
    style.textContent = '[role="tooltip"], .tooltip, .tooltip-host { display: none !important; }';
    document.head.appendChild(style);
  });
  page.pointer = { x: 600, y: 400 };
}

async function moveTo(page, x, y, ms = 650) {
  const from = page.pointer ?? { x, y };
  const steps = Math.max(6, Math.round(ms / 45));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const px = from.x + (x - from.x) * e;
    const py = from.y + (y - from.y) * e;
    await page.mouse.move(px, py);
    await page.evaluate(
      ([px, py]) => {
        const c = document.getElementById('demo-cursor');
        if (c) c.style.transform = `translate(${px - 4}px, ${py - 2}px)`;
      },
      [px, py],
    );
  }
  page.pointer = { x, y };
}

async function centre(page, locator) {
  const box = await locator.first().boundingBox();
  if (!box) throw new Error(`not on screen: ${locator}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function clickOn(page, locator, opts = {}) {
  const { x, y } = await centre(page, locator);
  await moveTo(page, x + (opts.dx ?? 0), y + (opts.dy ?? 0), opts.ms);
  await page.waitForTimeout(120);
  await page.mouse.click(x + (opts.dx ?? 0), y + (opts.dy ?? 0), {
    button: opts.button ?? 'left',
    clickCount: opts.clickCount ?? 1,
  });
}

/** Replace a chat's transcript, or add to it. */
async function setTimeline(page, chatId, entries) {
  await page.evaluate(
    async ({ chatId, entries }) => {
      const { useChatStore } = await import('/app/src/stores/chatStore.ts');
      useChatStore.setState((s) => ({ timelines: { ...s.timelines, [chatId]: entries } }));
    },
    { chatId, entries },
  );
}

async function setRow(page, chatId, patch) {
  await page.evaluate(
    async ({ chatId, patch }) => {
      const { useChatStore } = await import('/app/src/stores/chatStore.ts');
      useChatStore.setState((s) => ({
        chats: { ...s.chats, [chatId]: { ...s.chats[chatId], ...patch } },
      }));
    },
    { chatId, patch },
  );
}

/** Type an assistant reply out a few words at a time, as a stream would. */
async function streamReply(page, chatId, before, seq, text) {
  const words = text.split(' ');
  for (let i = 3; i <= words.length + 2; i += 3) {
    await setTimeline(page, chatId, [
      ...before,
      msg(seq, 'assistant', words.slice(0, Math.min(i, words.length)).join(' ')),
    ]);
    await page.waitForTimeout(90);
  }
}

const VIDEOS = {
  /** Claude to Codex mid-conversation, and Codex carries on. */
  async switch(page, theme) {
    const start = providerTimeline.slice(0, 6);
    await page.goto(`${BASE}?chat=d_rate&hosts=two`, { timeout: 180_000 });
    await stageChats(page, {
      theme,
      openChat: 'd_rate',
      collapsed: true,
      timelines: { d_rate: start },
    });
    await clean(page);
    await cursor(page);
    await moveTo(page, 640, 120, 10);
    return async () => {
      await page.waitForTimeout(300);
      await clickOn(page, page.getByTestId('chat-model'));
      await page.waitForTimeout(700);
      await clickOn(page, page.getByTestId('model-option-openai/gpt-5.5-codex'));
      await setRow(page, 'd_rate', { model: 'openai/gpt-5.5-codex' });
      await page.waitForTimeout(400);
      await clickOn(page, page.getByTestId('composer-input'));
      await page.keyboard.type('Review it and write the load test.', { delay: 28 });
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        const t = document.querySelector('[data-testid="composer-input"]');
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        set.call(t, '');
        t.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const asked = [
        ...start,
        msg(7, 'user', 'Review it and write the load test.'),
        { seq: 8, kind: 'handoff', content: 'Handed off to GPT-5.5 Codex', at: at(8) },
      ];
      await setRow(page, 'd_rate', { activity: 'running' });
      await setTimeline(page, 'd_rate', asked);
      await page.waitForTimeout(900);
      const withTool = [
        ...asked,
        ...tool(
          9,
          'r9',
          'Bash',
          { command: 'k6 run load/limit.js', description: 'Load test the limiter' },
          { code: 0 },
        ),
      ];
      await setTimeline(page, 'd_rate', withTool);
      await page.waitForTimeout(900);
      await streamReply(
        page,
        'd_rate',
        withTool,
        11,
        'Reviewed. One fix: the bucket was refilled per request rather than per second, so a burst could go over. At 300 requests a minute, 100 succeed and the rest get `429`.',
      );
      await setRow(page, 'd_rate', { activity: 'idle' });
      await page.waitForTimeout(1600);
    };
  },

  /** Edit a Pad, send it, and the agent acts on it. */
  async pad(page, theme) {
    page.padLive = { rev: 1, changes: [], batches: [] };
    const start = padTimeline;
    await page.goto(`${BASE}?chat=d_pad&hosts=two`, { timeout: 180_000 });
    await stageChats(page, {
      theme,
      openChat: 'd_pad',
      collapsed: true,
      timelines: { d_pad: start },
    });
    await page.evaluate(async () => {
      const { openPadBesideChat } = await import('/app/src/lib/openPad.ts');
      openPadBesideChat('p_checkout', 'd_pad');
    });
    await page.waitForTimeout(3000);
    await clean(page);
    await cursor(page);
    await moveTo(page, 700, 400, 10);
    const editor = page.frameLocator('[data-testid="pad-frame"]');
    const design = editor.frameLocator('#frame');
    return async () => {
      await page.waitForTimeout(600);
      // Retype the button.
      await clickOn(page, design.locator('#pay'), { clickCount: 2 });
      await page.waitForTimeout(250);
      await page.keyboard.press('Meta+A');
      for (const ch of 'Pay now · £48.00') {
        await page.keyboard.insertText(ch);
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(300);
      await clickOn(page, design.locator('h1'));
      await page.waitForTimeout(500);
      // A note on the summary.
      await clickOn(page, editor.locator('[data-tool="text"]'));
      await page.waitForTimeout(250);
      await clickOn(page, design.locator('.summary .total'), { dx: -40, dy: -70 });
      await page.waitForTimeout(250);
      for (const ch of 'Make the total bigger') {
        await page.keyboard.insertText(ch);
        await page.waitForTimeout(35);
      }
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);
      await clickOn(page, editor.locator('#panelBtn'));
      await page.waitForTimeout(700);
      await clickOn(page, editor.locator('#send'));
      await page.waitForTimeout(700);
      await clickOn(page, editor.locator('#panelClose'));
      await page.waitForTimeout(300);
      const sent = [
        ...start,
        msg(
          5,
          'user',
          'Pad: 2 changes on Payment\n\n1. Button "Pay £48.00" → "Pay now · £48.00"\n2. Note on Order summary: Make the total bigger',
        ),
      ];
      await setRow(page, 'd_pad', { activity: 'running' });
      await setTimeline(page, 'd_pad', sent);
      await page.waitForTimeout(900);
      const edited = [
        ...sent,
        ...tool(6, 'p6', 'Edit', { file_path: 'design/checkout/payment.html' }, { ok: true }),
      ];
      await setTimeline(page, 'd_pad', edited);
      await page.waitForTimeout(500);
      page.padLive.rev = 2;
      page.padLive.changes.forEach((c) => (c.status = 'done'));
      page.padLive.batches.forEach((b) =>
        Object.assign(b, { status: 'done', reply: 'Done', repliedAt: Date.now() }),
      );
      await streamReply(
        page,
        'd_pad',
        edited,
        8,
        'Done: the new button label, and the total is now larger than the lines above it.',
      );
      await setRow(page, 'd_pad', { activity: 'idle' });
      await page.waitForTimeout(2200);
    };
  },

  /** A gated job holding, then a job run starting a chat. */
  async jobs(page, theme) {
    await page.route(api('/api/jobs/*/run'), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
    );
    await page.goto(`${BASE}?route=/jobs&hosts=two`, { timeout: 180_000 });
    await stageChats(page, { theme });
    await page.waitForTimeout(800);
    await clean(page);
    await cursor(page);
    await moveTo(page, 800, 300, 10);
    return async () => {
      await page.waitForTimeout(500);
      await clickOn(page, page.getByTestId('job-runs-toggle-j_photos'));
      await page.waitForTimeout(1400);
      await clickOn(page, page.getByTestId('job-runs-toggle-j_photos'));
      await page.waitForTimeout(900);
      await clickOn(page, page.getByTestId('job-run-now-j_triage'));
      await page.waitForTimeout(300);
      await page.evaluate(async () => {
        const { useChatStore } = await import('/app/src/stores/chatStore.ts');
        const st = useChatStore.getState();
        const base = st.chats['d_rate'];
        st.hydrate([
          ...Object.values(st.chats),
          {
            ...base,
            chatId: 'd_triage',
            name: 'Checkout fails on Safari 18',
            activity: 'running',
            lastUpdated: Date.now(),
          },
        ]);
      });
      await setTimeline(page, 'd_triage', [
        {
          seq: 1,
          kind: 'message',
          role: 'user',
          content:
            'Triage this issue.\n\nTrigger event: issue #482 opened — "Checkout fails on Safari 18"',
          jobTrigger: true,
          at: Date.now(),
        },
      ]);
      await page.waitForTimeout(1000);
      await clickOn(page, page.getByTestId('chat-row-d_triage'));
      await page.waitForTimeout(800);
      const base =
        (await page.evaluate(async () => {
          const { useChatStore } = await import('/app/src/stores/chatStore.ts');
          return useChatStore.getState().timelines['d_triage'];
        })) ?? [];
      const withTool = [
        ...base,
        ...tool(2, 't2', 'Grep', { pattern: 'requestPayment' }, { files: ['src/checkout/pay.ts'] }),
      ];
      await setTimeline(page, 'd_triage', withTool);
      await page.waitForTimeout(700);
      await streamReply(
        page,
        'd_triage',
        withTool,
        4,
        'Reproduced on Safari 18: the payment sheet opens before the card frame has loaded. Labelled it `bug` and `checkout`, and linked the flaky checkout test fixed yesterday.',
      );
      await page.waitForTimeout(1600);
    };
  },

  /** A busy chat's status list, then a second chat and a tab beside it. */
  async panes(page, theme) {
    await SHOTS.status(page, theme);
    await setRow(page, 'd_rate', { activity: 'idle' });
    await setTimeline(page, 'd_rate', providerTimeline);
    await page.evaluate(async () => {
      const { useUiStore } = await import('/app/src/stores/uiStore.ts');
      useUiStore.getState().setSidebarCollapsed(false);
    });
    await page.waitForTimeout(400);
    await clean(page);
    await cursor(page);
    await moveTo(page, 700, 300, 10);
    return async () => {
      await page.waitForTimeout(900);
      await clickOn(page, page.getByTestId('chat-row-d_rate'), { button: 'middle' });
      await page.waitForTimeout(900);
      await page.evaluate(async () => {
        const { useUiStore } = await import('/app/src/stores/uiStore.ts');
        useUiStore.getState().setSidebarCollapsed(true);
      });
      await page.waitForTimeout(150);
      await clean(page);
      await page.waitForTimeout(550);
      await clickOn(
        page,
        page.locator('[data-testid="artifact-bar"] a, [data-testid="artifact-bar"] button').first(),
      );
      await page.waitForTimeout(1300);
      await clickOn(page, page.locator('.pane-tab').first());
      await page.waitForTimeout(900);
      await clickOn(page, page.locator('[data-testid="delegate-strip-toggle"]').first());
      await page.waitForTimeout(1800);
    };
  },
};

// `phoneCrop` (ffmpeg crop=w:h:x:y, in recorded pixels) cuts the phone version
// to the part that matters; without one the phone version is the whole frame,
// smaller.
const VIDEO_VIEW = {
  switch: { w: 900, h: 640 },
  pad: { w: 1200, h: 800, phoneCrop: '800:1066:800:0' },
  jobs: { w: 1360, h: 760 },
  panes: { w: 1200, h: 760 },
};

async function record(b, name, theme) {
  const { w, h } = VIDEO_VIEW[name];
  const page = await b.newPage({
    viewport: { width: w, height: h },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  page.on('pageerror', (e) => console.error(`${name}/${theme}:`, e.message));
  await stubServer(page);
  const play = await VIDEOS[name](page, theme);
  const frames = [];
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ data: f.data, ts: f.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 92,
    maxWidth: w * 2,
    maxHeight: h * 2,
  });
  await page.waitForTimeout(300);
  await play();
  const end = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  await page.close();
  const dir = path.join(outDir, `${name}-${theme}-frames`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const list = [];
  frames.forEach((f, i) => {
    const file = path.join(dir, `${String(i).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(f.data, 'base64'));
    const next = frames[i + 1]?.ts ?? end;
    list.push(`file '${file}'`, `duration ${Math.max(0.001, next - f.ts).toFixed(3)}`);
  });
  list.push(`file '${path.join(dir, `${String(frames.length - 1).padStart(5, '0')}.jpg`)}'`);
  writeFileSync(path.join(dir, 'list.txt'), list.join('\n'));
  const width = Math.min(1600, w * 2);
  const vf = `fps=30,scale=${width}:-2:flags=lanczos`;
  const base = path.join(outDir, `${name}-${theme}`);
  const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
  const input = ['-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt')];
  ff([
    ...input,
    '-vf',
    vf,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '27',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    `${base}.mp4`,
  ]);
  ff([
    ...input,
    '-vf',
    vf,
    '-c:v',
    'libvpx-vp9',
    '-crf',
    '38',
    '-b:v',
    '0',
    '-row-mt',
    '1',
    '-an',
    `${base}.webm`,
  ]);
  // The poster is the last frame: the finished state reads best standing still.
  ff(['-sseof', '-0.1', '-i', `${base}.mp4`, '-frames:v', '1', '-q:v', '3', `${base}-poster.jpg`]);
  // A phone-width version, from the desktop one.
  const crop = VIDEO_VIEW[name].phoneCrop;
  const pvf = `${crop ? `crop=${crop},` : ''}scale=860:-2:flags=lanczos`;
  const src = ['-i', `${base}.mp4`];
  ff([
    ...src,
    '-vf',
    pvf,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '27',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    `${base}-phone.mp4`,
  ]);
  ff([
    ...src,
    '-vf',
    pvf,
    '-c:v',
    'libvpx-vp9',
    '-crf',
    '38',
    '-b:v',
    '0',
    '-row-mt',
    '1',
    '-an',
    `${base}-phone.webm`,
  ]);
  ff([
    '-sseof',
    '-0.1',
    '-i',
    `${base}-phone.mp4`,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    `${base}-phone-poster.jpg`,
  ]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`${name}/${theme}: ${frames.length} frames`);
}

const b = await chromium.launch();
if (only[0] === '--videos') {
  const names = only.slice(1).length ? only.slice(1) : Object.keys(VIDEOS);
  const themes = (process.env.THEMES ?? 'light,dark').split(',');
  for (const name of names) for (const theme of themes) await record(b, name, theme);
  await b.close();
  console.log('recorded →', outDir);
  process.exit(0);
}
for (const [name, shoot] of Object.entries(SHOTS)) {
  if (only.length && !only.includes(name)) continue;
  for (const theme of ['light', 'dark']) {
    const variants = [{ suffix: '', view: VIEW[name] }];
    const phone = PHONE[name];
    if (phone?.view) variants.push({ suffix: '-phone', view: phone.view });
    for (const v of variants) {
      const page = await b.newPage({
        viewport: { width: v.view.w, height: v.view.h },
        deviceScaleFactor: 2,
        colorScheme: theme,
      });
      page.on('pageerror', (e) => console.error(`${name}/${theme}:`, e.message));
      await stubServer(page);
      await shoot(page, theme);
      if (v.suffix === '-phone' && phone.below) {
        // The rows alone, from just above the first one down.
        const rows = page.locator(phone.below);
        const top = (await rows.first().boundingBox()).y - 2;
        const last = await rows.nth(3).boundingBox();
        await page.screenshot({
          path: path.join(outDir, `${name}${v.suffix}-${theme}.png`),
          clip: { x: 0, y: top, width: v.view.w, height: last.y + last.height + 14 - top },
        });
      } else if (v.view.crop === 'queued') {
        const q = await page.locator('[data-queued="true"]').first().boundingBox();
        const top = q.y - 50;
        await page.screenshot({
          path: path.join(outDir, `${name}-${theme}.png`),
          clip: { x: 100, y: top, width: v.view.w - 200, height: q.y + q.height + 44 - top },
        });
      } else if (v.view.crop === 'artifact') {
        await page.screenshot({
          path: path.join(outDir, `${name}-${theme}.png`),
          clip: await regionOf(page, '.group-card >> nth=1', 372),
        });
      } else if (v.suffix === '' && v.view.region) {
        const [selector, heading] = v.view.region;
        const box = await page.locator(selector).first().boundingBox();
        const top = await page.evaluate((text) => {
          const el = [...document.querySelectorAll('body *')].find(
            (e) => e.children.length === 0 && e.textContent.trim().toUpperCase() === text,
          );
          return el.getBoundingClientRect().top;
        }, heading);
        const pad = 28;
        await page.screenshot({
          path: path.join(outDir, `${name}-${theme}.png`),
          clip: {
            x: box.x - pad,
            y: top - pad,
            width: box.width + 2 * pad,
            height: box.y + box.height + 6 - (top - pad),
          },
        });
      } else {
        await page.screenshot({ path: path.join(outDir, `${name}${v.suffix}-${theme}.png`) });
      }
      if (v.suffix === '' && phone?.clip) {
        await page.screenshot({
          path: path.join(outDir, `${name}-phone-${theme}.png`),
          clip: await regionOf(page, phone.clip, phone.height),
        });
      }
      await page.close();
    }
  }
}
await b.close();
console.log('captured →', outDir);
