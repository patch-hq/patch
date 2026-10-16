// Document editor (spec/14 § Document editor, spec/15 § Document editor).
//
// One Markdown file from a chat's folder, shown VERBATIM in a monospace text
// area: no conversion on open or on save, so frontmatter, wrapping and
// whitespace come back byte-identical unless the user types. Save is explicit,
// a dot beside the name says there are unsaved changes, and a save never
// overwrites a file that changed on disk since it was opened (the same
// baseline / on-disk / draft check the web editor makes).
//
// Around the text: the document's mode, toggles that swap the text for the
// Suggestions, Comments or History panel, a selection bar (Ask about this,
// Comment), and an Export menu. A `.docx` path is converted first and the
// resulting `.md` is what opens, its import warnings shown above the text.
//
// The text itself is written over the socket (`file.write`, no ack), so a save
// reads the file back to confirm it landed. Every other change is one
// `docAction` whose answer replaces the view.

import React from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Download } from 'lucide-react-native';
import type { DocAction, DocView } from '@patch/wire';
import { api } from '../../../src/api/rest';
import { AnchoredMenu } from '../../../src/components/AnchoredMenu';
import { HostToolHeader } from '../../../src/components/HostToolHeader';
import {
  CommentsPanel,
  DocModePicker,
  HistoryPanel,
  SuggestionsPanel,
} from '../../../src/components/DocToolsPanel';
import { confirmWritten, writeChatFile } from '../../../src/lib/chatFileWrite';
import { getComposerDraft, setComposerDraft } from '../../../src/lib/composerDraft';
import {
  EXPORT_FORMATS,
  baseName,
  detectSaveConflict,
  docsRoute,
  isDocxPath,
  isOpenableDoc,
  orderSuggestions,
  orderThreads,
  parentRel,
  selectedText,
  withQuotedSelection,
  type ExportFormat,
  type TextSelection,
} from '../../../src/lib/docEditor';
import { saveExport } from '../../../src/lib/docExport';
import { useGoBack } from '../../../src/lib/goBack';
import { fonts, radii, space, textMin, useTheme } from '../../../src/lib/theme';

type Panel = 'text' | 'suggestions' | 'comments' | 'history';

/** The dispatches that rewrite the document's text on the host. */
const TEXT_CHANGING: ReadonlySet<DocAction['op']> = new Set([
  'accept_suggestion',
  'accept_all',
  'restore_version',
]);

const EXPORT_LABEL: Record<ExportFormat, string> = {
  docx: 'Word (.docx)',
  pdf: 'PDF',
  md: 'Markdown',
};

interface Loaded {
  /** The chat-folder path actually open: the `.md`, even when a `.docx` was asked for. */
  path: string;
  /** What is on disk as of the last read or save. */
  saved: string;
}

export default function ChatDoc(): React.ReactElement {
  const colors = useTheme();
  const router = useRouter();
  const { chatId, path } = useLocalSearchParams<{ chatId: string; path: string }>();
  const goBack = useGoBack(docsRoute(chatId, parentRel(path) ?? undefined));

  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [text, setText] = React.useState('');
  const [view, setView] = React.useState<DocView | null>(null);
  const [convertWarnings, setConvertWarnings] = React.useState<string[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [panel, setPanel] = React.useState<Panel>('text');
  const [selection, setSelection] = React.useState<TextSelection>({ start: 0, end: 0 });
  const [commentDraft, setCommentDraft] = React.useState<string | null>(null);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [exportWarnings, setExportWarnings] = React.useState<string[]>([]);

  // The latest text and baseline, for async continuations that outlive a render.
  const latest = React.useRef({ text, saved: '' });
  latest.current = { text, saved: loaded?.saved ?? '' };
  // The `.md` once known, so a Reload after a `.docx` open does not reconvert.
  const mdPath = React.useRef<string | null>(null);

  const load = React.useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      if (!isOpenableDoc(path)) throw new Error(`not a document: ${path}`);
      let target = mdPath.current;
      if (target === null) {
        target = path;
        if (isDocxPath(path)) {
          const converted = await api.convertDocx(chatId, path);
          target = converted.mdPath;
          setConvertWarnings(converted.warnings);
        }
        mdPath.current = target;
      }
      const [file, doc] = await Promise.all([
        api.chatFileRead(chatId, target),
        api.getDoc(chatId, target),
      ]);
      setLoaded({ path: target, saved: file.content });
      setText(file.content);
      setView(doc);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [chatId, path]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const dirty = loaded !== null && text !== loaded.saved;
  const docPath = loaded?.path ?? path;

  const save = async (): Promise<void> => {
    if (loaded === null || !dirty || saving) return;
    setSaving(true);
    const draft = text;
    try {
      const onDisk = (await api.chatFileRead(chatId, loaded.path)).content;
      if (detectSaveConflict({ baseline: loaded.saved, onDisk, draft })) {
        Alert.alert(
          'Changed on disk',
          'This file changed since you opened it, so your save was not written.',
          [
            { text: 'Keep editing', style: 'cancel' },
            { text: 'Reload', style: 'destructive', onPress: () => void load() },
          ],
        );
        return;
      }
      writeChatFile(chatId, loaded.path, draft);
      const landed = await confirmWritten(
        async () => (await api.chatFileRead(chatId, loaded.path)).content,
        draft,
      );
      if (!landed) {
        Alert.alert('Save not confirmed', 'The host did not report the new content back.');
        return;
      }
      setLoaded({ path: loaded.path, saved: draft });
      // A save is a new version: show the history it just made.
      setView(await api.getDoc(chatId, loaded.path));
    } catch (e) {
      Alert.alert('Save failed', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** One DocAction, answered by the updated view. A refusal is reported, not dropped. */
  const dispatch = (action: DocAction): void => {
    void (async () => {
      try {
        const next = await api.docAction(chatId, docPath, action);
        setView(next);
        if (TEXT_CHANGING.has(action.op)) {
          // The host rewrote the file. Take it unless the user has unsaved
          // edits, which stay (their Save will meet the conflict check).
          const disk = (await api.chatFileRead(chatId, docPath)).content;
          if (latest.current.text === latest.current.saved) {
            setText(disk);
            setLoaded({ path: docPath, saved: disk });
          }
        }
      } catch (e) {
        Alert.alert('Action failed', (e as Error).message);
      }
    })();
  };

  // Back — the header's and the system's — asks before dropping edits.
  const guarded = React.useCallback(
    (then: () => void): boolean => {
      if (!dirty) {
        then();
        return true;
      }
      Alert.alert('Discard changes?', 'Your edits to this file have not been saved.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: then },
      ]);
      return true;
    },
    [dirty],
  );
  const leave = React.useCallback((): boolean => guarded(goBack), [guarded, goBack]);
  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', leave);
    return () => sub.remove();
  }, [leave]);

  const selected = selectedText(text, selection);

  const ask = (): void => {
    const quote = selected;
    guarded(() => {
      setComposerDraft(chatId, withQuotedSelection(getComposerDraft(chatId), quote));
      router.navigate(`/chats/${chatId}`);
    });
  };

  const submitComment = (): void => {
    if (commentDraft === null || commentDraft.trim().length === 0) return;
    dispatch({ op: 'add_comment', anchor: selected, text: commentDraft });
    setCommentDraft(null);
    setPanel('comments');
  };

  const exportAs = async (format: ExportFormat): Promise<void> => {
    if (dirty) {
      Alert.alert(
        'Unsaved changes',
        'Save the document first: the export is made from the saved file.',
      );
      return;
    }
    setNotice(null);
    setExportWarnings([]);
    try {
      const out = await api.exportDoc(chatId, docPath, format);
      const res = await saveExport({ base64: out.base64, filename: out.filename, format });
      if (res.status === 'saved') setNotice(`Saved ${out.filename}`);
      setExportWarnings(out.warnings);
    } catch (e) {
      Alert.alert('Export failed', (e as Error).message);
    }
  };

  const warnings = convertWarnings ?? view?.importWarnings ?? [];
  const pendingCount = view ? orderSuggestions(view).pending.length : 0;
  const openThreads = view ? orderThreads(view).open.length : 0;
  const name = baseName(docPath);

  const toggles: Array<{ id: Exclude<Panel, 'text'>; label: string }> = [
    { id: 'suggestions', label: pendingCount > 0 ? `Suggestions ${pendingCount}` : 'Suggestions' },
    { id: 'comments', label: openThreads > 0 ? `Comments ${openThreads}` : 'Comments' },
    { id: 'history', label: 'History' },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <HostToolHeader
        title={dirty ? `${name} ●` : name}
        hostName={docPath}
        onBack={() => void leave()}
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {loaded !== null ? (
              <Pressable
                testID="doc-export"
                accessibilityRole="button"
                accessibilityLabel="Export"
                onPress={() => setExportOpen(true)}
                style={{ padding: space.sm }}
              >
                <Download size={22} color={colors.leaf} />
              </Pressable>
            ) : null}
            <Pressable
              testID="doc-save"
              accessibilityRole="button"
              accessibilityLabel="Save"
              accessibilityState={{ disabled: !dirty || saving }}
              disabled={!dirty || saving}
              onPress={() => void save()}
              style={{
                paddingHorizontal: space.md,
                paddingVertical: space.xs,
                marginRight: space.xs,
                borderRadius: radii.md,
                backgroundColor: dirty ? colors.leaf : colors.paperRaised,
                opacity: saving ? 0.6 : 1,
              }}
            >
              <Text
                style={{ color: dirty ? colors.onAccent : colors.ink3, fontFamily: fonts.bodyBold }}
              >
                {saving ? 'Saving…' : 'Save'}
              </Text>
            </Pressable>
          </View>
        }
      />
      <AnchoredMenu
        visible={exportOpen}
        items={EXPORT_FORMATS.map((f) => ({
          id: f,
          label: EXPORT_LABEL[f],
          testID: `doc-export-${f}`,
        }))}
        onSelect={(id) => void exportAs(id as ExportFormat)}
        onDismiss={() => setExportOpen(false)}
      />
      {loadError !== null ? (
        <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md }}>
          <Text testID="doc-error" style={{ color: colors.red }}>
            {loadError}
          </Text>
          <Pressable
            testID="doc-retry"
            accessibilityRole="button"
            accessibilityLabel="Retry"
            onPress={() => void load()}
            style={{
              alignSelf: 'flex-start',
              paddingHorizontal: space.md,
              paddingVertical: space.xs,
              borderRadius: radii.md,
              backgroundColor: colors.paperRaised,
            }}
          >
            <Text style={{ color: colors.ink, fontFamily: fonts.bodyBold }}>Retry</Text>
          </Pressable>
        </View>
      ) : loaded === null || view === null ? (
        <ActivityIndicator testID="doc-loading" color={colors.leaf} style={{ margin: space.xl }} />
      ) : (
        <>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: space.sm,
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
            }}
          >
            <DocModePicker
              mode={view.mode}
              onChange={(mode) => dispatch({ op: 'set_mode', mode })}
            />
            {toggles.map((t) => {
              const on = panel === t.id;
              return (
                <Pressable
                  key={t.id}
                  testID={`doc-toggle-${t.id}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => setPanel(on ? 'text' : t.id)}
                  style={{
                    paddingHorizontal: space.md,
                    paddingVertical: space.xs,
                    borderRadius: radii.pill,
                    borderWidth: 1,
                    borderColor: on ? colors.leaf : colors.divider,
                    backgroundColor: on ? colors.accentTint : 'transparent',
                  }}
                >
                  <Text
                    style={{
                      color: on ? colors.leaf : colors.ink2,
                      fontFamily: fonts.bodyMedium,
                      fontSize: textMin,
                    }}
                  >
                    {t.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {warnings.length > 0 ? (
            <View
              testID="doc-warnings"
              style={{ paddingHorizontal: space.md, paddingBottom: space.sm }}
            >
              {warnings.map((w) => (
                <Text key={w} style={{ color: colors.ink3, fontSize: textMin }}>
                  {w}
                </Text>
              ))}
            </View>
          ) : null}
          {notice !== null || exportWarnings.length > 0 ? (
            <View
              testID="doc-notice"
              style={{ paddingHorizontal: space.md, paddingBottom: space.sm }}
            >
              {notice !== null ? (
                <Text style={{ color: colors.leaf, fontSize: textMin }}>{notice}</Text>
              ) : null}
              {exportWarnings.map((w) => (
                <Text key={w} style={{ color: colors.ink3, fontSize: textMin }}>
                  {w}
                </Text>
              ))}
            </View>
          ) : null}
          {panel === 'text' && selected.length > 0 ? (
            commentDraft === null ? (
              <View
                style={{
                  flexDirection: 'row',
                  gap: space.sm,
                  paddingHorizontal: space.md,
                  paddingBottom: space.sm,
                }}
              >
                <SelectionButton testID="doc-ask" label="Ask about this" onPress={ask} />
                <SelectionButton
                  testID="doc-comment"
                  label="Comment"
                  onPress={() => setCommentDraft('')}
                />
              </View>
            ) : (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.sm,
                  paddingHorizontal: space.md,
                  paddingBottom: space.sm,
                }}
              >
                <TextInput
                  testID="doc-comment-input"
                  value={commentDraft}
                  onChangeText={setCommentDraft}
                  placeholder="Comment"
                  placeholderTextColor={colors.ink3}
                  style={{
                    flex: 1,
                    color: colors.ink,
                    borderWidth: 1,
                    borderColor: colors.divider,
                    borderRadius: radii.md,
                    paddingHorizontal: space.sm,
                    paddingVertical: space.xs,
                  }}
                />
                <SelectionButton testID="doc-comment-submit" label="Add" onPress={submitComment} />
                <SelectionButton
                  testID="doc-comment-cancel"
                  label="Cancel"
                  onPress={() => setCommentDraft(null)}
                />
              </View>
            )
          ) : null}
          {panel === 'text' ? (
            <TextInput
              testID="doc-text"
              value={text}
              onChangeText={setText}
              onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
              multiline
              autoCorrect={false}
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="off"
              textAlignVertical="top"
              scrollEnabled
              style={{
                flex: 1,
                color: colors.ink,
                fontFamily: fonts.mono,
                fontSize: textMin,
                paddingHorizontal: space.md,
                paddingVertical: space.sm,
              }}
            />
          ) : panel === 'suggestions' ? (
            <SuggestionsPanel view={view} dispatch={dispatch} />
          ) : panel === 'comments' ? (
            <CommentsPanel view={view} dispatch={dispatch} />
          ) : (
            <HistoryPanel view={view} dispatch={dispatch} />
          )}
        </>
      )}
    </View>
  );
}

function SelectionButton({
  testID,
  label,
  onPress,
}: {
  testID: string;
  label: string;
  onPress: () => void;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.leaf,
      }}
    >
      <Text style={{ color: colors.leaf, fontFamily: fonts.bodyMedium, fontSize: textMin }}>
        {label}
      </Text>
    </Pressable>
  );
}
