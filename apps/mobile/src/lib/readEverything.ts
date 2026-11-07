// Read everything: speak each assistant reply that settles while a chat is open.
// A reply counts as new only if it is past the seq seen on arrival AND the host
// stamped it within the last minute, so a replay never reads history.

import React from 'react';
import type { ChatEventEntry } from '../stores/chatStore';
import { speakOrToast, useReadAloud } from './readAloud';

export const FRESH_MS = 60_000;

/** The newest settled assistant reply past `baseline`, stamped within a minute of `now`. */
export function freshReply(
  timeline: readonly ChatEventEntry[],
  baseline: number,
  now: number,
): ChatEventEntry | undefined {
  let fresh: ChatEventEntry | undefined;
  for (const e of timeline) {
    if (e.kind !== 'message' || e.role !== 'assistant') continue;
    if (
      e.seq > baseline &&
      e.messageAt !== undefined &&
      now - e.messageAt < FRESH_MS &&
      (fresh === undefined || e.seq > fresh.seq)
    ) {
      fresh = e;
    }
  }
  return fresh;
}

export function latestAssistantSeq(timeline: readonly ChatEventEntry[]): number {
  let latest = -1;
  for (const e of timeline) {
    if (e.kind === 'message' && e.role === 'assistant' && e.seq > latest) {
      latest = e.seq;
    }
  }
  return latest;
}

export function useReadEverything(chatId: string, timeline: readonly ChatEventEntry[]): void {
  const readAll = useReadAloud((s) => s.readAll);
  const baseline = React.useRef<number | null>(null);
  React.useEffect(() => {
    baseline.current = null;
  }, [chatId]);
  React.useEffect(() => {
    const prev = baseline.current;
    const fresh = prev === null ? undefined : freshReply(timeline, prev, Date.now());
    if (timeline.length > 0) {
      baseline.current = Math.max(prev ?? -1, latestAssistantSeq(timeline));
    }
    if (readAll && fresh !== undefined) {
      speakOrToast(`${chatId}:${fresh.seq}`, fresh.content ?? '');
    }
  }, [timeline, readAll, chatId]);
}
