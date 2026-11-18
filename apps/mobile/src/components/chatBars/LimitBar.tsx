// LimitBar — what happens next for a chat paused on a usage limit or stopped
// for credit (spec/12 § A usage or rate limit; spec/10 § When an account hits a
// limit). The host decides and says it in `limitNext`; this only reads it. A
// chat that will run again by itself shows no button; one waiting for the user
// offers Continue, which re-sends the owed turn (`chat.resume_now_request`).

import React, { type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ChatRow } from '../../stores/types';
import { getWs } from '../../api/ws';
import { fonts, space, textMin, useTheme } from '../../lib/theme';
import { BarShell } from './BarShell';

/** The bar's one line, or null when the chat has no limit to speak about. */
export function limitBarText(
  row: Pick<ChatRow, 'limitNext' | 'creditReturned' | 'resumeKind'>,
): { text: string; canContinue: boolean } | null {
  if (row.creditReturned === true) {
    return { text: 'Credit available again', canContinue: true };
  }
  if (row.resumeKind === 'overloaded') return null;
  switch (row.limitNext) {
    case 'resume_at_reset':
      return { text: 'Usage limit · resumes when it resets', canContinue: false };
    case 'other_account':
      return { text: 'Usage limit · continues on the next account with room', canContinue: false };
    case 'switch_provider':
      return { text: 'Usage limit · switch provider from the model menu', canContinue: true };
    case 'ask':
      return { text: 'Out of credit · nothing runs until you continue', canContinue: true };
    default:
      return null;
  }
}

export function LimitBar({ row }: { row: ChatRow }): ReactElement | null {
  const colors = useTheme();
  const shown = limitBarText(row);
  if (shown === null) return null;
  return (
    <BarShell testID="limit-bar">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Text
          testID="limit-bar-text"
          style={{ flex: 1, color: colors.ink2, fontSize: textMin, fontFamily: fonts.bodyMedium }}
        >
          {shown.text}
        </Text>
        {shown.canContinue ? (
          <Pressable
            testID="limit-bar-continue"
            accessibilityRole="button"
            accessibilityLabel="Continue"
            onPress={() => getWs().send({ type: 'chat.resume_now_request', chatId: row.chatId })}
            hitSlop={8}
          >
            <Text style={{ color: colors.leaf, fontSize: textMin, fontFamily: fonts.bodyMedium }}>
              Continue
            </Text>
          </Pressable>
        ) : null}
      </View>
    </BarShell>
  );
}
