// Settings → Usage: how the weekly allowance went down over a period, and
// which chats spent the tokens. A named period (Day / Week / Month) is read
// from the server's cache, so it draws at once and is re-read behind the
// page; a custom range is read live through every online host
// (GET /api/usage-report).

import { useState, type JSX } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/rest.js';
import { formatReadAt, formatTokens } from '../../lib/usage.js';
import {
  USAGE_PERIODS,
  buildBurndown,
  burndownPath,
  periodWindow,
  pageOf,
  type BurndownSeries,
  type UsagePeriod,
} from '../../lib/usageHistory.js';
import { Group, Note, Pills, Row } from './ui.js';

const W = 640;
const H = 200;
const PAD = { l: 36, r: 8, t: 8, b: 20 };
const COLOURS = ['#46802f', '#c46a12', '#574fa6', '#a64a3a'];

/** How often the page asks again while it is open; the server answers from its cache. */
const REFETCH_MS = 60_000;

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
        <path
          key={s.key}
          data-testid={`usage-line-${s.key}`}
          fill="none"
          stroke={COLOURS[i % COLOURS.length]}
          strokeWidth={2}
          strokeLinejoin="round"
          d={burndownPath(s.points, x, y)}
        />
      ))}
    </svg>
  );
}

export function UsageHistory(): JSX.Element {
  const [period, setPeriod] = useState<UsagePeriod>('week');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [chatPage, setChatPage] = useState(0);
  const [now] = useState(() => Date.now());
  const win = period === 'custom' ? periodWindow(period, now, custom) : null;
  const params =
    period === 'custom' ? (win ? { since: win.since, until: win.until } : null) : { period };

  const { data, error, isLoading } = useQuery({
    queryKey: ['usage-report', params],
    queryFn: () => api.usageReport(params!),
    enabled: params !== null,
    placeholderData: keepPreviousData,
    staleTime: REFETCH_MS,
    refetchInterval: period === 'custom' ? false : REFETCH_MS,
  });

  const series = data ? buildBurndown(data.samples) : [];
  const paged = pageOf(data?.chats ?? [], chatPage);
  const readAt = formatReadAt(data?.at);

  return (
    <>
      <Group label="Allowance left" testid="usage-history">
        <Row title="Period" sub={readAt ?? undefined}>
          <Pills
            options={USAGE_PERIODS}
            value={period}
            onChange={(p) => {
              setPeriod(p);
              setChatPage(0);
            }}
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
        {params === null ? (
          <Note testid="usage-pick-range">Pick a start and end date</Note>
        ) : error && !data ? (
          <Note testid="usage-error">Could not read usage: {error.message}</Note>
        ) : isLoading || !data ? (
          <Note testid="usage-loading">Reading…</Note>
        ) : series.length === 0 ? (
          <Note testid="usage-history-empty">No readings in this period</Note>
        ) : (
          <>
            <Burndown series={series} since={data.since} until={data.until} />
            <div className="usage-legend" data-testid="usage-legend">
              {series.map((s, i) => (
                <span key={s.key} style={{ color: COLOURS[i % COLOURS.length] }}>
                  {s.label}
                </span>
              ))}
            </div>
          </>
        )}
      </Group>
      <Group label="Chats by tokens" testid="usage-chats">
        {params === null || !data ? null : data.chats.length > 0 ? (
          <>
            {paged.rows.map((c) => (
              <Row
                key={`${c.hostId}/${c.chatId}`}
                title={c.name ?? c.chatId}
                testid={`usage-chat-${c.chatId}`}
              >
                <span data-testid={`usage-chat-tokens-${c.chatId}`}>{formatTokens(c.tokens)}</span>
              </Row>
            ))}
            {paged.pages > 1 ? (
              <Row title={`Page ${paged.page + 1} of ${paged.pages}`} testid="usage-chats-pager">
                <button
                  type="button"
                  className="set-btn ghost"
                  data-testid="usage-chats-prev"
                  disabled={paged.page === 0}
                  onClick={() => setChatPage(paged.page - 1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="set-btn ghost"
                  data-testid="usage-chats-next"
                  disabled={paged.page >= paged.pages - 1}
                  onClick={() => setChatPage(paged.page + 1)}
                >
                  Next
                </button>
              </Row>
            ) : null}
          </>
        ) : (
          <Note testid="usage-chats-empty">No chat turns in this period</Note>
        )}
      </Group>
    </>
  );
}
