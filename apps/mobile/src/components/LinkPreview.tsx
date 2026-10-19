// LinkPreview — the small eye and open-in-browser icons beside a message link,
// and the inline card the eye expands (spec/14 § Message links). Only http(s)
// links get them: a mailto: or in-app link has nothing for the server to fetch.

import React from 'react';
import { Image, Linking, Pressable, Text, View } from 'react-native';
import { ExternalLink, Eye } from 'lucide-react-native';
import type { LinkPreviewData } from '../api/rest';
import { getLinkPreview, isHttpLink, previewImageSource } from '../lib/linkPreview';
import { fonts, radii, space, textMin, useTheme } from '../lib/theme';

export function LinkPreview({
  url,
  color,
}: {
  url: string;
  /** The icon colour: the link's own, so it reads on either bubble. */
  color: string;
}): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  if (!isHttpLink(url)) return null;
  return (
    <>
      <Pressable
        testID="link-preview-toggle"
        accessibilityRole="button"
        accessibilityLabel={open ? 'Hide link preview' : 'Preview link'}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        hitSlop={space.xs}
        style={{ paddingHorizontal: space.xs }}
      >
        <Eye size={14} color={color} />
      </Pressable>
      <Pressable
        testID="link-preview-external"
        accessibilityRole="button"
        accessibilityLabel="Open in browser"
        onPress={() => void Linking.openURL(url)}
        hitSlop={space.xs}
        style={{ paddingHorizontal: space.xs }}
      >
        <ExternalLink size={14} color={color} />
      </Pressable>
      {open ? <LinkPreviewCard url={url} /> : null}
    </>
  );
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; data: LinkPreviewData };

function LinkPreviewCard({ url }: { url: string }): React.ReactElement {
  const colors = useTheme();
  const [state, setState] = React.useState<State>({ kind: 'loading' });
  React.useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    getLinkPreview(url).then(
      (data) => live && setState({ kind: 'done', data }),
      (e: Error) => live && setState({ kind: 'error', message: e.message }),
    );
    return () => {
      live = false;
    };
  }, [url]);

  const text = { fontFamily: fonts.body, fontSize: textMin };
  const data = state.kind === 'done' ? state.data : null;
  return (
    <View
      testID="link-preview-card"
      style={{
        marginTop: space.xs,
        padding: space.sm,
        gap: space.xs,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.divider,
        backgroundColor: colors.paperRaised,
      }}
    >
      {state.kind === 'loading' ? (
        <Text style={{ ...text, color: colors.ink3 }}>Loading preview…</Text>
      ) : null}
      {state.kind === 'error' ? (
        <Text style={{ ...text, color: colors.red }}>{state.message}</Text>
      ) : null}
      {data && !data.title && !data.description && !data.image && !data.excerpt ? (
        <Text style={{ ...text, color: colors.ink3 }}>No preview available</Text>
      ) : null}
      {data?.image ? (
        <Image
          testID="link-preview-image"
          source={previewImageSource(data.image)}
          resizeMode="cover"
          style={{ width: '100%', height: 140, borderRadius: radii.sm }}
        />
      ) : null}
      {data?.title ? (
        <Text style={{ ...text, fontFamily: fonts.bodyMedium, color: colors.ink }}>
          {data.title}
        </Text>
      ) : null}
      {data?.description ? (
        <Text numberOfLines={3} style={{ ...text, color: colors.ink2 }}>
          {data.description}
        </Text>
      ) : null}
      {data?.excerpt ? (
        <Text
          testID="link-preview-excerpt"
          numberOfLines={10}
          style={{ ...text, color: colors.ink2, lineHeight: 20 }}
        >
          {data.excerpt}
        </Text>
      ) : null}
      <Text style={{ ...text, color: colors.ink3 }}>{new URL(url).host}</Text>
    </View>
  );
}
