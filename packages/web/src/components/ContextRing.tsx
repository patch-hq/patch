// ContextRing — how full the open chat's context window is, as a ring just left
// of Send (spec/14 § Composer — context ring), read as a gauge: a solid track
// that fills clockwise, with the percentage said beside it. Pressing it opens
// the usage popover. It remains present before the host has measured the chat
// (empty track, `–`), so usage details always have one stable home.

import { useRef, useState, type JSX } from 'react';
import { useChatStore } from '../stores/chatStore.js';
import { summariseContext } from '../lib/usage.js';
import { UsagePopover } from './UsagePopover.js';

const R = 8;
const C = 2 * Math.PI * R;

export function ContextRing({ chatId }: { chatId: string }): JSX.Element {
  const context = useChatStore((s) => s.chats[chatId]?.context ?? null);
  const ctx = summariseContext(context);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const level = ctx?.level ?? 'unknown';
  const label = ctx ? `Context ${ctx.percent}` : 'Usage details';
  const title = ctx ? `Context ${ctx.percent} · ${ctx.tokens}` : 'Usage · context not measured';
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`context-ring ${level}`}
        data-testid="context-ring"
        aria-label={label}
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
          <circle className="context-ring-track" cx="11" cy="11" r={R} />
          <circle
            className="context-ring-fill"
            cx="11"
            cy="11"
            r={R}
            strokeDasharray={C}
            strokeDashoffset={C * (1 - (ctx?.fraction ?? 0))}
            transform="rotate(-90 11 11)"
          />
        </svg>
        <span className="context-ring-label" data-testid="context-ring-label">
          {ctx?.percent ?? '–'}
        </span>
      </button>
      {open ? (
        <UsagePopover
          anchorRef={ref}
          direction="up"
          align="end"
          context={context}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
