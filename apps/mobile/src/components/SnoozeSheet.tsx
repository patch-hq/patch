// SnoozeSheet — the one place a snooze is chosen on the phone, for a chat and
// for a whole project (spec/04 § Snooze, spec/15 § Snooze sheet). A bottom
// sheet with the web sheet's sections: the preset grid with each wake time, the
// "Run in background" box, the rule line and the confirm button. Choosing a
// preset only selects it; nothing is applied until the primary button.
//
// The sheet pads past the system navigation bar once (`insets.bottom`) —
// portfolio CLAUDE.md § Android nav bar.

import React from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { AlarmClock } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';
import { formatElapsed, formatWakeAt } from '@patch/wire';
import type { ChatRow } from '../stores/types';
import { useChatStore } from '../stores/chatStore';
import { useUiStore } from '../stores/uiStore';
import { SNOOZE_PRESETS, parseCustomSnooze } from '../lib/snooze';
import { applySnoozeSet, chatsInFolder } from '../lib/snoozeApply';
import { deriveChatTitle } from '../lib/labels';
import { fonts, radii, space, textMin, typography, useTheme } from '../lib/theme';

export type SnoozeSheetTarget =
  | { kind: 'chat'; chatId: string }
  | { kind: 'project'; folder: string; name: string };

interface SheetState {
  target: SnoozeSheetTarget | null;
  open(target: SnoozeSheetTarget): void;
  close(): void;
}

export const useSnoozeSheetStore = create<SheetState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export function showSnoozeSheet(target: SnoozeSheetTarget): void {
  useSnoozeSheetStore.getState().open(target);
}

const CUSTOM = 'custom';

/** The wake time for the chosen option, or null while there is none to show. */
function wakeFor(selected: string | null, customValue: string): number | null {
  if (selected === null) return null;
  if (selected === CUSTOM) {
    try {
      return parseCustomSnooze(customValue);
    } catch {
      return null;
    }
  }
  return SNOOZE_PRESETS.find((p) => p.id === selected)?.resolve() ?? null;
}

export function SnoozeSheet(): React.ReactElement | null {
  const target = useSnoozeSheetStore((s) => s.target);
  return target === null ? null : <SheetBody target={target} />;
}

function SheetBody({ target }: { target: SnoozeSheetTarget }): React.ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const close = useSnoozeSheetStore((s) => s.close);
  const chats = useChatStore((s) => s.chats);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [customValue, setCustomValue] = React.useState('');

  const isProject = target.kind === 'project';
  const targets: ChatRow[] = isProject
    ? chatsInFolder(Object.values(chats), target.folder)
    : chats[target.chatId]
      ? [chats[target.chatId]!]
      : [];
  const running = targets.filter((c) => c.activity === 'running');
  const notRunning = targets.length - running.length;
  const name = isProject ? target.name : deriveChatTitle(targets[0] ?? ({ name: null } as ChatRow));
  const wake = wakeFor(selected, customValue);
  const canConfirm = selected !== null && targets.length > 0;

  const confirm = (): void => {
    if (!canConfirm) return;
    let at: number;
    if (selected === CUSTOM) {
      try {
        at = parseCustomSnooze(customValue);
      } catch (e) {
        // NO FALLBACK — a past or malformed time is said, not corrected.
        useUiStore.getState().pushError((e as Error).message);
        return;
      }
    } else {
      at = wakeFor(selected, '')!;
    }
    close();
    applySnoozeSet({ targets, until: at, name, isProject });
  };

  const primaryLabel =
    wake === null
      ? 'Snooze'
      : isProject
        ? `Snooze ${targets.length} until ${formatWakeAt(wake)}`
        : `Snooze until ${formatWakeAt(wake)}`;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <Pressable
        testID="snooze-sheet-scrim"
        style={{ flex: 1, backgroundColor: colors.shade }}
        onPress={close}
      >
        <View style={{ flex: 1 }} />
        <Pressable
          testID="snooze-sheet"
          onPress={() => {}}
          style={{
            backgroundColor: colors.paperRaised,
            borderTopLeftRadius: radii.lg,
            borderTopRightRadius: radii.lg,
            paddingTop: space.lg,
            paddingHorizontal: space.lg,
            paddingBottom: space.md + insets.bottom,
            maxHeight: '90%',
          }}
        >
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space.md }}>
            <View>
              <Text testID="snooze-sheet-title" style={{ ...typography.title, color: colors.ink }}>
                {isProject ? `Snooze ${name}` : 'Snooze'}
              </Text>
              <Text
                testID="snooze-sheet-subtitle"
                numberOfLines={1}
                style={{ ...typography.meta, color: colors.ink3 }}
              >
                {isProject ? `${targets.length} ${targets.length === 1 ? 'chat' : 'chats'}` : name}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {[...SNOOZE_PRESETS, { id: CUSTOM, label: 'Custom…', resolve: () => 0 }].map((p) => {
                const on = selected === p.id;
                return (
                  <Pressable
                    key={p.id}
                    testID={`snooze-sheet-preset-${p.id}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    onPress={() => setSelected(p.id)}
                    style={{
                      flexBasis: '48%',
                      flexGrow: 1,
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      paddingHorizontal: space.md,
                      paddingVertical: space.md,
                      borderRadius: radii.sm,
                      borderWidth: 1,
                      borderColor: on ? colors.ink : colors.divider,
                      backgroundColor: on ? colors.ink : colors.paperRaised,
                    }}
                  >
                    <Text
                      style={{
                        ...typography.secondary,
                        color: on ? colors.paperRaised : colors.ink,
                      }}
                    >
                      {p.label}
                    </Text>
                    {p.id === CUSTOM ? null : (
                      <Text
                        style={{
                          ...typography.meta,
                          color: on ? colors.paperRaised : colors.ink3,
                          opacity: on ? 0.75 : 1,
                        }}
                      >
                        {formatWakeAt(p.resolve())}
                      </Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
            {selected === CUSTOM ? (
              <TextInput
                testID="snooze-sheet-custom-input"
                accessibilityLabel="Snooze until"
                placeholder="YYYY-MM-DD HH:mm"
                placeholderTextColor={colors.ink3}
                value={customValue}
                onChangeText={setCustomValue}
                onSubmitEditing={confirm}
                autoFocus
                returnKeyType="done"
                style={{
                  ...typography.body,
                  color: colors.ink,
                  paddingVertical: space.sm,
                  paddingHorizontal: space.md,
                  borderRadius: radii.sm,
                  borderWidth: 1,
                  borderColor: colors.divider,
                }}
              />
            ) : null}

            {running.length > 0 ? (
              <View
                testID="snooze-sheet-run"
                style={{
                  padding: space.md,
                  borderRadius: radii.md,
                  borderWidth: 1,
                  borderColor: colors.lineSoft,
                  backgroundColor: colors.bgSoft,
                  gap: space.sm,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <AlarmClock size={14} color={colors.ink3} />
                  <Text
                    style={{ ...typography.meta, fontFamily: fonts.bodyBold, color: colors.ink3 }}
                  >
                    Run in background
                  </Text>
                  <Text style={{ ...typography.meta, marginLeft: 'auto', color: colors.ink3 }}>
                    {running.length}
                  </Text>
                </View>
                {running.map((c) => (
                  <View
                    key={c.chatId}
                    testID="snooze-sheet-run-item"
                    style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}
                  >
                    <View
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 5,
                        backgroundColor: colors.amber,
                      }}
                    />
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={{ ...typography.rowTitle, color: colors.ink }}>
                        {isProject ? deriveChatTitle(c) : 'This chat'}
                      </Text>
                      {c.statusSummary ? (
                        <Text numberOfLines={1} style={{ ...typography.meta, color: colors.ink3 }}>
                          {c.statusSummary}
                        </Text>
                      ) : null}
                    </View>
                    {c.runningSince ? (
                      <Text style={{ ...typography.meta, color: colors.ink3 }}>
                        {formatElapsed(Date.now() - c.runningSince)}
                      </Text>
                    ) : null}
                  </View>
                ))}
                {isProject && notRunning > 0 ? (
                  <Text style={{ ...typography.meta, color: colors.ink3 }}>
                    + {notRunning} not running
                  </Text>
                ) : null}
              </View>
            ) : null}

            <Text style={{ ...typography.meta, color: colors.ink3 }}>
              Snoozed chats keep running and reappear when scheduled
            </Text>

            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Pressable
                testID="snooze-sheet-cancel"
                accessibilityRole="button"
                onPress={close}
                style={{ paddingVertical: space.md, paddingRight: space.lg }}
              >
                <Text style={{ ...typography.label, color: colors.ink3 }}>Cancel</Text>
              </Pressable>
              <View style={{ flex: 1 }} />
              <Pressable
                testID="snooze-sheet-confirm"
                accessibilityRole="button"
                accessibilityState={{ disabled: !canConfirm }}
                disabled={!canConfirm}
                onPress={confirm}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.sm,
                  paddingHorizontal: space.lg,
                  paddingVertical: space.md,
                  borderRadius: radii.md,
                  backgroundColor: colors.ink,
                  opacity: canConfirm ? 1 : 0.4,
                }}
              >
                <AlarmClock size={15} color={colors.paperRaised} />
                <Text
                  style={{ ...typography.label, fontSize: textMin + 1, color: colors.paperRaised }}
                >
                  {primaryLabel}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
