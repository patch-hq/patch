// Settings → Usage on mobile: how the weekly allowance went down over a chosen
// period, and which chats spent the tokens. Read through every online host
// (GET /api/usage-report); mirrors web's UsageHistory.

import React from 'react';
import { View } from 'react-native';
import Svg, { Line, Polyline } from 'react-native-svg';
import { api } from '../../api/rest';
import { formatTokens } from '../../lib/contextUsage';
import { space, useTheme } from '../../lib/theme';
import {
  USAGE_PERIODS,
  buildBurndown,
  pageOf,
  periodWindow,
  type UsagePeriod,
} from '../../lib/usageHistory';
import { SettingsSection } from '../SettingsSection';
import { Chips, ErrorLine, Field, Muted, Row, SettingsButton } from './ui';

type Report = Awaited<ReturnType<typeof api.usageReport>>;

const W = 320;
const H = 140;
const LABELS: Record<UsagePeriod, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  custom: 'Custom',
};

export function UsageHistorySection(): React.ReactElement {
  const colors = useTheme();
  const palette = [colors.leaf, colors.amber, colors.red, colors.ink3];
  const [period, setPeriod] = React.useState<UsagePeriod>('week');
  const [custom, setCustom] = React.useState({ from: '', to: '' });
  const [now] = React.useState(() => Date.now());
  const [state, setState] = React.useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; report: Report }
  >({ kind: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const [chatPage, setChatPage] = React.useState(0);
  const win = periodWindow(period, now, custom);
  const since = win?.since;
  const until = win?.until;

  React.useEffect(() => {
    if (since === undefined || until === undefined) return;
    let live = true;
    setState({ kind: 'loading' });
    api
      .usageReport({ since, until })
      .then((report) => live && setState({ kind: 'ok', report }))
      .catch(
        (err: unknown) =>
          live &&
          setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
    return () => {
      live = false;
    };
  }, [since, until, attempt]);

  const series = state.kind === 'ok' ? buildBurndown(state.report.samples) : [];
  const x = (ts: number): number => ((ts - since!) / (until! - since!)) * W;
  const y = (pct: number): number => (1 - pct / 100) * H;

  return (
    <>
      <SettingsSection title="Allowance left" testID="usage-history">
        <Row
          title="Period"
          stack
          right={
            <Chips
              options={USAGE_PERIODS}
              selected={period}
              onSelect={(p) => {
                setPeriod(p);
                setChatPage(0);
              }}
              testIDPrefix="usage-period"
              labelPrefix="Period"
              labelOf={(p) => LABELS[p]}
            />
          }
        />
        {period === 'custom' ? (
          <Row
            title="Range"
            stack
            right={
              <View style={{ flexDirection: 'row', gap: space.xs }}>
                <Field
                  testID="usage-from"
                  placeholder="From YYYY-MM-DD"
                  value={custom.from}
                  onChangeText={(from) => setCustom({ ...custom, from })}
                />
                <Field
                  testID="usage-to"
                  placeholder="To YYYY-MM-DD"
                  value={custom.to}
                  onChangeText={(to) => setCustom({ ...custom, to })}
                />
              </View>
            }
          />
        ) : null}
        {win === null ? (
          <Muted testID="usage-pick-range">Pick a start and end date</Muted>
        ) : state.kind === 'error' ? (
          <ErrorLine
            testID="usage-history-error"
            message={`Couldn’t read usage: ${state.message}`}
            onRetry={() => setAttempt((a) => a + 1)}
          />
        ) : state.kind === 'loading' ? (
          <Muted>Loading…</Muted>
        ) : series.length === 0 ? (
          <Muted testID="usage-history-empty">No readings in this period</Muted>
        ) : (
          <View testID="usage-burndown">
            <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
              {[0, 50, 100].map((p) => (
                <Line
                  key={p}
                  x1={0}
                  x2={W}
                  y1={y(p)}
                  y2={y(p)}
                  stroke={colors.divider}
                  strokeWidth={1}
                />
              ))}
              {series.map((s, i) => (
                <Polyline
                  key={s.key}
                  testID={`usage-line-${s.key}`}
                  fill="none"
                  stroke={palette[i % palette.length]}
                  strokeWidth={2}
                  points={s.points.map((p) => `${x(p.ts)},${y(p.remaining)}`).join(' ')}
                />
              ))}
            </Svg>
            <Muted testID="usage-legend">{series.map((s) => s.label).join(' · ')}</Muted>
          </View>
        )}
      </SettingsSection>
      <SettingsSection title="Chats by tokens" testID="usage-chats">
        {win === null || state.kind !== 'ok' ? null : state.report.chats.length > 0 ? (
          (() => {
            const paged = pageOf(state.report.chats, chatPage);
            return (
              <>
                {paged.rows.map((c) => (
                  <Row
                    key={`${c.hostId}/${c.chatId}`}
                    title={c.name ?? c.chatId}
                    testID={`usage-chat-${c.chatId}`}
                    right={
                      <Muted testID={`usage-chat-tokens-${c.chatId}`}>
                        {formatTokens(c.tokens)}
                      </Muted>
                    }
                  />
                ))}
                {paged.pages > 1 ? (
                  <Row
                    title={`Page ${paged.page + 1} of ${paged.pages}`}
                    testID="usage-chats-pager"
                    right={
                      <View style={{ flexDirection: 'row', gap: space.xs }}>
                        <SettingsButton
                          testID="usage-chats-prev"
                          label="Previous"
                          variant="quiet"
                          disabled={paged.page === 0}
                          onPress={() => setChatPage(paged.page - 1)}
                        />
                        <SettingsButton
                          testID="usage-chats-next"
                          label="Next"
                          variant="quiet"
                          disabled={paged.page >= paged.pages - 1}
                          onPress={() => setChatPage(paged.page + 1)}
                        />
                      </View>
                    }
                  />
                ) : null}
              </>
            );
          })()
        ) : (
          <Muted testID="usage-chats-empty">No chat turns in this period</Muted>
        )}
      </SettingsSection>
    </>
  );
}
