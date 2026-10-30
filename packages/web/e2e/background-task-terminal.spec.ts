import { test, expect } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// spec/14 § Main chat panel — Background task bar: clicking a running task
// opens the terminal, as a tab, on that task's live output.
//
// `?ws=fake` is what makes this reachable in the harness: a terminal session
// only reaches `live` once the host answers `patch.terminal.open` with a
// `patch.terminal.ready`, and until it is live nothing can be run in it. The
// fake socket answers that one frame and records everything on `__wsSent`,
// which is how the outbound command is asserted here rather than by mocking
// the module.
const BG = '/app/dev-harness.html?chat=chat_bgtask&ws=fake';

// The bar's rows come from the host's own record of each task
// (`GET /api/chats/:id/watch`), which names the output file exactly — nothing
// is globbed or guessed. Stubbed here, as in background-task-bar.spec.ts.
const NOW = Date.now();
const TASKS = [
  {
    taskId: 'diag-25045',
    description: 'Diagnose 25045 test failures',
    command: 'pnpm --filter @patch/web test -- --grep 25045',
    outputFile: '/data/chats/chat_bgtask/watch/diag-25045.output',
    status: 'running' as const,
    startedAt: NOW - 5_000,
  },
  {
    taskId: 'baiw888mq',
    description: 'Build web package to compile CSS',
    command: 'pnpm --filter @patch/web build',
    outputFile: '/data/chats/chat_bgtask/watch/baiw888mq.output',
    status: 'running' as const,
    startedAt: NOW - 65_000,
  },
];

test.beforeEach(async ({ page }) => {
  await page.route('**/api/chats/chat_bgtask/watch', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: TASKS }),
    });
  });
});

/** Every frame the page has sent, in order. */
async function sent(page: import('@playwright/test').Page): Promise<WireEvent[]> {
  return page.evaluate(() => (window as unknown as { __wsSent: WireEvent[] }).__wsSent);
}

async function inputs(page: import('@playwright/test').Page): Promise<string[]> {
  const frames = await sent(page);
  return frames
    .filter((e): e is Extract<WireEvent, { type: 'patch.terminal.input' }> =>
      Boolean(e && e.type === 'patch.terminal.input'),
    )
    .map((e) => e.data);
}

test.describe('background task → terminal', () => {
  test('clicking a task opens the terminal tab and tails that task output', async ({ page }) => {
    await page.goto(BG);
    // Newest first: the sub-agent, then the build. The build is the one whose
    // launch has already reported a background id.
    const rows = page.getByTestId('background-task-bar-task');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText('Build web package to compile CSS');
    // The transcript is what is on screen before the click.
    await expect(page.getByTestId('chat-stream')).toBeVisible();

    await rows.nth(1).click();

    // The terminal opens in a pane along the bottom of the group, with the
    // chat still above it (spec/14 § Opening things).
    await expect(page.getByTestId('terminal-pane')).toBeVisible();
    await expect(page.getByTestId('chat-stream')).toBeVisible();

    // The command really went to the shell, with this task's id in it.
    await expect.poll(async () => (await inputs(page)).length).toBe(1);
    const line = (await inputs(page))[0]!;
    expect(line).toContain('/data/chats/chat_bgtask/watch/baiw888mq.output');
    expect(line).toContain('tail -n 200 -f');
    expect(line.endsWith('\n')).toBe(true);

    // And it reads like a typed command: echoed into the scrollback.
    await expect(page.getByTestId('terminal-scroll')).toContainText('❯ tail -n 200 -f');
    await expect(page.getByTestId('terminal-scroll')).toContainText('baiw888mq.output');

    // The shell is on the chat's own host, rooted in the chat's folder.
    const open = (await sent(page)).find((e) => e.type === 'patch.terminal.open');
    expect(open).toMatchObject({ hostId: 'd1', folder: '/home/tom/projects/patch' });
  });

  test('the row is reachable and openable from the keyboard', async ({ page }) => {
    await page.goto(BG);
    const row = page.getByTestId('background-task-bar-task').nth(1);
    await expect(row).toHaveAttribute(
      'aria-label',
      'Show what "Build web package to compile CSS" is doing in the terminal',
    );
    await row.focus();
    await expect(row).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('terminal-pane')).toBeVisible();
    await expect.poll(async () => (await inputs(page)).length).toBe(1);
  });

  test('each task opens the terminal on its own output file', async ({ page }) => {
    await page.goto(BG);
    // The sub-agent is the newest row.
    const row = page.getByTestId('background-task-bar-task').nth(0);
    await expect(row).toContainText('Diagnose 25045 test failures');
    await row.click();

    await expect(page.getByTestId('terminal-pane')).toBeVisible();
    await expect.poll(async () => (await inputs(page)).length).toBe(1);
    expect((await inputs(page))[0]).toContain('/data/chats/chat_bgtask/watch/diag-25045.output');
  });

  test('the collapse chevron folds the stack without opening a terminal', async ({ page }) => {
    await page.goto(BG);
    await page.getByTestId('background-task-bar-toggle').click();
    await expect(page.getByTestId('background-task-bar')).toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('terminal-pane')).toHaveCount(0);
    await expect(page.getByTestId('chat-stream')).toBeVisible();
    expect(await inputs(page)).toEqual([]);
    // The folded summary names no single task, so it opens nothing either.
    await page.getByTestId('background-task-bar-count').click();
    await expect(page.getByTestId('terminal-pane')).toHaveCount(0);
  });
});
