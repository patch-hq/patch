// Full-screen image markup for a pending attachment (spec/15 § Composer —
// attachments). The drawing surface is a WebView page (lib/imageAnnotator.ts);
// this component feeds it the image, decodes what the page posts back, and on
// Done writes the flattened PNG to the cache for the composer to swap in.
//
// NO FALLBACK: an unreadable image, a message the page should never send, a
// page-reported error or a failed write all show in the modal and are pushed
// to the error toasts — none is dropped.

import React from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import * as FileSystem from 'expo-file-system';
import {
  annotatedName,
  buildAnnotatorHtml,
  imageDataUri,
  sketchName,
  parseAnnotatorMessage,
} from '../lib/imageAnnotator';
import type { PendingAttachment } from '../stores/composerAttachmentStore';
import { useUiStore } from '../stores/uiStore';
import { fixed, fonts, radii, space, useTheme } from '../lib/theme';

/** What Done hands back: the annotated copy, ready to replace the original. */
export interface AnnotatedImage {
  uri: string;
  name: string;
  mimeType: 'image/png';
  width: number;
  height: number;
}

let seq = 0;

export function ImageAnnotatorModal({
  attachment,
  sketch = false,
  onDone,
  onCancel,
}: {
  /** The image to mark up; null keeps the modal closed unless `sketch` is set. */
  attachment: PendingAttachment | null;
  /** Open on a blank white page instead (no attachment needed). */
  sketch?: boolean;
  onDone: (next: AnnotatedImage) => void;
  onCancel: () => void;
}): React.ReactElement {
  const colors = useTheme();
  const [html, setHtml] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const fail = React.useCallback((message: string): void => {
    setError(message);
    useUiStore.getState().pushError(message);
  }, []);

  React.useEffect(() => {
    setHtml(null);
    setError(null);
    if (attachment === null) {
      if (sketch) setHtml(buildAnnotatorHtml(null));
      return;
    }
    let live = true;
    (async () => {
      if (!attachment.uri) {
        throw new Error(
          `${attachment.name} was attached on another device and can't be annotated here`,
        );
      }
      const base64 = await FileSystem.readAsStringAsync(attachment.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const page = buildAnnotatorHtml(imageDataUri(base64, attachment.mimeType));
      if (live) setHtml(page);
    })().catch((e: Error) => {
      if (live) fail(e.message);
    });
    return () => {
      live = false;
    };
  }, [attachment, sketch, fail]);

  const onMessage = (event: WebViewMessageEvent): void => {
    if (attachment === null && !sketch) return;
    void (async () => {
      const msg = parseAnnotatorMessage(event.nativeEvent.data);
      if (msg.type === 'cancel') {
        onCancel();
        return;
      }
      if (msg.type === 'error') {
        throw new Error(msg.message);
      }
      seq += 1;
      const uri = `${FileSystem.cacheDirectory}annotated-${Date.now()}-${seq}.png`;
      await FileSystem.writeAsStringAsync(uri, msg.png.slice(msg.png.indexOf(',') + 1), {
        encoding: FileSystem.EncodingType.Base64,
      });
      onDone({
        uri,
        name: attachment === null ? sketchName() : annotatedName(attachment.name),
        mimeType: 'image/png',
        width: msg.width,
        height: msg.height,
      });
    })().catch((e: Error) => fail(e.message));
  };

  return (
    <Modal
      visible={attachment !== null || sketch}
      animationType="slide"
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      <View testID="image-annotator" style={{ flex: 1, backgroundColor: fixed.camera }}>
        {error !== null ? (
          <View style={{ padding: space.lg, gap: space.md }}>
            <Text testID="annotator-error" style={{ color: colors.red }}>
              {error}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onCancel}
              style={{
                alignSelf: 'flex-start',
                paddingHorizontal: space.md,
                paddingVertical: space.xs,
                borderRadius: radii.md,
                backgroundColor: colors.paperRaised,
              }}
            >
              <Text style={{ color: colors.ink, fontFamily: fonts.bodyBold }}>Close</Text>
            </Pressable>
          </View>
        ) : html === null ? (
          <ActivityIndicator color={colors.leaf} style={{ margin: space.xl }} />
        ) : (
          <WebView
            testID="annotator-webview"
            source={{ html }}
            originWhitelist={['*']}
            javaScriptEnabled
            onMessage={onMessage}
            style={{ flex: 1, backgroundColor: fixed.camera }}
          />
        )}
      </View>
    </Modal>
  );
}
