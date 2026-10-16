// Move page — move a chat to another machine (spec/04 § Moving a chat to
// another host, spec/15 § Chat detail → Move to…), reached from the chat's ⋯
// menu. Pick the machine, then the folder the chat will run in there: that
// machine's own folders are listed, the one with the same name as the chat's
// current folder chosen first, and any path can be typed. The chat stays where
// it is until the server says it has arrived; a refusal stays on this page
// with the reason. When the chat's own machine is offline, or the user chooses
// it, the move continues from the server's copy: a note says what stays behind,
// the folder starts empty and the same-named folder is only suggested.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { defaultMoveFolder } from '@patch/wire';
import { api, ApiError } from '../../../src/api/rest';
import { useChatStore } from '../../../src/stores/chatStore';
import { useFolderStore } from '../../../src/stores/folderStore';
import { usePresenceStore, type HostPresence } from '../../../src/stores/presenceStore';
import { useGoBack } from '../../../src/lib/goBack';
import { space, typography, useTheme } from '../../../src/lib/theme';

function hostName(h: HostPresence): string {
  return h.host?.hostName ?? h.hostId;
}

export default function ChatMoveScreen(): React.ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ chatId: string }>();
  const chatId = typeof params.chatId === 'string' ? params.chatId : '';
  const goBack = useGoBack(`/chats/${chatId}`);
  const row = useChatStore((s) => s.chats[chatId]);
  const hosts = usePresenceStore((s) => s.hosts);
  const byHost = useFolderStore((s) => s.byHost);

  const targets = useMemo(
    () =>
      Object.values(hosts)
        .filter((h) => h.hostId !== row?.hostId)
        .sort((a, b) => hostName(a).localeCompare(hostName(b))),
    [hosts, row?.hostId],
  );
  const [hostId, setHostId] = useState<string | null>(
    () => targets.find((h) => h.online)?.hostId ?? null,
  );
  const folders = useMemo(() => {
    const f = hostId ? byHost[hostId] : undefined;
    return [...new Set([...(f?.roots ?? []), ...(f?.recent ?? [])])];
  }, [byHost, hostId]);
  const current = row ? hosts[row.hostId] : undefined;
  const offline = current !== undefined && !current.online;
  const [fromCopy, setFromCopy] = useState(false);
  const takeover = offline || fromCopy;
  const [folder, setFolder] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  // A new machine offers its own folder — never the path typed for another one.
  // But a path the user has typed or picked on THIS machine is theirs: the
  // folder list is re-announced whenever any host publishes, and that must not
  // wipe it (or the refusal being shown for it).
  const chosenRef = useRef(false);
  const folderHostRef = useRef(hostId);
  useEffect(() => {
    if (folderHostRef.current !== hostId) {
      folderHostRef.current = hostId;
      chosenRef.current = false;
    }
    if (chosenRef.current) return;
    setFolder(row && !takeover ? (defaultMoveFolder(row.folder, folders) ?? '') : '');
    setError(null);
  }, [hostId, folders, row?.folder, takeover]);
  const suggestion = takeover && row ? defaultMoveFolder(row.folder, folders) : undefined;
  // Switching between the ordinary move and the server's copy starts the field afresh.
  const takeoverRef = useRef(takeover);
  if (takeoverRef.current !== takeover) {
    takeoverRef.current = takeover;
    chosenRef.current = false;
  }
  const chooseFolder = (f: string): void => {
    chosenRef.current = true;
    setFolder(f);
  };

  const canMove = hostId !== null && folder.trim().length > 0 && !moving && row !== undefined;

  async function move(): Promise<void> {
    if (!canMove || hostId === null) return;
    setMoving(true);
    setError(null);
    try {
      if (fromCopy && !offline) {
        await api.moveChat(chatId, hostId, folder.trim(), { fromServerCopy: true });
      } else {
        await api.moveChat(chatId, hostId, folder.trim());
      }
      goBack();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { message?: unknown } | null) : null;
      setError(typeof body?.message === 'string' ? body.message : (e as Error).message);
    } finally {
      setMoving(false);
    }
  }

  if (chatId === '') throw new Error('Move page opened without a chatId');
  return (
    <View testID="move-screen" style={{ flex: 1, backgroundColor: colors.paper }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          // The root layout's SafeAreaView already clears the status bar.
          paddingTop: space.sm,
          paddingHorizontal: space.md,
          paddingBottom: space.sm,
          backgroundColor: colors.paperRaised,
          borderBottomWidth: 1,
          borderColor: colors.divider,
        }}
      >
        <Pressable
          onPress={goBack}
          style={{ padding: space.sm }}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <ChevronLeft size={22} color={colors.ink} />
        </Pressable>
        <Text style={{ ...typography.title, color: colors.ink, paddingHorizontal: space.sm }}>
          Move chat
        </Text>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          padding: space.md,
          gap: space.md,
          // Nothing under the system navigation bar (CLAUDE.md § Android nav bar).
          paddingBottom: space.md + insets.bottom,
        }}
      >
        <Text testID="move-from" style={{ ...typography.meta, color: colors.inkFaint }}>
          {current ? hostName(current) : (row?.hostId ?? '')} · {row?.folder ?? ''}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {targets.map((h) => {
            const selected = hostId === h.hostId;
            return (
              <Pressable
                key={h.hostId}
                testID={`move-host-${h.hostId}`}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: !h.online || moving }}
                disabled={!h.online || moving}
                onPress={() => setHostId(h.hostId)}
                style={{
                  paddingVertical: space.sm,
                  paddingHorizontal: space.md,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: selected ? colors.leaf : colors.divider,
                  backgroundColor: selected ? colors.accentTint : 'transparent',
                }}
              >
                <Text
                  style={{ ...typography.label, color: h.online ? colors.ink : colors.inkFaint }}
                >
                  {hostName(h)}
                  {h.online ? '' : ' · offline'}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {takeover ? (
          <Text testID="move-takeover-note" style={{ ...typography.secondary, color: colors.ink2 }}>
            {offline && current ? `${hostName(current)} is offline. ` : ''}The chat continues from
            the server's copy. Uncommitted project files and watched processes stay on that machine.
            Timers and attachments move with the chat.
          </Text>
        ) : null}
        {offline ? null : (
          <Pressable
            testID="move-from-copy"
            accessibilityRole="button"
            accessibilityState={{ selected: fromCopy, disabled: moving }}
            disabled={moving}
            onPress={() => setFromCopy((v) => !v)}
            style={{ alignSelf: 'flex-start', paddingVertical: space.sm }}
          >
            <Text style={{ ...typography.label, color: colors.leaf }}>
              {fromCopy ? 'Move as it is instead' : "Continue from the server's copy instead"}
            </Text>
          </Pressable>
        )}
        {targets.length === 0 ? (
          <Text testID="move-no-hosts" style={{ ...typography.body, color: colors.ink2 }}>
            No other machine
          </Text>
        ) : null}
        <TextInput
          testID="move-folder"
          value={folder}
          onChangeText={chooseFolder}
          editable={hostId !== null && !moving}
          placeholder="Folder on that machine"
          placeholderTextColor={colors.inkFaint}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Folder"
          style={{
            ...typography.secondary,
            color: colors.ink,
            borderWidth: 1,
            borderColor: colors.divider,
            borderRadius: 8,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            backgroundColor: colors.paperRaised,
          }}
        />
        {suggestion ? (
          <Pressable
            testID="move-suggest"
            accessibilityRole="button"
            disabled={moving}
            onPress={() => chooseFolder(suggestion)}
            style={{ alignSelf: 'flex-start', paddingVertical: space.sm }}
          >
            <Text style={{ ...typography.secondary, color: colors.leaf }}>
              Suggested: {suggestion}
            </Text>
          </Pressable>
        ) : null}
        {folders.length > 0 ? (
          <View style={{ gap: space.xs }}>
            {folders.map((f) => (
              <Pressable
                key={f}
                testID={`move-folder-option-${f}`}
                disabled={moving}
                onPress={() => chooseFolder(f)}
                style={{ paddingVertical: space.sm }}
              >
                <Text
                  style={{
                    ...typography.secondary,
                    color: f === folder.trim() ? colors.leaf : colors.ink2,
                  }}
                >
                  {f}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {error ? (
          <Text
            testID="move-error"
            accessibilityRole="alert"
            style={{ ...typography.secondary, color: colors.red }}
          >
            {error}
          </Text>
        ) : null}
        <Pressable
          testID="move-confirm"
          accessibilityRole="button"
          accessibilityState={{ disabled: !canMove }}
          disabled={!canMove}
          onPress={() => void move()}
          style={{
            alignSelf: 'flex-start',
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingVertical: space.sm,
            paddingHorizontal: space.lg,
            borderRadius: 8,
            backgroundColor: canMove ? colors.leaf : colors.divider,
          }}
        >
          {moving ? <ActivityIndicator size="small" color={colors.onAccent} /> : null}
          <Text style={{ ...typography.label, color: colors.onAccent }}>
            {moving ? 'Moving…' : takeover ? 'Continue' : 'Move'}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
