import { test, expect } from '@playwright/test';

// spec/05 § Window chrome: a chat opened in its own window boots with the
// sidebar hidden (`?sidebar=hidden`) and the macOS window controls floating
// over its top-left. It reads the opener's saved layout, so it can carry a tab
// bar above the chat header. Nothing in the top row may sit under the controls.
const HARNESS = '/app/dev-harness.html?chat=thread_manager&sidebar=hidden';
const LIGHTS_RIGHT_EDGE = 70;
const LIGHTS_BOTTOM = 43;

const LAYOUT = {
  root: {
    type: 'leaf',
    id: 'p1',
    activeTabId: 't1',
    tabs: [
      { id: 't1', descriptor: { kind: 'chat', chatId: 'thread_manager' } },
      { id: 't2', descriptor: { kind: 'page', page: 'settings' } },
    ],
  },
  activePaneId: 'p1',
};

async function openAsNewWindow(page: import('@playwright/test').Page, withTabBar: boolean) {
  await page.addInitScript(
    ([layout, tabbed]) => {
      (window as unknown as { patch: unknown }).patch = { overlayTitleBar: true };
      if (tabbed) localStorage.setItem('patch.layout.v1', JSON.stringify(layout));
    },
    [LAYOUT, withTabBar] as const,
  );
  await page.goto(HARNESS);
  await expect(page.getByTestId('chat-head')).toBeVisible();
}

async function underControls(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(
    ([edge, bottom]) => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.left < edge && r.top < bottom) {
          const painted =
            el.matches('button, input, a, svg, [role=button], [role=tab]') ||
            Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent?.trim());
          if (painted) out.push(`${el.tagName}.${el.className}`);
        }
      }
      return out;
    },
    [LIGHTS_RIGHT_EDGE, LIGHTS_BOTTOM] as const,
  );
}

test.describe('a chat opened in a new window', () => {
  test('keeps the chat header clear of the window controls', async ({ page }) => {
    await openAsNewWindow(page, false);
    expect(await underControls(page)).toEqual([]);
  });

  test('keeps a tab bar inherited from the opener clear of the window controls', async ({
    page,
  }) => {
    await openAsNewWindow(page, true);
    await expect(page.locator('.pane-tab-bar')).toBeVisible();
    expect(await underControls(page)).toEqual([]);
    // The group header is the top row; the tab row sits below the controls.
    const tab = (await page.locator('.pane-tab').first().boundingBox())!;
    expect(tab.y).toBeGreaterThanOrEqual(LIGHTS_BOTTOM);
  });
});
