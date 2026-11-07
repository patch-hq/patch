// LevelBar — a thin horizontal meter of the live microphone level, shown while
// dictating so the composer feels live as the user speaks (the interim words
// lag the voice; this does not).

import type { CSSProperties, JSX } from 'react';

export function LevelBar({ level }: { level: number }): JSX.Element {
  const clamped = Math.max(0, Math.min(1, level));
  return (
    <div
      className="level-bar"
      data-testid="dictation-level"
      data-level={clamped.toFixed(2)}
      style={{ '--level': String(clamped) } as CSSProperties}
      aria-hidden
    >
      <div className="level-bar-fill" />
    </div>
  );
}
