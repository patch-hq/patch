// The card for a `patch_ask_human` call: the agent is blocked on something only
// the user can do, so the task is drawn in the transcript where it can be acted
// on — links are links, a device code is a one-tap copy — instead of sitting
// inside a collapsed tool row (spec/14 § Main chat panel — Action requests).

import type { JSX } from 'react';
import { useState } from 'react';
import { Check, Copy, Hand } from 'lucide-react';
import { splitActionText } from '@patch/wire';

function ActionText({ text }: { text: string }): JSX.Element {
  return (
    <>
      {splitActionText(text).map((seg, i) => {
        if (seg.kind === 'link') {
          return (
            <a
              key={i}
              className="ask-human-link"
              data-testid="ask-human-link"
              href={seg.href}
              target="_blank"
              rel="noreferrer"
            >
              {seg.text}
            </a>
          );
        }
        if (seg.kind === 'code') return <CopyCode key={i} code={seg.text} />;
        return <span key={i}>{seg.text}</span>;
      })}
    </>
  );
}

function CopyCode({ code }: { code: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ask-human-code"
      data-testid="ask-human-code"
      data-copied={copied}
      aria-label={`Copy code ${code}`}
      onClick={() => {
        void navigator.clipboard.writeText(code).then(() => setCopied(true));
      }}
    >
      <code>{code}</code>
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </button>
  );
}

export function AskHumanCard({ task, why }: { task: string; why?: string }): JSX.Element {
  return (
    <div
      className="ask-human-card"
      data-testid="ask-human-card"
      role="group"
      aria-label="action needed"
    >
      <Hand size={14} aria-hidden className="ask-human-icon" />
      <div className="ask-human-body">
        <p className="ask-human-task" data-testid="ask-human-task">
          <ActionText text={task} />
        </p>
        {why ? (
          <p className="ask-human-why" data-testid="ask-human-why">
            <ActionText text={why} />
          </p>
        ) : null}
      </div>
    </div>
  );
}
