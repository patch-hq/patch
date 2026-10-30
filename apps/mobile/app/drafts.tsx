// Drafts list (spec/14 § New chat drafts, spec/15 § New chat flow) — the
// phone's parity with desktop's sidebar Drafts section: every not-yet-sent
// new chat, live from the server. Tapping a row continues it; × discards it
// everywhere.

import React from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronLeft, FileText, X } from 'lucide-react-native';
import { folderName } from '@patch/wire';
import {
  hasDraftText,
  useNewChatDraftStore,
  type NewChatDraft,
} from '../src/stores/newChatDraftStore';
import { useGoBack } from '../src/lib/goBack';
import { fonts, radii, space, typography, useTheme } from '../src/lib/theme';

function DraftRow({ draft }: { draft: NewChatDraft }): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const text = draft.text.trim();
  const title = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return (
    <Pressable
      testID={`draft-row-${draft.id}`}
      onPress={() => router.replace(`/new-chat?draftId=${encodeURIComponent(draft.id)}`)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        backgroundColor: pressed ? colors.paperRaised : colors.paper,
      })}
    >
      <FileText size={16} color={colors.ink3} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: colors.ink, fontFamily: fonts.body, fontSize: 15 }}>
          {title}
        </Text>
        {draft.failure ? (
          <Text
            testID={`draft-failed-${draft.id}`}
            numberOfLines={1}
            style={{ color: colors.red, ...typography.meta, marginTop: 2 }}
          >
            Failed · {draft.failure.sentence}
          </Text>
        ) : draft.folder ? (
          <Text numberOfLines={1} style={{ color: colors.ink3, ...typography.meta, marginTop: 2 }}>
            {folderName(draft.folder)}
          </Text>
        ) : null}
      </View>
      <Pressable
        testID={`draft-discard-${draft.id}`}
        onPress={() => useNewChatDraftStore.getState().remove(draft.id)}
        accessibilityRole="button"
        accessibilityLabel="Discard draft"
        hitSlop={8}
        style={{ padding: space.xs, borderRadius: radii.md }}
      >
        <X size={18} color={colors.ink3} />
      </Pressable>
    </Pressable>
  );
}

export default function Drafts(): React.ReactElement {
  const colors = useTheme();
  const goBack = useGoBack('/(tabs)/chats');
  const drafts = useNewChatDraftStore((s) => s.drafts);
  const order = useNewChatDraftStore((s) => s.order);
  const rows = order
    .map((id) => drafts[id])
    .filter((d): d is NewChatDraft => !!d && hasDraftText(d.text));

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper, paddingTop: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md }}>
        <Pressable onPress={goBack} style={{ padding: space.sm }} accessibilityLabel="Back">
          <ChevronLeft size={22} color={colors.ink} />
        </Pressable>
        <Text style={{ ...typography.title, color: colors.ink, flex: 1 }}>Drafts</Text>
      </View>
      <FlatList
        testID="drafts-list"
        data={rows}
        keyExtractor={(d) => d.id}
        renderItem={({ item }) => <DraftRow draft={item} />}
        ItemSeparatorComponent={() => (
          <View style={{ height: 1, backgroundColor: colors.divider, marginLeft: space.lg + 24 }} />
        )}
      />
    </View>
  );
}
