// TimeDial — a clock-face time picker in the style of Android's: a big
// HH:MM readout (tap either half to switch), an AM/PM toggle, and a round dial
// you tap or drag. Picking an hour moves on to the minutes by itself. The value
// in and out is 24-hour hours + minutes, so callers keep one representation.

import { useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';

const SIZE = 216;
const C = SIZE / 2;
const LABEL_R = 82;
const HAND_R = 82;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Pixel position of a dial angle (0° = 12 o'clock, clockwise). */
function at(deg: number, r: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: C + r * Math.sin(rad), y: C - r * Math.cos(rad) };
}

export interface TimeDialProps {
  hh: number;
  mm: number;
  onChange: (hh: number, mm: number) => void;
  testId: string;
}

export function TimeDial({ hh, mm, onChange, testId }: TimeDialProps): JSX.Element {
  const [mode, setMode] = useState<'h' | 'm'>('h');
  const dialRef = useRef<HTMLDivElement>(null);
  const pm = hh >= 12;
  const h12 = hh % 12 === 0 ? 12 : hh % 12;

  const setHour12 = (h: number): void => onChange((h % 12) + (pm ? 12 : 0), mm);
  const setMinute = (m: number): void => onChange(hh, ((m % 60) + 60) % 60);

  /** The dial value under a pointer: an hour 1–12 or a minute 0–59. */
  function fromPointer(e: ReactPointerEvent): void {
    const rect = dialRef.current!.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    if (mode === 'h') setHour12(Math.round(deg / 30) % 12 || 12);
    else setMinute(Math.round(deg / 6));
  }

  const handDeg = mode === 'h' ? (h12 % 12) * 30 : mm * 6;
  const tip = at(handDeg, HAND_R);
  const offFive = mode === 'm' && mm % 5 !== 0;
  const labels = Array.from({ length: 12 }, (_, i) => {
    const n = mode === 'h' ? (i === 0 ? 12 : i) : i * 5;
    return { n, ...at(i * 30, LABEL_R) };
  });

  return (
    <div className="tdial" data-testid={testId}>
      <div className="tdial-head">
        <button
          type="button"
          className={`tdial-seg${mode === 'h' ? ' on' : ''}`}
          aria-label="Hour"
          data-testid={`${testId}-hour`}
          onClick={() => setMode('h')}
        >
          {pad(h12)}
        </button>
        <span className="tdial-colon">:</span>
        <button
          type="button"
          className={`tdial-seg${mode === 'm' ? ' on' : ''}`}
          aria-label="Minute"
          data-testid={`${testId}-minute`}
          onClick={() => setMode('m')}
        >
          {pad(mm)}
        </button>
        <span className="tdial-ampm">
          {(['AM', 'PM'] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={(p === 'PM') === pm ? 'on' : ''}
              data-testid={`${testId}-${p.toLowerCase()}`}
              onClick={() => onChange((hh + ((p === 'PM') === pm ? 0 : 12)) % 24, mm)}
            >
              {p}
            </button>
          ))}
        </span>
      </div>
      <div
        className="tdial-face"
        ref={dialRef}
        data-testid={`${testId}-face`}
        style={{ width: SIZE, height: SIZE }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons > 0) fromPointer(e);
        }}
        onPointerUp={() => {
          if (mode === 'h') setMode('m');
        }}
      >
        <svg width={SIZE} height={SIZE} aria-hidden>
          <line x1={C} y1={C} x2={tip.x} y2={tip.y} className="tdial-hand" />
          <circle cx={C} cy={C} r={3} className="tdial-pin" />
          <circle cx={tip.x} cy={tip.y} r={offFive ? 4 : 18} className="tdial-knob" />
        </svg>
        {labels.map((l) => {
          const picked = mode === 'h' ? l.n === h12 : l.n === mm;
          return (
            <button
              key={l.n}
              type="button"
              tabIndex={-1}
              className={`tdial-n${picked ? ' on' : ''}`}
              style={{ left: l.x, top: l.y }}
              data-testid={`${testId}-${mode}-${l.n}`}
              // The mouse/finger is handled by the dial itself (so a drag lands
              // between the numbers); the numbers ignore pointers and only
              // answer a programmatic click.
              onClick={() => {
                if (mode === 'h') {
                  setHour12(l.n);
                  setMode('m');
                } else setMinute(l.n);
              }}
            >
              {mode === 'm' ? pad(l.n) : l.n}
            </button>
          );
        })}
      </div>
    </div>
  );
}
