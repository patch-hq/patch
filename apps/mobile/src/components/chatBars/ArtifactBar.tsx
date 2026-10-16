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
import { Keyboard, Pressable, ScrollView, Text } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { LayoutTemplate } from 'lucide-react-native';
import { apiUrl } from '../../config';
import { useChatStore } from '../../stores/chatStore';
import { deriveArtifacts } from '../../lib/artifacts';
import { openArtifactTarget } from '../../lib/pads';
import { openArtifactViewer } from '../ArtifactViewer';
import { radii, space, textMin, useTheme } from '../../lib/theme';

export function ArtifactBar({ chatId }: { chatId: string }): ReactElement | null {
  const colors = useTheme();
  const router = useRouter();
  const timeline = useChatStore((s) => s.timelines[chatId]);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardOpen(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  const artifacts = deriveArtifacts(timeline ?? []);
  if (artifacts.length === 0 || keyboardOpen) return null;

  return (
    <ScrollView
      testID="artifact-bar"
      accessibilityRole="toolbar"
      horizontal
      showsHorizontalScrollIndicator={false}
      // A horizontal ScrollView is flexGrow: 1 by default: in the chat column it
      // took the whole height and stretched the chip into a tall capsule.
      style={{ flexGrow: 0 }}
      contentContainerStyle={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: space.xs,
        paddingHorizontal: space.sm,
      }}
    >
      {artifacts.map((artifact) => (
        <Pressable
          key={artifact.artifactId}
          testID="artifact-bar-chip"
          accessibilityRole="button"
          accessibilityLabel={artifact.title}
          onPress={() =>
            openArtifactTarget(
              artifact.url,
              artifact.title,
              { pushRoute: (r) => router.push(r as Href), viewer: openArtifactViewer },
              apiUrl,
            )
          }
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
          <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: textMin, maxWidth: 160 }}>
            {artifact.title}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
