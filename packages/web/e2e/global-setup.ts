// Warm the Vite dev server before any spec runs.
//
// The dev server compiles each module the first time a page asks for it. On a
// fresh checkout (every CI run) that meant the FIRST page load in each worker
// paid for compiling the whole app — and with every worker asking at once on a
// loaded runner, a page that renders in a second took more than the 15 s an
// assertion waits, failing whichever test happened to go first. Loading the
// harness here once, on the routes the specs use most (each lazy route is its
// own module graph — the job editor pulls in Monaco), means no test pays for
// a cold compile.
import { chromium, type FullConfig } from '@playwright/test';

const ROUTES = [
  '/app/dev-harness.html?chat=chat_bus',
  '/app/dev-harness.html?chat=new',
  '/app/dev-harness.html?route=/jobs',
  '/app/dev-harness.html?route=/jobs/new',
  '/app/dev-harness.html?route=/settings/voice',
];

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('global-setup: no baseURL in the Playwright config');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL });
    for (const route of ROUTES) {
      // `networkidle`: every module the route imports has been requested and
      // served, so the dev server has compiled it.
      await page.goto(route, { waitUntil: 'networkidle', timeout: 180_000 });
    }
  } finally {
    await browser.close();
  }
}
