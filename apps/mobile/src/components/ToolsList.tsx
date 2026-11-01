// ToolsList — the per-chat tool inventory (patch/todo.md — "Show the tools in
// the chat so the user can see what tools the agent is calling, what each does,
// and its definition. Allow the user to turn them on and off."). Mobile's
// equivalent of desktop's ToolsPanel (packages/web/src/components/ToolsPanel.tsx),
// rendered as the body of the full-screen Tools page
// (app/chats/[chatId]/tools.tsx), reached from the chat's ⋯ menu → Tools.
//
// Lists every tool the agent can reach for — native Claude Code tools then
// Patch's own cross-chat tools — each with WHAT IT DOES, its parameter
// DEFINITION, and an on/off switch. The OFF set is per-chat (toolsStore),
// persisted, and rides `chat.input` so the host drops disabled tools from
// the model's context (Composer.tsx).

import React from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TOOL_CATALOG, type ToolCategory } from '../lib/toolsCatalog';
import { useToolsStore } from '../stores/toolsStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useSettingsStore } from '../stores/settingsStore';
import { Field, SettingsButton } from './settings/ui';
import { writePreferences } from './settings/PreferenceSections';
import { space, textMin, typography, useTheme } from '../lib/theme';

const CATEGORY_LABEL: Record<ToolCategory, string> = {
  native: 'Built-in tools',
  patch: 'Patch tools',
};

const CATEGORIES: ToolCategory[] = ['native', 'patch'];

/**
 * The description the model reads for one Patch tool. Edit opens it for
 * rewriting; Save stores it as a shared setting (the next turn's tools carry
 * it); Reset drops the edit so the built-in text stands again.
 */
function ToolPromptEditor({ tool }: { tool: string }): React.ReactElement | null {
  const colors = useTheme();
  const overrides = useSettingsStore((s) => s.data?.preferences.toolPromptOverrides);
  const builtIn = usePresenceStore(
    (s) =>
      Object.values(s.hosts).find((h) => h.host?.toolPromptDefaults?.[tool] !== undefined)?.host
        ?.toolPromptDefaults?.[tool],
  );
  const [draft, setDraft] = React.useState<string | null>(null);
  const override = overrides?.[tool];
  const current = override ?? builtIn;
  // Settings not loaded, or no host has reported the built-in text: nothing to edit from.
  if (overrides === undefined || current === undefined) return null;

  if (draft === null) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: 2 }}>
        <SettingsButton
          testID={`tool-prompt-edit-${tool}`}
          label="Edit"
          variant="quiet"
          onPress={() => setDraft(current)}
        />
        {override !== undefined && (
          <Text
            testID={`tool-prompt-edited-${tool}`}
            style={{ color: colors.ink3, fontSize: textMin }}
          >
            Edited
          </Text>
        )}
      </View>
    );
  }
  return (
    <View style={{ marginTop: space.xs, gap: space.xs }}>
      <Field
        testID={`tool-prompt-input-${tool}`}
        accessibilityLabel={`${tool} description`}
        multiline
        value={draft}
        onChangeText={setDraft}
      />
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <SettingsButton
          testID={`tool-prompt-save-${tool}`}
          label="Save"
          disabled={draft.trim() === '' || draft === current}
          onPress={() => {
            writePreferences({ toolPromptOverrides: { ...overrides, [tool]: draft } });
            setDraft(null);
          }}
        />
        <SettingsButton
          testID={`tool-prompt-cancel-${tool}`}
          label="Cancel"
          variant="quiet"
          onPress={() => setDraft(null)}
        />
        {override !== undefined && (
          <SettingsButton
            testID={`tool-prompt-reset-${tool}`}
            label="Reset"
            variant="quiet"
            onPress={() => {
              const { [tool]: _dropped, ...rest } = overrides;
              writePreferences({ toolPromptOverrides: rest });
              setDraft(null);
            }}
          />
        )}
      </View>
    </View>
  );
}

export function ToolsList({ chatId }: { chatId: string }): React.ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const disabledByChat = useToolsStore((s) => s.disabledByChat);
  const toggle = useToolsStore((s) => s.toggle);
  const disabled = disabledByChat[chatId] ?? [];

  return (
    <ScrollView
      testID="tools-scroll"
      // The page reaches the bottom of the window, so its last row pads past the
      // system nav bar (edge-to-edge) — counted once, here.
      contentContainerStyle={{ paddingBottom: insets.bottom + space.lg }}
    >
      {CATEGORIES.map((cat) => (
        <View key={cat} testID={`tools-group-${cat}`} style={{ paddingBottom: space.sm }}>
          <Text
            style={{
              ...typography.sectionHeader,
              color: colors.ink3,
              paddingHorizontal: space.lg,
              paddingTop: space.md,
              paddingBottom: space.xs,
            }}
          >
            {CATEGORY_LABEL[cat]}
          </Text>
          {TOOL_CATALOG.filter((t) => t.category === cat).map((t) => {
            const isOff = disabled.includes(t.name);
            return (
              <View
                key={t.name}
                testID={`tool-row-${t.label}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  paddingHorizontal: space.lg,
                  paddingVertical: space.sm,
                  gap: space.md,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ ...typography.rowTitle, color: colors.ink }}>{t.label}</Text>
                  <Text style={{ color: colors.ink2, fontSize: textMin, marginTop: 2 }}>
                    {t.description}
                  </Text>
                  <Text
                    testID={`tool-def-${t.label}`}
                    style={{
                      ...typography.code,
                      color: colors.ink3,
                      marginTop: 2,
                    }}
                  >
                    {t.label}({t.params})
                  </Text>
                  {cat === 'patch' && <ToolPromptEditor tool={t.label} />}
                </View>
                <Switch
                  testID={`tool-toggle-${t.label}`}
                  value={!isOff}
                  onValueChange={() => toggle(chatId, t.name)}
                />
              </View>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}
