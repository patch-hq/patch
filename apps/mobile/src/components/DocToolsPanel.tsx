// Document editor tools (spec/14 § Document editor, step 2 of 3; spec/15 §
// Document editor): the mode picker and the Suggestions, Comments and History
// panels that swap in for the text. The phone twin of web's DocToolsPanel.
//
// Purely presentational. Every press hands ONE DocAction to `dispatch`; the
// screen sends it to the host and replaces its view with the host's answer, so
// none of these keeps a copy of the view (only a reply draft / a selection).

import React from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { DocAction, DocMode, DocView } from '@patch/wire';
import { OptionPicker } from './OptionPicker';
import { DOC_MODES, orderSuggestions, orderThreads, versionsNewestFirst } from '../lib/docEditor';
import { fonts, radii, space, textMin, useTheme } from '../lib/theme';

export interface DocPanelProps {
  view: DocView;
  dispatch: (action: DocAction) => void;
}

export function DocModePicker({
  mode,
  onChange,
  disabled,
}: {
  mode: DocMode;
  onChange: (mode: DocMode) => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <OptionPicker
      testID="doc-mode-select"
      selectedId={mode}
      selectedLabel={DOC_MODES.find((m) => m.id === mode)?.label ?? mode}
      options={[...DOC_MODES]}
      onSelect={(id) => onChange(id as DocMode)}
      emptyText="No modes"
      disabled={disabled === true}
    />
  );
}

function TextButton({
  testID,
  label,
  onPress,
  primary,
}: {
  testID: string;
  label: string;
  onPress: () => void;
  primary?: boolean;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: primary ? colors.leaf : colors.divider,
        backgroundColor: pressed ? colors.accentTint : 'transparent',
      })}
    >
      <Text
        style={{
          color: primary ? colors.leaf : colors.ink2,
          fontFamily: fonts.bodyMedium,
          fontSize: textMin,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Empty({ text }: { text: string }): React.ReactElement {
  const colors = useTheme();
  return <Text style={{ color: colors.ink3, padding: space.lg, fontSize: textMin }}>{text}</Text>;
}

export function SuggestionsPanel({ view, dispatch }: DocPanelProps): React.ReactElement {
  const colors = useTheme();
  const { pending, all } = orderSuggestions(view);
  return (
    <ScrollView testID="doc-suggestions-panel" contentContainerStyle={{ paddingBottom: space.xl }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: space.md,
        }}
      >
        <Text style={{ color: colors.ink, fontFamily: fonts.bodyBold }}>
          {`${pending.length} pending`}
        </Text>
        {pending.length > 0 ? (
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <TextButton
              testID="doc-suggestions-accept-all"
              label="Accept all"
              primary
              onPress={() => dispatch({ op: 'accept_all' })}
            />
            <TextButton
              testID="doc-suggestions-reject-all"
              label="Reject all"
              onPress={() => dispatch({ op: 'reject_all' })}
            />
          </View>
        ) : null}
      </View>
      {all.length === 0 ? (
        <Empty text="No suggestions" />
      ) : (
        all.map((s) => (
          <View
            key={s.id}
            testID={`doc-suggestion-${s.id}`}
            style={{
              padding: space.md,
              gap: space.sm,
              borderTopWidth: 1,
              borderColor: colors.divider,
              opacity: s.status === 'pending' ? 1 : 0.6,
            }}
          >
            <Text style={{ color: colors.red, textDecorationLine: 'line-through' }}>{s.find}</Text>
            <Text style={{ color: colors.leaf }}>{s.replace === '' ? '(deleted)' : s.replace}</Text>
            {s.status === 'pending' ? (
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <TextButton
                  testID={`doc-suggestion-accept-${s.id}`}
                  label="Accept"
                  primary
                  onPress={() => dispatch({ op: 'accept_suggestion', id: s.id })}
                />
                <TextButton
                  testID={`doc-suggestion-reject-${s.id}`}
                  label="Reject"
                  onPress={() => dispatch({ op: 'reject_suggestion', id: s.id })}
                />
              </View>
            ) : (
              <Text style={{ color: colors.ink3, fontSize: textMin }}>{s.status}</Text>
            )}
          </View>
        ))
      )}
    </ScrollView>
  );
}

function ThreadCard({
  thread,
  dispatch,
}: {
  thread: DocView['threads'][number];
  dispatch: (action: DocAction) => void;
}): React.ReactElement {
  const colors = useTheme();
  const [reply, setReply] = React.useState('');
  const sendReply = (): void => {
    if (reply.trim().length === 0) return;
    dispatch({ op: 'reply_comment', threadId: thread.id, text: reply });
    setReply('');
  };
  return (
    <View
      testID={`doc-thread-${thread.id}`}
      style={{
        padding: space.md,
        gap: space.sm,
        borderTopWidth: 1,
        borderColor: colors.divider,
        opacity: thread.resolved ? 0.6 : 1,
      }}
    >
      <Text style={{ color: colors.ink3, fontStyle: 'italic' }} numberOfLines={3}>
        {`"${thread.anchor}"`}
      </Text>
      {thread.comments.map((c) => (
        <View key={c.id} style={{ gap: 2 }}>
          <Text style={{ color: colors.ink3, fontSize: textMin }}>
            {c.author === 'agent' ? 'Agent' : 'You'}
          </Text>
          <Text style={{ color: colors.ink }}>{c.text}</Text>
        </View>
      ))}
      {!thread.resolved ? (
        <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
          <TextInput
            testID={`doc-thread-reply-input-${thread.id}`}
            value={reply}
            onChangeText={setReply}
            placeholder="Reply"
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
          <TextButton
            testID={`doc-thread-reply-submit-${thread.id}`}
            label="Reply"
            primary
            onPress={sendReply}
          />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row' }}>
        <TextButton
          testID={`doc-thread-resolve-${thread.id}`}
          label={thread.resolved ? 'Reopen' : 'Resolve'}
          onPress={() =>
            dispatch({ op: 'resolve_comment', threadId: thread.id, resolved: !thread.resolved })
          }
        />
      </View>
    </View>
  );
}

export function CommentsPanel({ view, dispatch }: DocPanelProps): React.ReactElement {
  const { all } = orderThreads(view);
  return (
    <ScrollView
      testID="doc-comments-panel"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: space.xl }}
    >
      {all.length === 0 ? (
        <Empty text="No comments" />
      ) : (
        all.map((t) => <ThreadCard key={t.id} thread={t} dispatch={dispatch} />)
      )}
    </ScrollView>
  );
}

export function HistoryPanel({ view, dispatch }: DocPanelProps): React.ReactElement {
  const colors = useTheme();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const versions = versionsNewestFirst(view);
  const selected = versions.find((v) => v.id === selectedId) ?? null;
  return (
    <ScrollView testID="doc-history-panel" contentContainerStyle={{ paddingBottom: space.xl }}>
      {versions.length === 0 ? (
        <Empty text="No history" />
      ) : (
        versions.map((v) => (
          <Pressable
            key={v.id}
            testID={`doc-history-row-${v.id}`}
            accessibilityRole="button"
            onPress={() => setSelectedId(v.id)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
              paddingVertical: space.sm,
              paddingHorizontal: space.md,
              backgroundColor: selectedId === v.id ? colors.accentTint : 'transparent',
            }}
          >
            <Text style={{ color: colors.ink, fontFamily: fonts.bodyMedium }}>
              {v.savedBy === 'agent' ? 'Agent' : 'You'}
            </Text>
            <Text style={{ color: colors.ink3, fontSize: textMin, flex: 1 }}>
              {new Date(v.createdAt).toLocaleString()}
            </Text>
            {v.restoredFrom ? (
              <Text style={{ color: colors.ink3, fontSize: textMin }}>restored</Text>
            ) : null}
          </Pressable>
        ))
      )}
      {selected ? (
        <View
          style={{
            padding: space.md,
            gap: space.sm,
            borderTopWidth: 1,
            borderColor: colors.divider,
          }}
        >
          <Text testID="doc-history-content" style={{ color: colors.ink, fontFamily: fonts.mono }}>
            {selected.content}
          </Text>
          <View style={{ flexDirection: 'row' }}>
            <TextButton
              testID="doc-history-restore"
              label="Restore"
              primary
              onPress={() => dispatch({ op: 'restore_version', versionId: selected.id })}
            />
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}
