// One Pad (spec/14 § Pads, mirrored on the phone). The editor — View/Edit,
// Select/Note/Draw, the screen list, the numbered changes and Send — is the
// Pad's own page, served by the server from a signed URL and shown in a
// WebView. The header around it is Patch's: the Pad's name (tap to rename), the
// app and chat it belongs to, a way to that chat, and Delete (confirmed).
//
// The editor is a live page that reaches into the design's document, so it
// needs a direct route to the server; over a relay there is no origin for the
// WebView to load, and the screen says so rather than showing a blank frame.

import React from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { WebView } from 'react-native-webview';
import { ArrowLeft, MessageSquare, Trash2 } from 'lucide-react-native';
import { api, type PadView } from '../../src/api/rest';
import { apiUrl } from '../../src/config';
import { isRelayed } from '../../src/lib/servedFile';
import { useChatStore } from '../../src/stores/chatStore';
import { useUiStore } from '../../src/stores/uiStore';
import { useGoBack } from '../../src/lib/goBack';
import { padBadge } from '../../src/lib/pads';
import { space, textMin, typography, useTheme } from '../../src/lib/theme';

export const PAD_POLL_MS = 5000;

export default function PadScreen(): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const { padId } = useLocalSearchParams<{ padId: string }>();
  const goBack = useGoBack('/pads' as Href);
  const [pad, setPad] = React.useState<PadView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState<string | null>(null);
  const [frameError, setFrameError] = React.useState<string | null>(null);
  const chatName = useChatStore((s) => (pad ? (s.chats[pad.chatId]?.name ?? pad.chatId) : ''));

  React.useEffect(() => {
    let live = true;
    const load = (): void => {
      api.getPad(padId).then(
        (p) => {
          if (!live) return;
          setPad(p);
          setError(null);
        },
        (e: Error) => {
          if (live) setError(e.message);
        },
      );
    };
    load();
    const t = setInterval(load, PAD_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [padId]);

  const rename = async (next: string): Promise<void> => {
    setName(null);
    const trimmed = next.trim();
    if (!pad || trimmed === '' || trimmed === pad.name) return;
    try {
      setPad(await api.patchPad(padId, { name: trimmed }));
    } catch (e) {
      useUiStore.getState().pushError(`rename failed: ${(e as Error).message}`);
    }
  };

  const remove = (): void => {
    Alert.alert('Delete this Pad?', 'Its screens and any changes not yet sent are removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          api
            .deletePad(padId)
            .then(goBack, (e: Error) =>
              useUiStore.getState().pushError(`delete failed: ${e.message}`),
            );
        },
      },
    ]);
  };

  if (error && pad === null) {
    return (
      <View
        testID="pad-error"
        style={{ flex: 1, padding: space.md, backgroundColor: colors.paper }}
      >
        <Text style={{ color: colors.red }}>Failed to load this pad: {error}</Text>
      </View>
    );
  }
  if (pad === null)
    return <View testID="pad-screen" style={{ flex: 1, backgroundColor: colors.paper }} />;

  const badge = padBadge(pad);
  return (
    <View testID="pad-screen" style={{ flex: 1, backgroundColor: colors.paper }}>
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
          testID="pad-back"
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={goBack}
          hitSlop={space.sm}
        >
          <ArrowLeft size={22} color={colors.ink2} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          {name !== null ? (
            <TextInput
              testID="pad-name-input"
              accessibilityLabel="Pad name"
              value={name}
              autoFocus
              onChangeText={setName}
              onSubmitEditing={() => void rename(name)}
              onBlur={() => void rename(name)}
              style={{
                color: colors.ink,
                borderBottomWidth: 1,
                borderColor: colors.divider,
                ...typography.title,
              }}
            />
          ) : (
            <Pressable
              testID="pad-name"
              accessibilityRole="button"
              accessibilityLabel="Rename pad"
              onPress={() => setName(pad.name)}
            >
              <Text numberOfLines={1} style={{ ...typography.title, color: colors.ink }}>
                {pad.name}
              </Text>
            </Pressable>
          )}
          <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: textMin }}>
            {[pad.app, chatName, badge].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <Pressable
          testID="pad-open-chat"
          accessibilityRole="button"
          accessibilityLabel="Open chat"
          onPress={() => router.push(`/chats/${pad.chatId}` as Href)}
          hitSlop={space.sm}
        >
          <MessageSquare size={20} color={colors.ink2} />
        </Pressable>
        <Pressable
          testID="pad-delete"
          accessibilityRole="button"
          accessibilityLabel="Delete pad"
          onPress={remove}
          hitSlop={space.sm}
        >
          <Trash2 size={20} color={colors.ink2} />
        </Pressable>
      </View>
      {pad.screensError ? (
        <Text testID="pad-screens-error" style={{ color: colors.red, padding: space.md }}>
          This pad&apos;s screens could not be read: {pad.screensError}
        </Text>
      ) : isRelayed() ? (
        <Text testID="pad-relayed" style={{ color: colors.red, padding: space.md }}>
          The Pad editor needs a direct connection to the server; this phone reaches it through a
          relay.
        </Text>
      ) : frameError ? (
        <Text testID="pad-frame-error" style={{ color: colors.red, padding: space.md }}>
          The Pad editor failed to load: {frameError}
        </Text>
      ) : (
        // No borderRadius: on Android it makes the WebView paint white.
        <WebView
          testID="pad-webview"
          source={{ uri: apiUrl(pad.frameUrl) }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          onError={(e) => setFrameError(e.nativeEvent.description)}
          onHttpError={(e) =>
            setFrameError(`HTTP ${e.nativeEvent.statusCode} from ${e.nativeEvent.url}`)
          }
          onRenderProcessGone={() => setFrameError('the WebView process was killed')}
          style={{ flex: 1 }}
        />
      )}
    </View>
  );
}
