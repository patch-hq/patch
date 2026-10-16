// The sidebar's one view switch (spec/14 § Sidebar 1b): a pill that opens a
// pop-up of exclusive options. It replaced the Chats/Batch tabs, the state
// filter and the Needs attention toggle.
import type { Page } from '@playwright/test';

export type SidebarViewOption = 'all' | 'unread' | 'working' | 'waiting' | 'failed' | 'batch';

/** Open the view pop-up and pick one option. */
export async function chooseSidebarView(page: Page, view: SidebarViewOption): Promise<void> {
  await page.getByTestId('sidebar-view-trigger').click();
  await page.getByTestId(`sidebar-view-option-${view}`).click();
}
