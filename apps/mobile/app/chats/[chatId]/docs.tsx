// Chat-folder document browser (spec/15 § Document editor). Lists the folder a
// chat is pinned to, one directory per screen, and offers only what the
// document editor can open: folders to walk into, `.md` files, and `.docx`
// files (converted on open). Reached from the chat's ⋯ menu → Documents.
// NO FALLBACK: a listing that fails says so in place of the list.

import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CornerLeftUp, File, FileText, Folder } from 'lucide-react-native';
import { api } from '../../../src/api/rest';
import { EmptyState } from '../../../src/components/EmptyState';
import { HostToolHeader } from '../../../src/components/HostToolHeader';
import {
  docRoute,
  docsRoute,
  documentEntries,
  isDocxPath,
  joinRel,
  parentRel,
  type FolderEntry,
} from '../../../src/lib/docEditor';
import { EMPTY_STATES } from '../../../src/lib/emptyStates';
import { useGoBack } from '../../../src/lib/goBack';
import { useChatStore } from '../../../src/stores/chatStore';
import { space, textMin, typography, useTheme } from '../../../src/lib/theme';

export default function ChatDocs(): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const { chatId, path = '' } = useLocalSearchParams<{ chatId: string; path?: string }>();
  const goBack = useGoBack(`/chats/${chatId}`);
  const folder = useChatStore((s) => s.chats[chatId]?.folder ?? '');

  const [entries, setEntries] = React.useState<FolderEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async (): Promise<void> => {
    setEntries(null);
    setError(null);
    try {
      const res = await api.chatFilesList(chatId, path);
      setEntries(documentEntries(res.entries));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [chatId, path]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const up = parentRel(path);

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <HostToolHeader title="Documents" hostName={path === '' ? folder : path} onBack={goBack} />
      {error !== null ? (
        <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md }}>
          <Text testID="docs-error" style={{ color: colors.red }}>
            {error}
          </Text>
          <Pressable
            testID="docs-retry"
            accessibilityRole="button"
            accessibilityLabel="Retry"
            onPress={() => void load()}
            style={{ alignSelf: 'flex-start', padding: space.sm }}
          >
            <Text style={{ color: colors.leaf }}>Retry</Text>
          </Pressable>
        </View>
      ) : entries === null ? (
        <ActivityIndicator testID="docs-loading" color={colors.leaf} style={{ margin: space.xl }} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: space.xl }}>
          {up !== null ? (
            <Row
              testID="docs-up"
              label="Up a level"
              icon={<CornerLeftUp size={16} color={colors.ink3} />}
              onPress={() => router.push(docsRoute(chatId, up))}
            />
          ) : null}
          {entries.length === 0 ? (
            <EmptyState icon={Folder} {...EMPTY_STATES.folder} />
          ) : (
            entries.map((e) => (
              <Row
                key={e.name}
                testID={`docs-entry-${e.name}`}
                label={e.name}
                icon={
                  e.type === 'dir' ? (
                    <Folder size={16} color={colors.leaf} />
                  ) : isDocxPath(e.name) ? (
                    <File size={16} color={colors.ink3} />
                  ) : (
                    <FileText size={16} color={colors.ink3} />
                  )
                }
                onPress={() => {
                  const full = joinRel(path, e.name);
                  router.push(e.type === 'dir' ? docsRoute(chatId, full) : docRoute(chatId, full));
                }}
              />
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

function Row({
  testID,
  label,
  icon,
  onPress,
}: {
  testID: string;
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: space.sm,
        paddingHorizontal: space.lg,
        backgroundColor: pressed ? colors.accentTint : 'transparent',
      })}
    >
      {icon}
      <Text
        style={{
          ...typography.body,
          fontSize: textMin + 2,
          color: colors.ink,
          marginLeft: space.sm,
          flex: 1,
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}
