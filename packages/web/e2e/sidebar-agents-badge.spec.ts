import { test, expect } from '@playwright/test';

// spec/14 § Status badges — the `agents` state.
//
// Running sub-agents and running background tasks used to share one terminal
// glyph. They are two different facts, so the sidebar draws two different
// icons: `chat_agents` has sub-agents running, `chat_bgtask` has plain
// background tasks.
const HARNESS = '/app/dev-harness.html';

test.describe('sidebar agents badge', () => {
  test('agents and background tasks draw different badges', async ({ page }) => {
    await page.goto(HARNESS);
    const agents = page.getByTestId('chat-row-chat_agents');
    const tasks = page.getByTestId('chat-row-chat_bgtask');
    await expect(agents).toBeVisible();

    const agentsBadge = agents.getByTestId('badge-agents');
    await expect(agentsBadge).toBeVisible();
    await expect(agentsBadge).toHaveAttribute('title', 'Agents running');
    await expect(agentsBadge.locator('svg')).toHaveCount(1);
    await expect(agents.getByTestId('badge-background')).toHaveCount(0);

    const tasksBadge = tasks.getByTestId('badge-background');
    await expect(tasksBadge).toBeVisible();
    await expect(tasks.getByTestId('badge-agents')).toHaveCount(0);

    // Different glyphs, not the same drawing under two names.
    const a = await agentsBadge.locator('svg').innerHTML();
    const t = await tasksBadge.locator('svg').innerHTML();
    expect(a).not.toEqual(t);
  });
});
