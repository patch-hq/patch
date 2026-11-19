import { test, expect, type Page } from '@playwright/test';

// Messages a chat exchanges with other agents are cards in the transcript:
// "Sent to <chat>" for a `patch_send_to` this chat made, "From <chat>" for a
// reply another chat sent back, each with the text and the chat's name opening
// it. Real browser, real CSS, dev harness (no backend). The cards must read as
// cards (bordered, no coloured left-edge accent) and the link must open the chat.

const CHAT = 'chat_md';
const TARGET = 'chat_table'; // "Tea prices" in the harness
const SHOTS = process.env['PATCH_SHOTS_DIR'];

async function emit(page: Page, event: unknown): Promise<void> {
  await page.evaluate((ev) => {
    (window as unknown as { __store: { getState(): { applyEvent(e: unknown): void } } }).__store
      .getState()
      .applyEvent(ev);
  }, event);
}

async function noLeftAccent(page: Page, testid: string): Promise<void> {
  const style = await page
    .getByTestId(testid)
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        left: s.borderLeftWidth,
        right: s.borderRightWidth,
        color: s.borderLeftColor,
        rc: s.borderRightColor,
      };
    });
  expect(style.left).toBe(style.right);
  expect(style.color).toBe(style.rc);
}

test.describe('messages exchanged with other agents', () => {
  test('a patch_send_to is one "Sent to" card that opens the target chat', async ({ page }) => {
    await page.goto(`/app/dev-harness.html?chat=${CHAT}`);
    await emit(page, {
      type: 'chat.tool_call',
      chatId: CHAT,
      tool: 'mcp__patch__patch_send_to',
      callId: 'send-1',
      args: {
        chatId: TARGET,
        message:
          'Could you check the **Assam** price against last week and flag anything over 10%?',
      },
      seq: 9001,
    });
    await emit(page, {
      type: 'chat.tool_result',
      chatId: CHAT,
      tool: 'mcp__patch__patch_send_to',
      callId: 'send-1',
      result: { ok: true, queued: true },
      seq: 9002,
    });
    const card = page.getByTestId('agent-msg-sent');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Sent to');
    await expect(card.getByTestId('agent-msg-link')).toHaveText('Tea prices');
    await expect(card).toContainText('flag anything over 10%');
    await expect(page.getByText('Using patch send to')).toHaveCount(0);
    await noLeftAccent(page, 'agent-msg-sent');
    if (SHOTS) await card.screenshot({ path: `${SHOTS}/sent-to-card.png` });

    await card.getByTestId('agent-msg-link').click();
    // The harness routes in memory: the chat that opened is the one now on screen.
    await expect(page.getByTestId('chat-title').first()).toHaveText('Tea prices');
    await expect(page.getByTestId('agent-msg-link')).toHaveCount(0);
  });

  test('a reply another chat sent back is a "From" card that opens that chat', async ({ page }) => {
    await page.goto(`/app/dev-harness.html?chat=${CHAT}`);
    await emit(page, {
      type: 'chat.message',
      chatId: CHAT,
      role: 'user',
      origin: 'machine',
      content: `[from Tea prices; chat ${TARGET}] Assam is up 12% on last week. Darjeeling and Ceylon are flat.`,
      seq: 9101,
      createdAt: Date.now(),
    });
    const card = page.getByTestId('agent-msg-from');
    await expect(card).toBeVisible();
    await expect(card).toContainText('From');
    await expect(card.getByTestId('agent-msg-link')).toHaveText('Tea prices');
    await expect(card).toContainText('Assam is up 12%');
    await expect(card).not.toContainText('[from');
    await noLeftAccent(page, 'agent-msg-from');
    if (SHOTS) await card.screenshot({ path: `${SHOTS}/from-chat-card.png` });

    await card.getByTestId('agent-msg-link').click();
    // The harness routes in memory: the chat that opened is the one now on screen.
    await expect(page.getByTestId('chat-title').first()).toHaveText('Tea prices');
    await expect(page.getByTestId('agent-msg-link')).toHaveCount(0);
  });

  test('both directions together, in the transcript', async ({ page }) => {
    await page.goto(`/app/dev-harness.html?chat=${CHAT}`);
    await emit(page, {
      type: 'chat.tool_call',
      chatId: CHAT,
      tool: 'mcp__patch__patch_send_to',
      callId: 'send-2',
      args: { chatId: TARGET, message: 'What did Assam cost last week?' },
      seq: 9201,
    });
    await emit(page, {
      type: 'chat.tool_result',
      chatId: CHAT,
      tool: 'mcp__patch__patch_send_to',
      callId: 'send-2',
      result: { ok: true, queued: true },
      seq: 9202,
    });
    await emit(page, {
      type: 'chat.message',
      chatId: CHAT,
      role: 'user',
      origin: 'machine',
      content: `[from Tea prices; chat ${TARGET}] £4.20 per 100g.`,
      seq: 9203,
      createdAt: Date.now(),
    });
    await expect(page.getByTestId('agent-msg-sent')).toBeVisible();
    await expect(page.getByTestId('agent-msg-from')).toBeVisible();
    if (SHOTS) {
      await page.getByTestId('agent-msg-from').scrollIntoViewIfNeeded();
      await page.getByTestId('chat-stream').screenshot({ path: `${SHOTS}/both-cards.png` });
    }
  });
});
