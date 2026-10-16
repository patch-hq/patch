// Settings → Usage: how the weekly allowance went down over a period, and
// which chats spent the tokens. Both are read through every online machine
// (GET /api/usage-report).

import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/rest.js';
import { formatTokens } from '../../lib/usage.js';
import {
  USAGE_PERIODS,
  buildBurndown,
  periodWindow,
  type BurndownSeries,
  type UsagePeriod,
} from '../../lib/usageHistory.js';
import { Group, Note, Pills, Row } from './ui.js';

const W = 640;
const H = 200;
const PAD = { l: 36, r: 8, t: 8, b: 20 };
const COLOURS = ['#4f8cff', '#e8833a', '#3fb67a', '#b06be0'];

function Burndown({
  series,
  since,
  until,
}: {
  series: BurndownSeries[];
  since: number;
  until: number;
}): JSX.Element {
  const x = (ts: number): number => PAD.l + ((ts - since) / (until - since)) * (W - PAD.l - PAD.r);
  const y = (pct: number): number => PAD.t + (1 - pct / 100) * (H - PAD.t - PAD.b);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Weekly allowance remaining"
      data-testid="usage-burndown"
      style={{ width: '100%', height: 'auto' }}
    >
      {[0, 50, 100].map((p) => (
        <g key={p}>
          <line
            x1={PAD.l}
            x2={W - PAD.r}
            y1={y(p)}
            y2={y(p)}
            stroke="currentColor"
            opacity={0.15}
          />
          <text x={PAD.l - 4} y={y(p) + 4} textAnchor="end" fontSize={11} fill="currentColor">
            {p}%
          </text>
        </g>
      ))}
      {[since, (since + until) / 2, until].map((ts, i) => (
        <text
          key={i}
          x={x(ts)}
          y={H - 4}
          fontSize={11}
          fill="currentColor"
          textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
        >
          {new Date(ts).toLocaleString(undefined, {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </text>
      ))}
      {series.map((s, i) => (
        <polyline
          key={s.key}
          data-testid={`usage-line-${s.key}`}
          fill="none"
          stroke={COLOURS[i % COLOURS.length]}
          strokeWidth={2}
          points={s.points.map((p) => `${x(p.ts)},${y(p.remaining)}`).join(' ')}
        />
      ))}
    </svg>
  );
}

export function UsageHistory(): JSX.Element {
  const [period, setPeriod] = useState<UsagePeriod>('week');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [now] = useState(() => Date.now());
  const win = periodWindow(period, now, custom);

  const { data, error, isLoading } = useQuery({
    queryKey: ['usage-report', win?.since, win?.until],
    queryFn: () => api.usageReport(win!),
    enabled: win !== null,
  });

  const series = data ? buildBurndown(data.samples) : [];

  return (
    <>
      <Group label="Allowance left" testid="usage-history">
        <Row title="Period">
          <Pills
            options={USAGE_PERIODS}
            value={period}
            onChange={setPeriod}
            label="Period"
            testid="usage-period"
            labels={{ day: 'Day', week: 'Week', month: 'Month', custom: 'Custom' }}
          />
        </Row>
        {period === 'custom' ? (
          <Row title="Range">
            <input
              type="date"
              aria-label="From"
              data-testid="usage-from"
              value={custom.from}
              onChange={(e) => setCustom({ ...custom, from: e.target.value })}
            />
            <input
              type="date"
              aria-label="To"
              data-testid="usage-to"
              value={custom.to}
              onChange={(e) => setCustom({ ...custom, to: e.target.value })}
            />
          </Row>
        ) : null}
        {win === null ? (
          <Note testid="usage-pick-range">Pick a start and end date</Note>
        ) : error ? (
          <Note testid="usage-error">Could not read usage: {error.message}</Note>
        ) : isLoading ? (
          <Note>Loading…</Note>
        ) : series.length === 0 ? (
          <Note testid="usage-history-empty">No readings in this period</Note>
        ) : (
          <>
            <Burndown series={series} since={win.since} until={win.until} />
            <div data-testid="usage-legend">
              {series.map((s, i) => (
                <span key={s.key} style={{ color: COLOURS[i % COLOURS.length], marginRight: 12 }}>
                  {s.label}
                </span>
              ))}
            </div>
          </>
        )}
      </Group>
      <Group label="Chats by tokens" testid="usage-chats">
        {win === null || isLoading || error ? null : data && data.chats.length > 0 ? (
          data.chats.map((c) => (
            <Row
              key={`${c.hostId}/${c.chatId}`}
              title={c.name ?? c.chatId}
              testid={`usage-chat-${c.chatId}`}
            >
              <span data-testid={`usage-chat-tokens-${c.chatId}`}>{formatTokens(c.tokens)}</span>
            </Row>
          ))
        ) : (
          <Note testid="usage-chats-empty">No chat turns in this period</Note>
        )}
      </Group>
    </>
  );
}
