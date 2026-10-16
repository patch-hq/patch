// Pads (spec/14 § Pads, mirrored on the phone): every design space, grouped by
// the app it designs for, with a search box. A row opens the Pad.

import React from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { ArrowLeft, Layers, Plus } from 'lucide-react-native';
import { api, type PadView } from '../../src/api/rest';
import { useChatStore } from '../../src/stores/chatStore';
import { useGoBack } from '../../src/lib/goBack';
import { groupPads, padBadge, padRoute } from '../../src/lib/pads';
import { newPadHref } from '../../src/lib/newPad';
import { agoLabel } from '../../src/lib/agoLabel';
import { fonts, radii, space, textMin, typography, useTheme } from '../../src/lib/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const PADS_POLL_MS = 5000;

export default function PadsScreen(): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const goBack = useGoBack('/(tabs)/jobs');
  const insets = useSafeAreaInsets();
  const chats = useChatStore((s) => s.chats);
  const [pads, setPads] = React.useState<PadView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');

  const load = React.useCallback(async (): Promise<void> => {
    try {
      setPads((await api.listPads()).pads);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  React.useEffect(() => {
    void load();
    const t = setInterval(() => void load(), PADS_POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const chatName = (chatId: string): string => chats[chatId]?.name ?? chatId;
  const groups = groupPads(pads ?? [], query, chatName);

  return (
    <View testID="pads-screen" style={{ flex: 1, backgroundColor: colors.paper }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingTop: space.md,
          paddingHorizontal: space.md,
          paddingBottom: space.sm,
        }}
      >
        <Pressable
          testID="pads-back"
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={goBack}
          hitSlop={space.sm}
        >
          <ArrowLeft size={22} color={colors.ink2} />
        </Pressable>
        <Text accessibilityRole="header" style={{ ...typography.title, color: colors.ink }}>
          Pads
        </Text>
        <View style={{ flex: 1 }} />
        <Pressable
          testID="pads-new"
          accessibilityRole="button"
          accessibilityLabel="New pad"
          onPress={() => router.push(newPadHref())}
          hitSlop={space.sm}
        >
          <Plus size={22} color={colors.ink2} />
        </Pressable>
      </View>
      {pads !== null && pads.length > 0 ? (
        <TextInput
          testID="pads-search"
          accessibilityLabel="Search pads"
          placeholder="Search pads"
          placeholderTextColor={colors.ink3}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            marginHorizontal: space.md,
            marginBottom: space.sm,
            borderWidth: 1,
            borderColor: colors.divider,
            borderRadius: radii.md,
            paddingHorizontal: space.md,
            paddingVertical: space.xs + 2,
            color: colors.ink,
            fontFamily: fonts.body,
          }}
        />
      ) : null}
      <ScrollView
        contentContainerStyle={{ padding: space.md, paddingBottom: insets.bottom + space.md }}
      >
        {error && pads === null ? (
          <View testID="pads-error">
            <Text style={{ color: colors.red }}>Failed to load pads: {error}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry"
              onPress={() => void load()}
              style={{ marginTop: space.xs }}
            >
              <Text style={{ ...typography.label, color: colors.leaf }}>Retry</Text>
            </Pressable>
          </View>
        ) : pads === null ? null : groups.length === 0 ? (
          <Text testID="pads-empty" style={{ color: colors.ink3 }}>
            {query ? 'No pads match.' : 'No pads yet.'}
          </Text>
        ) : (
          groups.map(([app, list]) => (
            <View key={app} testID={`pads-group-${app}`} style={{ marginBottom: space.lg }}>
              <Text
                accessibilityRole="header"
                style={{ ...typography.meta, color: colors.ink3, marginBottom: space.xs }}
              >
                {app} · {list.length}
              </Text>
              {list.map((p) => {
                const badge = padBadge(p);
                return (
                  <Pressable
                    key={p.id}
                    testID={`pad-row-${p.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Open pad ${p.name}`}
                    onPress={() => router.push(padRoute(p.id) as Href)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.sm,
                      padding: space.md,
                      marginBottom: space.xs,
                      borderRadius: radii.md,
                      backgroundColor: colors.paperRaised,
                    }}
                  >
                    <Layers size={16} color={colors.ink2} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        numberOfLines={1}
                        style={{ color: colors.ink, fontFamily: fonts.bodyMedium }}
                      >
                        {p.name}
                      </Text>
                      <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: textMin }}>
                        {chatName(p.chatId)} · {agoLabel(p.updatedAt)}
                      </Text>
                    </View>
                    {badge ? (
                      <Text
                        testID={`pad-badge-${p.id}`}
                        style={{ color: colors.leaf, fontSize: textMin }}
                      >
                        {badge}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
