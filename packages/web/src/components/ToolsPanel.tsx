// ToolsPanel — the per-chat tool inventory (patch/todo.md — "Show the tools in
// the chat so the user can see what tools the agent is calling, what each does,
// and its definition. Allow the user to turn them on and off. Purpose: make the
// agent's capabilities clear so it doesn't do random things and the user can
// guide it.").
//
// Opened from the Tools icon on the chat header's action rail, this is its OWN
// SIDEBAR COLUMN on the right of the shell (Todoist, App Updates: "for chat
// tools, tools should show in its own sidebar on right hand side. the button
// should be on the normal button rail top right") — not a full-viewport dialog,
// and no longer a takeover of the LEFT sidebar, so the chat list and the tool
// inventory are readable at once. It lists every tool the agent can reach for —
// native Claude Code tools then Patch's own cross-chat tools — each with WHAT
// IT DOES, its parameter DEFINITION, and an on/off switch. The OFF set is
// per-chat (toolsStore), persisted, and rides `chat.input` so the host drops
// disabled tools from the model's context. Escape or the close button removes
// the column, and so does navigating away from the chat it was opened for —
// the switches write THAT chat's OFF set, so a panel left standing on `/jobs`
// or on another chat is editing a chat nobody is looking at. Switching the left
// sidebar's view (Chats/Batch) is not a route change and leaves it alone.

import { useEffect, useState, type JSX } from 'react';
import { useMatch } from 'react-router-dom';
import { useUiStore } from '../stores/uiStore.js';
import { useToolsStore } from '../stores/toolsStore.js';
import { TOOL_CATALOG, type ToolCategory } from '../lib/toolsCatalog.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { patchShared } from '../routes/settings/sharedWrite.js';
import { Toggle } from './Toggle.js';
import { ColumnDivider } from './ColumnDivider.js';
import { CloseIcon } from './icons.js';

const CATEGORY_LABEL: Record<ToolCategory, string> = {
  native: 'Built-in tools',
  patch: 'Patch tools',
};

/** A Patch tool's name as the MCP server registers it (`mcp__patch__patch_spawn` → `patch_spawn`). */
function bareName(label: string): string {
  return label;
}

/**
 * The description the model reads for one Patch tool: Edit opens it for
 * rewriting, Save stores the edit as a shared setting (the next turn's tools
 * carry it), Reset drops the edit so the built-in text stands again.
 */
function ToolPromptEditor({ tool }: { tool: string }): JSX.Element | null {
  const override = usePreferencesStore((s) => s.preferences.toolPromptOverrides[tool]);
  const builtIn = usePresenceStore(
    (s) =>
      Object.values(s.hosts).find((h) => h.host?.toolPromptDefaults?.[tool] !== undefined)?.host
        ?.toolPromptDefaults?.[tool],
  );
  const [draft, setDraft] = useState<string | null>(null);
  const current = override ?? builtIn;
  // No host has reported the built-in text yet: there is nothing to edit from.
  if (current === undefined) return null;
  const overridesNow = (): Record<string, string> =>
    usePreferencesStore.getState().preferences.toolPromptOverrides;
  const save = async (text: string): Promise<void> => {
    const overrides = overridesNow();
    if (await patchShared('tool prompt', { toolPromptOverrides: { ...overrides, [tool]: text } })) {
      setDraft(null);
    }
  };
  const reset = async (): Promise<void> => {
    const { [tool]: _dropped, ...rest } = overridesNow();
    if (await patchShared('tool prompt', { toolPromptOverrides: rest })) setDraft(null);
  };

  if (draft === null) {
    return (
      <div className="tool-prompt" data-testid={`tool-prompt-${tool}`}>
        <div className="tool-prompt-actions">
          <button
            type="button"
            className="tool-prompt-btn"
            data-testid={`tool-prompt-edit-${tool}`}
            onClick={() => setDraft(current)}
          >
            Edit
          </button>
          {override !== undefined && (
            <span className="tool-prompt-state" data-testid={`tool-prompt-edited-${tool}`}>
              Edited
            </span>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="tool-prompt" data-testid={`tool-prompt-${tool}`}>
      <textarea
        className="tool-prompt-input"
        data-testid={`tool-prompt-input-${tool}`}
        aria-label={`${bareName(tool)} description`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={6}
      />
      <div className="tool-prompt-actions">
        <button
          type="button"
          className="tool-prompt-btn"
          data-testid={`tool-prompt-save-${tool}`}
          disabled={draft.trim() === '' || draft === current}
          onClick={() => void save(draft)}
        >
          Save
        </button>
        <button
          type="button"
          className="tool-prompt-btn"
          data-testid={`tool-prompt-cancel-${tool}`}
          onClick={() => setDraft(null)}
        >
          Cancel
        </button>
        {override !== undefined && (
          <button
            type="button"
            className="tool-prompt-btn"
            data-testid={`tool-prompt-reset-${tool}`}
            onClick={() => void reset()}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

export function ToolsPanel(): JSX.Element | null {
  const chatId = useUiStore((s) => s.toolsPanelChatId);
  const close = useUiStore((s) => s.setToolsPanelChatId);
  const width = useUiStore((s) => s.toolsPanelWidth);
  const setWidth = useUiStore((s) => s.setToolsPanelWidth);
  const resetWidth = useUiStore((s) => s.resetToolsPanelWidth);
  // Subscribe to the OFF set so a toggle re-renders the switches live.
  const disabledByChat = useToolsStore((s) => s.disabledByChat);
  const toggle = useToolsStore((s) => s.toggle);
  // `useMatch` (not the raw pathname) so the comparison is against the DECODED
  // chatId the route carries, the same value the header opened the panel with.
  const routeChatId = useMatch('/chats/:chatId')?.params.chatId ?? null;

  useEffect(() => {
    if (chatId === null) return;
    if (chatId !== routeChatId) close(null);
  }, [chatId, routeChatId, close]);

  useEffect(() => {
    if (chatId === null) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatId, close]);

  // Renders only for the chat actually on screen, so the column goes in the
  // same frame as the navigation rather than one render later.
  if (chatId === null || chatId !== routeChatId) return null;

  const disabled = disabledByChat[chatId] ?? [];
  const categories: ToolCategory[] = ['native', 'patch'];

  return (
    <>
      <ColumnDivider
        side="right"
        width={width}
        onResize={setWidth}
        onReset={resetWidth}
        testId="tools-divider"
      />
      <section
        className="tools-sidebar"
        data-testid="tools-panel"
        aria-label="Tools"
        style={{ width }}
      >
        <div className="tools-sidebar-head">
          <h2 className="tools-sidebar-title">Tools</h2>
          <button
            type="button"
            className="tools-sidebar-close"
            data-testid="tools-panel-close"
            aria-label="Close Tools"
            title="Close Tools"
            autoFocus
            onClick={() => close(null)}
          >
            <CloseIcon size={16} />
          </button>
        </div>
        {/* One scroller for the whole inventory — see `.tools-scroll`. The
          per-category sections are plain content inside it. */}
        <div className="tools-scroll" data-testid="tools-scroll">
          {categories.map((cat) => (
            <section key={cat} className="tools-group" data-testid={`tools-group-${cat}`}>
              <h3 className="tools-group-title">{CATEGORY_LABEL[cat]}</h3>
              <ul className="tools-list">
                {TOOL_CATALOG.filter((t) => t.category === cat).map((t) => {
                  const isOff = disabled.includes(t.name);
                  return (
                    <li className="tool-row" data-testid={`tool-row-${t.label}`} key={t.name}>
                      <div className="tool-row-main">
                        <div className="tool-row-head">
                          <code className="tool-row-name">{t.label}</code>
                          <Toggle
                            checked={!isOff}
                            onChange={() => toggle(chatId, t.name)}
                            testid={`tool-toggle-${t.label}`}
                            title={isOff ? 'Off' : 'On'}
                          />
                        </div>
                        <p className="tool-row-desc">{t.description}</p>
                        {cat === 'patch' && <ToolPromptEditor tool={t.label} />}
                        <code className="tool-row-def" data-testid={`tool-def-${t.label}`}>
                          {t.label}({t.params})
                        </code>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </section>
    </>
  );
}
