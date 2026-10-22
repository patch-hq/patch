import { test, expect, type Page } from '@playwright/test';

// Todoist: "a long new message does not pull the page right to the bottom".
// Pinned to the bottom, a new message far taller than the viewport arrives:
// the view must end at its very bottom, not part-way down it.

const CHAT = 'chat_scroll';

type HarnessWindow = {
  __store: { setState: (fn: (s: unknown) => unknown) => void };
};

async function appendMessage(
  page: Page,
  seq: number,
  content: string,
  role: 'assistant' | 'user' = 'assistant',
): Promise<void> {
  await page.evaluate(
    ([chatId, n, text, who]) => {
      const w = window as unknown as HarnessWindow;
      w.__store.setState((s) => {
        const st = s as { timelines: Record<string, unknown[]> };
        return {
          timelines: {
            ...st.timelines,
            [chatId as string]: [
              ...st.timelines[chatId as string]!,
              {
                seq: n,
                kind: 'message',
                role: who,
                content: text,
                at: n,
                ...(who === 'user' ? { localId: `local_${n}` } : {}),
              },
            ],
          },
        };
      });
    },
    [CHAT, seq, content, role] as const,
  );
}

const gap = (page: Page): Promise<number> =>
  page.locator('.chat-stream').evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);

test('a long new message pulls the view to its very bottom', async ({ page }) => {
  await page.goto(`/app/dev-harness.html?chat=${CHAT}`);
  await expect(page.locator('.chat-stream')).toBeVisible();
  await expect.poll(() => gap(page), { timeout: 4000 }).toBeLessThan(5);

  const long = Array.from({ length: 400 }, (_, i) =>
    i % 5 === 0
      ? '```ts\n' +
        Array.from({ length: 12 }, (_, j) => `const v${i}_${j} = ${j};`).join('\n') +
        '\n```'
      : i % 7 === 0
        ? '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'
        : `Paragraph ${i}. Lorem ipsum dolor sit amet consectetur adipiscing elit sed do.`,
  ).join('\n\n');
  await appendMessage(page, 5000, long);

  // Wait for the message to lay out, then for the view to settle.
  await expect(page.locator('.chat-stream')).toContainText('Paragraph 398');
  await page.waitForTimeout(1500);
  expect(await gap(page)).toBeLessThan(5);
});

test('a long message the user sends pulls the view to its very bottom', async ({ page }) => {
  await page.goto(`/app/dev-harness.html?chat=${CHAT}`);
  await expect.poll(() => gap(page), { timeout: 4000 }).toBeLessThan(5);
  // Scroll up first: a send re-pins even from history.
  await page.locator('.chat-stream').evaluate((el) => (el.scrollTop = 0));
  await page.waitForTimeout(300);
  const long = Array.from({ length: 80 }, (_, i) => `Line ${i} of a long pasted message.`).join(
    '\n\n',
  );
  await appendMessage(page, 5001, long, 'user');
  await expect(page.locator('.chat-stream')).toContainText('Line 79');
  await page.waitForTimeout(1500);
  expect(await gap(page)).toBeLessThan(5);
});
