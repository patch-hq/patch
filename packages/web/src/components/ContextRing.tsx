// ContextRing — how full the open chat's context window is, as a ring just left
// of Send (spec/14 § Composer — context ring), read as a gauge: a solid track
// that fills clockwise, with no text beside it — the figures live in the usage
// popover it opens when pressed. It remains present before the host has measured
// the chat (empty track), so usage details always have one stable home.

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
  const title = ctx
    ? `Context window ${ctx.percent} full · ${ctx.tokens}. How much of this chat the agent can hold in mind at once.`
    : 'Context window not measured yet. It shows how much of this chat the agent can hold in mind at once.';
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
        data-tooltip-full
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="18" height="18" viewBox="0 0 22 22" aria-hidden>
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
