// BrowserHandoffBar — the agent's browser while it works out of sight (spec/15
// § Browser): one slim row at the top of the chat saying what it is using the
// browser for (the same line its tool run shows), on which site, for how long,
// and a Stop. A tap brings the live card up above the composer; when the agent
// needs the user it says so and opens the browser. Mirrors the web's bar.
//
// It sits in the chat column above the transcript, never against the bottom of
// the window, so the system navigation bar is already cleared by the composer.

import React, { type ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { X } from 'lucide-react-native';
import { getWs } from '../../api/ws';
import { useBrowserHandoffStore } from '../../stores/browserHandoffStore';
import { useChatStore } from '../../stores/chatStore';
import {
  browsingSummary,
  canStopBrowser,
  driveState,
  formatElapsed,
  siteOf,
  viewedTab,
} from '../../lib/browserHandoff';
import { useNow } from '../../lib/browserView';
import { radii, space, textMin, useTheme } from '../../lib/theme';
import { SiteTile, TOUCH_TARGET } from '../browser/parts';

export function BrowserHandoffBar({ chatId }: { chatId: string }): ReactElement | null {
  const colors = useTheme();
  const handoff = useBrowserHandoffStore((s) => s.handoffs[chatId]);
  const frame = useBrowserHandoffStore((s) => s.frames[chatId]);
  const status = useBrowserHandoffStore((s) => s.status[chatId]);
  const view = useBrowserHandoffStore((s) => s.views[chatId]);
  const setView = useBrowserHandoffStore((s) => s.setView);
  const timeline = useChatStore((s) => s.timelines[chatId]);
  const summaries = useChatStore((s) => s.toolRunSummaries[chatId]);
  const open = Boolean(status) || Boolean(handoff);
  const now = useNow(open && view === undefined);
  // The card or the open view is showing it already.
  if (!open || view !== undefined) return null;

  const tabId = viewedTab(handoff, frame, status);
  const state = driveState(handoff, status, tabId);
  const site = siteOf(status?.tabs.find((t) => t.tabId === tabId)?.url ?? frame?.url ?? '');
  const summary = browsingSummary(timeline ?? [], summaries) ?? status?.action ?? site;
  const elapsed = status?.since !== undefined ? formatElapsed(now - status.since) : null;
  const stoppable = canStopBrowser(status);

  return (
    <View
      testID="browser-watch-bar"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        marginHorizontal: space.md,
        marginTop: space.xs,
        paddingLeft: space.md,
        minHeight: TOUCH_TARGET,
        backgroundColor: colors.paperRaised,
        borderWidth: 1,
        borderColor: colors.lineSoft,
        borderRadius: radii.md,
      }}
    >
      {site ? <SiteTile site={site} /> : null}
      <Pressable
        testID="browser-status"
        accessibilityRole="button"
        accessibilityLabel={state === 'needs' ? 'Open the browser' : 'Watch the browser'}
        onPress={() => setView(chatId, state === 'needs' ? 'open' : 'card')}
        style={{ flex: 1, minHeight: TOUCH_TARGET, justifyContent: 'center' }}
      >
        <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: textMin }}>
          {state === 'needs' && handoff ? (
            <Text style={{ color: colors.waiting, fontWeight: '600' }}>
              Needs you ·{' '}
              <Text style={{ color: colors.ink2, fontWeight: '400' }}>{handoff.reason}</Text>
            </Text>
          ) : (
            summary
          )}
        </Text>
      </Pressable>
      {elapsed ? (
        <Text
          testID="browser-elapsed"
          style={{ color: colors.inkFaint, fontSize: textMin, fontVariant: ['tabular-nums'] }}
        >
          {elapsed}
        </Text>
      ) : null}
      {stoppable ? (
        <Pressable
          testID="browser-stop"
          accessibilityRole="button"
          accessibilityLabel="Stop browsing"
          onPress={() => getWs().safeSend({ type: 'patch.browser_view.stop', chatId })}
          style={{
            minHeight: TOUCH_TARGET,
            minWidth: TOUCH_TARGET,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <X size={18} color={colors.ink3} />
        </Pressable>
      ) : (
        <View style={{ width: space.sm }} />
      )}
    </View>
  );
}
