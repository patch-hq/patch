import { test, expect } from '@playwright/test';

// MCP Apps (SEP-1865) — a tool whose server declares a UI template is drawn as
// that template in a sandboxed frame under its tool row. The template here is a
// real page speaking the real protocol: it initialises, shows the tool result it
// is sent, calls a tool, and posts a message to the chat.
const CHAT = '/app/dev-harness.html?chat=chat_mcp_app';

const TEMPLATE = `<!doctype html><html><body style="margin:0;font:14px sans-serif">
<div id="out">waiting</div><button id="call">refresh</button><button id="say">say</button>
<script>
let n = 10;
const send = (m) => parent.postMessage({ jsonrpc: '2.0', ...m }, '*');
const out = document.getElementById('out');
addEventListener('message', (e) => {
  const m = e.data;
  if (m.id === 1) { send({ method: 'ui/notifications/initialized' }); return; }
  if (m.method === 'ui/notifications/tool-result') out.textContent = 'result: ' + m.params.content[0].text;
  if (m.id === 2) out.textContent = 'called: ' + (m.result ? m.result.content[0].text : m.error.message);
});
send({ id: 1, method: 'ui/initialize', params: {} });
document.getElementById('call').onclick = () => send({ id: 2, method: 'tools/call', params: { name: 'refresh', arguments: { by: 5 } } });
document.getElementById('say').onclick = () => send({ id: 3, method: 'ui/message', params: { role: 'user', content: { type: 'text', text: 'hello from the app' } } });
setTimeout(() => send({ method: 'ui/notifications/size-changed', params: { height: 120 } }), 50);
</script></body></html>`;

test.describe('MCP Apps', () => {
  test('runs the template in an opaque-origin frame, calls tools, posts to the chat', async ({
    page,
  }) => {
    const calls: Record<string, unknown>[] = [];
    await page.route('**/api/hosts/d1/mcp-app', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      calls.push(body);
      if (body.op === 'resource') {
        await route.fulfill({
          json: { hasUi: true, html: TEMPLATE, uiMeta: { prefersBorder: true } },
        });
      } else {
        await route.fulfill({
          json: { result: { content: [{ type: 'text', text: 'refreshed 5' }] } },
        });
      }
    });
    await page.goto(CHAT);

    const frameEl = page.getByTestId('mcp-app-frame');
    await expect(frameEl).toBeVisible();
    await expect(frameEl).toHaveAttribute('sandbox', 'allow-scripts');
    expect(calls[0]).toMatchObject({
      chatId: 'chat_mcp_app',
      op: 'resource',
      server: 'dash',
      tool: 'show',
    });

    const app = page.frameLocator('[data-testid="mcp-app-frame"]');
    // The tool result reached the template through the protocol.
    await expect(app.locator('#out')).toHaveText('result: Bristol: 11C');
    // The frame's own size request was honoured.
    await expect.poll(async () => (await frameEl.boundingBox())?.height).toBe(120);

    // The frame cannot read the SPA: its origin is opaque.
    const origin = await app.locator('body').evaluate(() => window.origin);
    expect(origin).toBe('null');

    // A button calls a tool on the same server, through the host.
    await app.locator('#call').click();
    await expect(app.locator('#out')).toHaveText('called: refreshed 5');
    expect(calls[1]).toMatchObject({
      op: 'call',
      server: 'dash',
      tool: 'refresh',
      arguments: { by: 5 },
    });
  });

  test('a tool with no UI draws nothing extra', async ({ page }) => {
    await page.route('**/api/hosts/d1/mcp-app', (route) =>
      route.fulfill({ json: { hasUi: false } }),
    );
    await page.goto(CHAT);
    await expect(page.getByTestId('tool-call').first()).toBeVisible();
    await expect(page.getByTestId('mcp-app')).toHaveCount(0);
  });

  test('a template that cannot load says so', async ({ page }) => {
    await page.route('**/api/hosts/d1/mcp-app', (route) =>
      route.fulfill({
        status: 502,
        json: { error: 'bad_resource', message: 'ui://x is text/html' },
      }),
    );
    await page.goto(CHAT);
    await expect(page.getByTestId('mcp-app-error')).toContainText('bad_resource');
  });
});
