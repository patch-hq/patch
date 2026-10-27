// AccountUsageStrip — the new-chat screen's usage block (spec/15 § New chat
// flow → Usage): one read-only card per connected subscription account,
// beneath the rows and apart from them, with the 5-hour and weekly windows as
// bars and the figure said in words beside each (`79% used · resets 14:00`),
// so a bar is never read backwards. The same freshest-reading rule as
// Settings → Usage. Four accounts at a time; the rest are a page away.

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { rateLimitWindowState, type RateLimitWindow } from '@patch/wire';
import { getWs } from '../api/ws';
import { usePresenceStore } from '../stores/presenceStore';
import { useUiStore } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import { formatReset } from '../lib/usage';
import { fonts, radii, space, textMin, useTheme, type ThemeColors } from '../lib/theme';

const BACKENDS = [
  { id: 'claude-code', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
] as const;

/** How many accounts show at once; the rest are a page away. */
export const USAGE_PAGE_SIZE = 4;

const METERS = [
  { scope: 'session', label: '5-hour' },
  { scope: 'week', label: 'Week' },
] as const;

type Usage = { session?: RateLimitWindow; week?: RateLimitWindow; at?: number } | undefined;
interface Row {
  key: string;
  label: string;
  backendId: string;
  backend: string;
  usage: Usage;
}

export function AccountUsageStrip(): React.ReactElement | null {
  const colors = useTheme();
  const secrets = useSettingsStore((s) => s.data?.shared?.secrets);
  const hosts = usePresenceStore((s) => s.hosts);
  const [page, setPage] = React.useState(0);
  const asked = React.useRef(new Set<string>());
  const rows: Row[] = [];
  for (const { id, name } of BACKENDS) {
    const accounts = secrets ? (id === 'claude-code' ? secrets.claude : secrets.codex) : [];
    for (const a of accounts) {
      if (!a.connected || ('kind' in a && a.kind === 'apiKey')) continue;
      let usage: Usage;
      let readAt = -1;
      for (const h of Object.values(hosts)) {
        const u = h.accounts[id]?.accounts?.find((x) => x.id === a.id)?.usage;
        if (u && (u.at ?? 0) > readAt) {
          usage = u;
          readAt = u.at ?? 0;
        }
      }
      rows.push({ key: `${id}-${a.id}`, label: a.label, backendId: id, backend: name, usage });
    }
  }
  // Usage is always available: an account no host has a reading for yet makes
  // every online host read its backend now, once per (host, backend), rather
  // than waiting for the host's own poll.
  const unread = rows.filter((r) => r.usage === undefined).map((r) => r.backendId);
  const wanted = [...new Set(unread)].flatMap((backendId) =>
    Object.values(hosts)
      .filter((h) => h.online)
      .map((h) => ({ hostId: h.hostId, backendId })),
  );
  const wantedKey = wanted.map((w) => `${w.hostId}/${w.backendId}`).join(',');
  React.useEffect(() => {
    for (const w of wanted) {
      const key = `${w.hostId}/${w.backendId}`;
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      try {
        getWs().send({
          type: 'host.backend_usage_refresh',
          hostId: w.hostId,
          backendId: w.backendId,
        });
      } catch (e) {
        useUiStore.getState().pushError(`usage refresh failed: ${(e as Error).message}`);
      }
    }
  }, [wantedKey]);
  if (rows.length === 0) return null;
  const pages = Math.ceil(rows.length / USAGE_PAGE_SIZE);
  // An account disconnected while a later page was showing: stay on a real one.
  const current = Math.min(page, pages - 1);
  const first = current * USAGE_PAGE_SIZE;
  const shown = rows.slice(first, first + USAGE_PAGE_SIZE);
  return (
    <View
      testID="new-chat-usage"
      style={{
        marginTop: space.lg,
        marginHorizontal: space.lg,
        paddingTop: space.md,
        borderTopWidth: 1,
        borderTopColor: colors.lineSoft,
        gap: space.sm,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: colors.ink3, fontSize: textMin, fontFamily: fonts.bodyMedium }}>
          Usage
        </Text>
        {pages > 1 ? (
          <View
            testID="new-chat-usage-pager"
            style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}
          >
            <PagerButton
              glyph="‹"
              testID="new-chat-usage-prev"
              accessibilityLabel="Previous accounts"
              disabled={current === 0}
              onPress={() => setPage(current - 1)}
              colors={colors}
            />
            <Text testID="new-chat-usage-page" style={{ color: colors.ink3, fontSize: textMin }}>
              {first + 1}–{first + shown.length} of {rows.length}
            </Text>
            <PagerButton
              glyph="›"
              testID="new-chat-usage-next"
              accessibilityLabel="Next accounts"
              disabled={current === pages - 1}
              onPress={() => setPage(current + 1)}
              colors={colors}
            />
          </View>
        ) : null}
      </View>
      {shown.map((r) => (
        <UsageCard key={r.key} row={r} colors={colors} />
      ))}
    </View>
  );
}

function PagerButton({
  glyph,
  testID,
  accessibilityLabel,
  disabled,
  onPress,
  colors,
}: {
  glyph: string;
  testID: string;
  accessibilityLabel: string;
  disabled: boolean;
  onPress: () => void;
  colors: ThemeColors;
}): React.ReactElement {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minWidth: 28,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: colors.divider,
        borderRadius: radii.pill,
        backgroundColor: colors.paperRaised,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text style={{ color: colors.ink2, fontSize: 16, lineHeight: 18 }}>{glyph}</Text>
    </Pressable>
  );
}

function UsageCard({ row, colors }: { row: Row; colors: ThemeColors }): React.ReactElement {
  return (
    <View
      testID={`new-chat-usage-${row.key}`}
      style={{
        borderWidth: 1,
        borderColor: colors.lineSoft,
        borderRadius: radii.lg,
        backgroundColor: colors.paperRaised,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        gap: space.xs,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.sm }}>
        <Text
          numberOfLines={1}
          style={{
            color: colors.ink,
            fontSize: textMin,
            fontFamily: fonts.bodyMedium,
            flexShrink: 1,
          }}
        >
          {row.label}
        </Text>
        <Text style={{ color: colors.inkFaint, fontSize: textMin }}>{row.backend}</Text>
      </View>
      {row.usage === undefined ? (
        <Text style={{ color: colors.ink3, fontSize: textMin }}>not read yet</Text>
      ) : (
        METERS.map(({ scope, label }) => (
          <Meter key={scope} scope={scope} label={label} win={row.usage?.[scope]} colors={colors} />
        ))
      )}
    </View>
  );
}

/** One window as a bar with its figure in words; a missing window says so. */
function Meter({
  scope,
  label,
  win,
  colors,
}: {
  scope: 'session' | 'week';
  label: string;
  win: RateLimitWindow | undefined;
  colors: ThemeColors;
}): React.ReactElement {
  const figure = (): string => {
    if (win === undefined) return 'not reported';
    const state = rateLimitWindowState(scope, win);
    const pct = Math.round((win.utilization ?? 0) * 100);
    const used =
      win.utilization === undefined
        ? win.status === 'rejected'
          ? 'blocked'
          : 'no figure'
        : `${pct}% used${state === 'blocked' ? ' · blocked' : ''}`;
    return win.resetsAt !== undefined ? `${used} · resets ${formatReset(win.resetsAt)}` : used;
  };
  const state = win === undefined ? 'ok' : rateLimitWindowState(scope, win);
  const fill = state === 'blocked' ? colors.red : state === 'warn' ? colors.amber : colors.leaf;
  const pct = Math.round((win?.utilization ?? 0) * 100);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <Text style={{ color: colors.ink3, fontSize: textMin, width: 52 }}>{label}</Text>
      {win === undefined ? null : (
        <View
          accessibilityElementsHidden
          style={{
            flex: 1,
            height: 8,
            borderRadius: 4,
            backgroundColor: colors.lineSoft,
            overflow: 'hidden',
          }}
        >
          <View style={{ width: `${pct}%`, height: '100%', backgroundColor: fill }} />
        </View>
      )}
      <Text
        style={{ color: colors.ink3, fontSize: textMin, flexShrink: win === undefined ? 1 : 0 }}
      >
        {figure()}
      </Text>
    </View>
  );
}
