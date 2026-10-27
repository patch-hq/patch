// DateTimeField — the app's own date + time picker, replacing the browser's
// native `datetime-local` popup (unstyled, OS-blue, off-theme). The value is
// the same browser-local wall-clock string `datetime-local` produced
// ("YYYY-MM-DDTHH:mm", empty = unset), so callers don't change. The text box
// also accepts typing; the calendar button opens the popover.

import { useEffect, useRef, useState, type JSX } from 'react';
import { TimeDial } from './TimeDial.js';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DEFAULT_TIME = '09:00';

const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number): string => `${y}-${pad(m + 1)}-${pad(d)}`;

const VALUE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

function parse(v: string): { y: number; m: number; d: number; hh: number; mm: number } | null {
  const g = VALUE_RE.exec(v.trim());
  if (!g) return null;
  const [y, m, d, hh, mm] = g.slice(1).map(Number) as [number, number, number, number, number];
  const dt = new Date(y, m - 1, d, hh, mm);
  if (dt.getMonth() !== m - 1 || dt.getDate() !== d || hh > 23 || mm > 59) return null;
  return { y, m: m - 1, d, hh, mm };
}

export interface DateTimeFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId: string;
  /** Show the calendar and dial open under the box, with no toggle button. */
  inline?: boolean;
}

export function DateTimeField({
  label,
  value,
  onChange,
  testId,
  inline = false,
}: DateTimeFieldProps): JSX.Element {
  const parsed = parse(value);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const today = new Date();
  const [view, setView] = useState({
    y: parsed?.y ?? today.getFullYear(),
    m: parsed?.m ?? today.getMonth(),
  });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const time = parsed ? `${pad(parsed.hh)}:${pad(parsed.mm)}` : DEFAULT_TIME;
  const shown = draft ?? (parsed ? `${ymd(parsed.y, parsed.m, parsed.d)} ${time}` : '');

  function openPopover(): void {
    if (parsed) setView({ y: parsed.y, m: parsed.m });
    setOpen(true);
  }

  function shift(delta: number): void {
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }

  function pickDay(y: number, m: number, d: number): void {
    setDraft(null);
    onChange(`${ymd(y, m, d)}T${time}`);
  }

  function setTime(hh: number, mm: number): void {
    const base = parsed ?? {
      y: today.getFullYear(),
      m: today.getMonth(),
      d: today.getDate(),
    };
    setDraft(null);
    onChange(`${ymd(base.y, base.m, base.d)}T${pad(hh)}:${pad(mm)}`);
  }

  function typed(text: string): void {
    setDraft(text);
    if (text.trim() === '') {
      setDraft(null);
      onChange('');
      return;
    }
    const p = parse(text);
    if (p) {
      setDraft(null);
      onChange(`${ymd(p.y, p.m, p.d)}T${pad(p.hh)}:${pad(p.mm)}`);
    }
  }

  const first = new Date(view.y, view.m, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  const todayKey = ymd(today.getFullYear(), today.getMonth(), today.getDate());
  const selectedKey = parsed ? ymd(parsed.y, parsed.m, parsed.d) : null;

  return (
    <div className="dtf" ref={rootRef}>
      <label>
        {label}
        <span className="dtf-row">
          <input
            type="text"
            inputMode="numeric"
            placeholder="YYYY-MM-DD HH:mm"
            value={shown}
            onChange={(e) => typed(e.target.value)}
            data-testid={testId}
          />
          {inline ? null : (
            <button
              type="button"
              className="dtf-open"
              aria-label={`Pick ${label.toLowerCase()} date`}
              aria-expanded={open}
              data-testid={`${testId}-open`}
              onClick={() => (open ? setOpen(false) : openPopover())}
            >
              ▾
            </button>
          )}
        </span>
      </label>
      {open || inline ? (
        <div
          className={inline ? 'dtf-popover dtf-inline' : 'dtf-popover'}
          role="dialog"
          aria-label={`${label} picker`}
          data-testid={`${testId}-popover`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div className="dtf-body">
            <div className="dtf-cal">
              <div className="dtf-head">
                <button
                  type="button"
                  aria-label="Previous month"
                  data-testid={`${testId}-prev`}
                  onClick={() => shift(-1)}
                >
                  ‹
                </button>
                <span data-testid={`${testId}-month`}>
                  {MONTHS[view.m]} {view.y}
                </span>
                <button
                  type="button"
                  aria-label="Next month"
                  data-testid={`${testId}-next`}
                  onClick={() => shift(1)}
                >
                  ›
                </button>
              </div>
              <div className="dtf-grid">
                {WEEKDAYS.map((w) => (
                  <span key={w} className="dtf-wd">
                    {w}
                  </span>
                ))}
                {cells.map((d, i) => {
                  if (d === null) return <span key={`b${i}`} />;
                  const key = ymd(view.y, view.m, d);
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`dtf-day${key === selectedKey ? ' is-selected' : ''}${key === todayKey ? ' is-today' : ''}`}
                      data-testid={`${testId}-day-${key}`}
                      onClick={() => pickDay(view.y, view.m, d)}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </div>
            <TimeDial
              hh={Number(time.slice(0, 2))}
              mm={Number(time.slice(3))}
              onChange={setTime}
              testId={`${testId}-time`}
            />
          </div>
          <div className="dtf-foot">
            <button
              type="button"
              data-testid={`${testId}-clear`}
              onClick={() => {
                setDraft(null);
                onChange('');
                setOpen(false);
              }}
            >
              Clear
            </button>
            {inline ? null : (
              <button
                type="button"
                className="dtf-done"
                data-testid={`${testId}-done`}
                onClick={() => setOpen(false)}
              >
                Done
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
