// Right-click context menu for the main window's webContents.
//
// Electron windows have NO context menu by default — right-clicking a chat did
// nothing, so a user could not copy selected text, paste into the composer, or
// copy/open a link the "normal" way. This builds a native menu from the
// `context-menu` event params:
//
//   - On a link  → "Open Link in Patch" (the embedded web panel), "Open Link in
//     Browser" (the user's REAL browser) and "Copy Link Address". Both
//     destinations are named because this menu is where the choice is
//     DISCOVERABLE: a plain click opens the panel and a ⌘/Ctrl/Shift-click goes
//     to the browser, but neither gesture announces itself (spec/14 § Links and
//     the web panel). Patch leads, matching what a plain click does.
//   - Always     → Cut / Copy / Paste (native roles, enabled per editFlags) and
//     Select All, so the general copy/paste menu works everywhere.
//
// This module is intentionally free of any electron RUNTIME import so it can be
// unit-tested under plain node (see context-menu.test.ts): it takes the click
// handlers (shell.openExternal, clipboard.writeText) as injected deps and only
// type-imports MenuItemConstructorOptions.

import type { MenuItemConstructorOptions } from 'electron';
import { routeWindowOpen } from './link-policy';

/** The subset of Electron's ContextMenuParams we consume. */
export interface ContextMenuParams {
  linkURL?: string;
  selectionText?: string;
  /** 'image' when the click landed on an <img>/canvas-backed image. */
  mediaType?: string;
  x?: number;
  y?: number;
  isEditable?: boolean;
  editFlags?: {
    canCut?: boolean;
    canCopy?: boolean;
    canPaste?: boolean;
    canSelectAll?: boolean;
  };
}

/** Deps injected so the template stays electron-runtime-free and testable. */
export interface ContextMenuDeps {
  /** Open a URL in the user's real browser (shell.openExternal). */
  openExternal: (url: string) => void;
  /**
   * Show a URL in Patch's own web panel (main.ts `openInAppBrowser`, guarded by
   * the shared link policy so a `file:`/`javascript:` link is refused rather
   * than loaded).
   */
  openInPatch: (url: string) => void;
  /** Write a string to the system clipboard (clipboard.writeText). */
  writeText: (text: string) => void;
  /** Copy the image under (x, y) to the clipboard (webContents.copyImageAt). */
  copyImageAt: (x: number, y: number) => void;
}

/**
 * Build the context-menu template for a right-click at `params`. Returns a
 * plain MenuItemConstructorOptions[] — the caller wraps it with
 * Menu.buildFromTemplate(...).popup().
 */
export function buildContextMenuTemplate(
  params: ContextMenuParams,
  deps: ContextMenuDeps,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  const flags = params.editFlags ?? {};

  // --- Link actions (only when the click landed on a link) ---------------
  if (params.linkURL) {
    const url = params.linkURL;
    template.push(
      {
        label: 'Open Link in Patch',
        click: () => deps.openInPatch(url),
      },
      {
        label: 'Open Link in Browser',
        // The same http(s)-only guard as every other way a link leaves the window:
        // `file:`, `javascript:` and custom schemes would otherwise reach the OS.
        click: () => {
          const action = routeWindowOpen(url);
          if (action.kind === 'external') deps.openExternal(action.url);
        },
      },
      {
        label: 'Copy Link Address',
        click: () => deps.writeText(url),
      },
      { type: 'separator' },
    );
  }

  // --- Image action: the page's own <img> has no native copy otherwise ------
  if (params.mediaType === 'image' && params.x !== undefined && params.y !== undefined) {
    const { x, y } = params;
    template.push(
      { label: 'Copy Image', click: () => deps.copyImageAt(x, y) },
      { type: 'separator' },
    );
  }

  // --- Editing actions (native roles: Electron dispatches cut/copy/paste to
  // the focused webContents itself). We set `enabled` from editFlags so the
  // items grey out when the action isn't applicable (e.g. paste in a
  // read-only view, copy with no selection). ---------------------------------
  template.push(
    { label: 'Cut', role: 'cut', enabled: flags.canCut ?? false },
    { label: 'Copy', role: 'copy', enabled: flags.canCopy ?? false },
    { label: 'Paste', role: 'paste', enabled: flags.canPaste ?? false },
    { type: 'separator' },
    { label: 'Select All', role: 'selectAll' },
  );

  return template;
}
