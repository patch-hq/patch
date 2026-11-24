// ArtifactBar — every artifact this chat has published, above the transcript
// (spec/15 § Artifacts; mirrors web's `packages/web/src/components/
// ArtifactBar.tsx`). The transcript already carries each artifact as its own
// card, but finding an earlier one again means scrolling back to find it.
// This bar is the standing index: one chip per artifact, newest first,
// tapping a chip opens exactly what tapping its card would. Nothing to show
// when the chat has published nothing. It is a slim strip, and it steps aside
// while the keyboard is up: that is when vertical space is scarcest and the
// transcript is what is being read.

import React, { useEffect, useState, type ReactElement } from 'react';
import { FlatList, Keyboard, Modal, Pressable, ScrollView, Text, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, type Href } from 'expo-router';
import { LayoutTemplate, List } from 'lucide-react-native';
import { apiUrl } from '../../config';
import { useChatStore } from '../../stores/chatStore';
import { deriveArtifacts, mergeArtifacts, type ServerArtifact } from '../../lib/artifacts';
import { api } from '../../api/rest';
import { openArtifactTarget } from '../../lib/pads';
import { openArtifactViewer } from '../ArtifactViewer';
import { radii, space, textMin, typography, useTheme } from '../../lib/theme';

// The strip carries only the newest few; a chat with dozens of artifacts is
// browsed in the full list the "All" chip opens.
const STRIP_LIMIT = 3;

function ArtifactList({
  artifacts,
  onOpen,
  onClose,
}: {
  artifacts: ServerArtifact[] | ArtifactRowLike[];
  onOpen: (a: ArtifactRowLike) => void;
  onClose: () => void;
}): ReactElement {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q ? artifacts.filter((a) => a.title.toLowerCase().includes(q)) : artifacts;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: colors.shade }} onPress={onClose}>
        <Pressable
          testID="artifact-list"
          onPress={() => {}}
          style={{
            marginTop: 'auto',
            maxHeight: '80%',
            backgroundColor: colors.paperRaised,
            borderTopLeftRadius: radii.lg,
            borderTopRightRadius: radii.lg,
            padding: space.lg,
            paddingBottom: space.md + insets.bottom,
            gap: space.md,
          }}
        >
          <Text style={{ ...typography.title, color: colors.ink }}>
            Artifacts ({artifacts.length})
          </Text>
          <TextInput
            testID="artifact-list-search"
            accessibilityLabel="Search artifacts"
            placeholder="Search"
            placeholderTextColor={colors.ink3}
            value={query}
            onChangeText={setQuery}
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
          <FlatList
            data={shown}
            keyExtractor={(a) => a.artifactId}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={<Text style={{ color: colors.ink3 }}>No matches</Text>}
            renderItem={({ item }) => (
              <Pressable
                testID="artifact-list-row"
                accessibilityRole="button"
                accessibilityLabel={item.title}
                onPress={() => onOpen(item)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.sm,
                  paddingVertical: space.sm,
                }}
              >
                <LayoutTemplate size={16} color={colors.ink2} />
                <Text numberOfLines={2} style={{ ...typography.body, color: colors.ink, flex: 1 }}>
                  {item.title}
                </Text>
              </Pressable>
            )}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
type ArtifactRowLike = { artifactId: string; title: string; url: string };

export function ArtifactBar({ chatId }: { chatId: string }): ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const timeline = useChatStore((s) => s.timelines[chatId]);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardOpen(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const live = deriveArtifacts(timeline ?? []);
  // The transcript is paged: the server's list supplies the older ones, and is
  // fetched again whenever the chat publishes something new.
  const [served, setServed] = useState<ServerArtifact[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .getChatArtifacts(chatId)
      .then((r) => {
        if (!cancelled) setServed(r.artifacts);
      })
      .catch((err) => console.error('artifact bar: could not load the artifact list', err));
    return () => {
      cancelled = true;
    };
  }, [chatId, live.length]);
  const artifacts = mergeArtifacts(live, served);
  if (artifacts.length === 0 || keyboardOpen) return null;
  const open = (artifact: ArtifactRowLike): void =>
    openArtifactTarget(
      artifact.url,
      artifact.title,
      { pushRoute: (r) => router.push(r as Href), viewer: openArtifactViewer },
      apiUrl,
    );

  return (
    <>
      <ScrollView
        testID="artifact-bar"
        accessibilityRole="toolbar"
        horizontal
        showsHorizontalScrollIndicator={false}
        // A horizontal ScrollView is flexGrow: 1 by default: in the chat column it
        // took the whole height and stretched the chip into a tall capsule.
        // flexShrink 0 as well: the transcript below is flex: 1, and a shrinkable
        // bar was squeezed under its chip's height so the chip painted over the
        // transcript's first line.
        style={{ flexGrow: 0, flexShrink: 0 }}
        contentContainerStyle={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: space.xs,
          paddingHorizontal: space.sm,
          paddingBottom: space.xs,
        }}
      >
        {artifacts.slice(0, STRIP_LIMIT).map((artifact) => (
          <Pressable
            key={artifact.artifactId}
            testID="artifact-bar-chip"
            accessibilityRole="button"
            accessibilityLabel={artifact.title}
            onPress={() => open(artifact)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.xs,
              backgroundColor: colors.paperRaised,
              borderColor: colors.lineSoft,
              borderWidth: 1,
              borderRadius: radii.pill,
              paddingHorizontal: space.sm,
              paddingVertical: 2,
            }}
          >
            <LayoutTemplate size={14} color={colors.ink2} />
            <Text
              numberOfLines={1}
              style={{ color: colors.ink2, fontSize: textMin, maxWidth: 160 }}
            >
              {artifact.title}
            </Text>
          </Pressable>
        ))}
        {artifacts.length > STRIP_LIMIT && (
          <Pressable
            testID="artifact-bar-all"
            accessibilityRole="button"
            accessibilityLabel={`All ${artifacts.length} artifacts`}
            onPress={() => setListOpen(true)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.xs,
              borderColor: colors.lineSoft,
              borderWidth: 1,
              borderRadius: radii.pill,
              paddingHorizontal: space.sm,
              paddingVertical: 2,
            }}
          >
            <List size={14} color={colors.ink2} />
            <Text style={{ color: colors.ink2, fontSize: textMin }}>All {artifacts.length}</Text>
          </Pressable>
        )}
      </ScrollView>
      {listOpen && (
        <ArtifactList
          artifacts={artifacts}
          onClose={() => setListOpen(false)}
          onOpen={(a) => {
            setListOpen(false);
            open(a);
          }}
        />
      )}
    </>
  );
}
