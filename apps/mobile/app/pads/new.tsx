// New Pad (spec/14 § Pads — Starting a Pad, way (c), mirrored on the phone): a
// name; Based on Blank or an app, then which earlier captures of that app to
// start from; Desktop or Phone; the chat that owns it. Create makes the Pad
// and opens it.
//
// The phone cannot DOM-capture a live Patch screen, so a Patch pad here starts
// only from the screens earlier Pads captured, like any other app's.
// `chatId` and `app` params preselect the owner and the app ("Design a change
// to Chat" from the chat menu).

import React from 'react';
import { Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { ArrowLeft, Monitor, Plus, Smartphone } from 'lucide-react-native';
import { api, type PadLibrary } from '../../src/api/rest';
import { apiUrl } from '../../src/config';
import { useChatStore } from '../../src/stores/chatStore';
import { useGoBack } from '../../src/lib/goBack';
import { OptionPicker } from '../../src/components/OptionPicker';
import {
  buildCreateBody,
  canCreate,
  libraryKey,
  padApps,
  padChatOptions,
} from '../../src/lib/newPad';
import { padRoute } from '../../src/lib/pads';
import { fonts, radii, space, textMin, typography, useTheme } from '../../src/lib/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function NewPadScreen(): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const goBack = useGoBack('/pads' as Href);
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ chatId?: string; app?: string }>();
  const chats = useChatStore((s) => s.chats);
  const [library, setLibrary] = React.useState<PadLibrary | null>(null);
  const [name, setName] = React.useState('');
  const [basedOn, setBasedOn] = React.useState(params.app ?? '');
  const [selected, setSelected] = React.useState<string[]>([]);
  const [device, setDevice] = React.useState<'desktop' | 'phone'>('desktop');
  const [chatId, setChatId] = React.useState(params.chatId ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    api.padLibrary().then(
      (l) => live && setLibrary(l),
      (e: Error) => live && setError(`Failed to load the library: ${e.message}`),
    );
    return () => {
      live = false;
    };
  }, []);

  const chatOptions = padChatOptions(chats);
  const chatLabel =
    chatOptions.find((o) => o.id === chatId)?.label ??
    (chatId !== '' ? (chats[chatId]?.name ?? chatId) : 'Choose a chat');
  const screens = library?.apps.find((a) => a.app === basedOn)?.screens ?? [];

  const pickApp = (app: string): void => {
    setBasedOn(app);
    setSelected([]);
  };
  const toggle = (key: string): void =>
    setSelected((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const pad = await api.createPad(
        buildCreateBody({ name, app: basedOn, device, chatId, selected }),
      );
      router.replace(padRoute(pad.id) as Href);
    } catch (e) {
      setError(`Could not create the pad: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const chip = (on: boolean) => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: on ? colors.leaf : colors.divider,
    backgroundColor: on ? colors.accentTint : colors.paperRaised,
  });
  const label = { ...typography.meta, color: colors.ink3, marginTop: space.md };
  const create_ok = canCreate({ name, chatId, busy });

  return (
    <View testID="new-pad-screen" style={{ flex: 1, backgroundColor: colors.paper }}>
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
          testID="new-pad-back"
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={goBack}
          hitSlop={space.sm}
        >
          <ArrowLeft size={22} color={colors.ink2} />
        </Pressable>
        <Text accessibilityRole="header" style={{ ...typography.title, color: colors.ink }}>
          New Pad
        </Text>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.md, paddingBottom: insets.bottom + space.md }}
      >
        <TextInput
          testID="new-pad-name"
          accessibilityLabel="Pad name"
          placeholder="Name"
          placeholderTextColor={colors.ink3}
          value={name}
          onChangeText={setName}
          style={{
            borderWidth: 1,
            borderColor: colors.divider,
            borderRadius: radii.md,
            paddingHorizontal: space.md,
            paddingVertical: space.xs + 2,
            color: colors.ink,
            fontFamily: fonts.body,
          }}
        />
        <Text style={label}>Based on</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs }}>
          <Pressable
            testID="new-pad-based-blank"
            accessibilityRole="radio"
            accessibilityState={{ checked: basedOn === '' }}
            onPress={() => pickApp('')}
            style={chip(basedOn === '')}
          >
            <Plus size={14} color={colors.ink2} />
            <Text style={{ color: colors.ink, fontSize: textMin }}>Blank</Text>
          </Pressable>
          {padApps(library).map((a) => (
            <Pressable
              key={a}
              testID={`new-pad-based-${a}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: basedOn === a }}
              onPress={() => pickApp(a)}
              style={chip(basedOn === a)}
            >
              <Text style={{ color: colors.ink, fontSize: textMin }}>{a}</Text>
            </Pressable>
          ))}
        </View>
        {basedOn !== '' && screens.length > 0 ? (
          <View testID="new-pad-library">
            <Text style={label}>Earlier captures</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {screens.map((s) => {
                const key = libraryKey(s.padId, s.screenId);
                const on = selected.includes(key);
                return (
                  <Pressable
                    key={key}
                    testID={`new-pad-lib-${s.padId}-${s.screenId}`}
                    accessibilityRole="button"
                    accessibilityLabel={s.name}
                    accessibilityState={{ selected: on }}
                    onPress={() => toggle(key)}
                    style={{
                      width: 104,
                      padding: space.xs,
                      borderRadius: radii.md,
                      borderWidth: 2,
                      borderColor: on ? colors.leaf : colors.divider,
                      backgroundColor: colors.paperRaised,
                    }}
                  >
                    <View
                      style={{
                        height: 120,
                        borderRadius: radii.sm,
                        overflow: 'hidden',
                        backgroundColor: colors.lineSoft,
                      }}
                    >
                      {s.thumbUrl ? (
                        <Image
                          testID={`new-pad-lib-thumb-${s.padId}-${s.screenId}`}
                          source={{ uri: apiUrl(s.thumbUrl) }}
                          resizeMode="cover"
                          style={{ width: '100%', height: '100%' }}
                        />
                      ) : null}
                    </View>
                    <Text
                      numberOfLines={1}
                      style={{ color: colors.ink2, fontSize: textMin, marginTop: space.xs }}
                    >
                      {s.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            marginTop: space.lg,
          }}
        >
          {(['desktop', 'phone'] as const).map((d) => (
            <Pressable
              key={d}
              testID={`new-pad-${d}`}
              accessibilityRole="radio"
              accessibilityLabel={d === 'desktop' ? 'Desktop' : 'Phone'}
              accessibilityState={{ checked: device === d }}
              onPress={() => setDevice(d)}
              style={chip(device === d)}
            >
              {d === 'desktop' ? (
                <Monitor size={16} color={colors.ink2} />
              ) : (
                <Smartphone size={16} color={colors.ink2} />
              )}
            </Pressable>
          ))}
        </View>
        <View style={{ marginTop: space.md }}>
          <OptionPicker
            testID="new-pad-chat"
            selectedId={chatId}
            selectedLabel={chatLabel}
            options={chatOptions}
            onSelect={setChatId}
            emptyText="No chats"
          />
        </View>
        {error ? (
          <Text testID="new-pad-error" style={{ color: colors.red, marginTop: space.md }}>
            {error}
          </Text>
        ) : null}
        <Pressable
          testID="new-pad-create"
          accessibilityRole="button"
          disabled={!create_ok}
          onPress={() => void create()}
          style={{
            marginTop: space.lg,
            alignItems: 'center',
            padding: space.md,
            borderRadius: radii.md,
            backgroundColor: colors.leaf,
            opacity: create_ok ? 1 : 0.5,
          }}
        >
          <Text style={{ color: colors.onAccent, fontFamily: fonts.bodyMedium }}>
            {busy ? 'Creating…' : 'Create'}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
