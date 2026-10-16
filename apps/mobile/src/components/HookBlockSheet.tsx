// The block / failure sheet above the composer (spec/20-hooks.md § On the
// user's message, spec/15 § Composer — Message hooks). Shown instead of
// sending when a hook check comes back `block`: the message stays in the
// composer and this names why, one entry per hook that blocked or failed, with
// Use suggestion / Edit / Send anyway — the same three actions as web.

import React from 'react';
import { Text, View } from 'react-native';
import type { HookRunResult } from '@patch/wire/hooks';
import { radii, space, typography, useTheme } from '../lib/theme';
import { ButtonRow, SettingsButton } from './settings/ui';

export function HookBlockSheet({
  results,
  onUseSuggestion,
  onEdit,
  onSendAnyway,
}: {
  results: HookRunResult[];
  onUseSuggestion: (suggestion: string) => void;
  onEdit: () => void;
  onSendAnyway: () => void;
}): React.ReactElement {
  const colors = useTheme();
  return (
    <View
      testID="hook-block-sheet"
      accessibilityRole="alert"
      style={{
        backgroundColor: colors.paper,
        borderRadius: radii.md,
        padding: space.md,
        gap: space.sm,
        marginBottom: space.xs,
      }}
    >
      {results.map((r) => (
        <View key={r.hookId} testID={`hook-block-entry-${r.hookId}`} style={{ gap: space.xs }}>
          <Text style={{ ...typography.secondary, color: colors.ink }}>{r.hookName}</Text>
          {r.status === 'ok' ? (
            <Text testID="hook-block-analysis" style={{ ...typography.body, color: colors.ink2 }}>
              {r.analysis}
            </Text>
          ) : (
            <Text testID="hook-block-error" style={{ ...typography.body, color: colors.ink2 }}>
              {r.status === 'timeout' ? 'Timed out' : 'Failed'}
              {r.error ? `: ${r.error}` : ''}
            </Text>
          )}
          {r.status === 'ok' && r.suggestion ? (
            <SettingsButton
              testID={`hook-use-suggestion-${r.hookId}`}
              label="Use suggestion"
              variant="quiet"
              onPress={() => onUseSuggestion(r.suggestion as string)}
            />
          ) : null}
        </View>
      ))}
      <ButtonRow>
        <SettingsButton testID="hook-block-edit" label="Edit" variant="quiet" onPress={onEdit} />
        <SettingsButton
          testID="hook-block-send-anyway"
          label="Send anyway"
          onPress={onSendAnyway}
        />
      </ButtonRow>
    </View>
  );
}
