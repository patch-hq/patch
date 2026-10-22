// LinkPreview — the small Summarise and open-in-browser icons beside a message
// link, and the inline card the Summarise button expands with a model's
// summary of the page (spec/14 § Message links). Only http(s) links get them:
// a mailto: or in-app link has nothing for the server to fetch.

import React from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { ExternalLink, Sparkles } from 'lucide-react-native';
import { getLinkSummary, isHttpLink } from '../lib/linkPreview';
import { fonts, radii, space, textMin, useTheme } from '../lib/theme';
import { useSettingsStore } from '../stores/settingsStore';

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
        testID="link-summary-toggle"
        accessibilityRole="button"
        accessibilityLabel={open ? 'Hide link summary' : 'Summarise link'}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        hitSlop={space.xs}
        style={{ paddingHorizontal: space.xs }}
      >
        <Sparkles size={14} color={color} />
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
      {open ? <LinkSummaryCard url={url} /> : null}
    </>
  );
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; summary: string };

function LinkSummaryCard({ url }: { url: string }): React.ReactElement {
  const colors = useTheme();
  const prompt = useSettingsStore((s) => s.data?.preferences.linkSummaryPrompt ?? '');
  const [state, setState] = React.useState<State>({ kind: 'loading' });
  React.useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    getLinkSummary(url, prompt).then(
      (data) => live && setState({ kind: 'done', summary: data.summary }),
      (e: Error) => live && setState({ kind: 'error', message: e.message }),
    );
    return () => {
      live = false;
    };
  }, [url, prompt]);

  const text = { fontFamily: fonts.body, fontSize: textMin };
  return (
    <View
      testID="link-summary-card"
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
        <Text style={{ ...text, color: colors.ink3 }}>Summarising…</Text>
      ) : null}
      {state.kind === 'error' ? (
        <Text testID="link-summary-error" style={{ ...text, color: colors.red }}>
          {state.message}
        </Text>
      ) : null}
      {state.kind === 'done' ? (
        <Text testID="link-summary-text" style={{ ...text, color: colors.ink2, lineHeight: 20 }}>
          {state.summary}
        </Text>
      ) : null}
      <Text style={{ ...text, color: colors.ink3 }}>{new URL(url).host}</Text>
    </View>
  );
}
