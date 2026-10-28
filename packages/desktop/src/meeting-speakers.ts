// Naming who is talking on a call. The native helper (`patch-audio speakers`)
// reads the calling app's accessibility tree through macOS Accessibility and
// reports the text labels it finds; this module decides which of them mean
// "this person is a participant" and "this person is lit up as speaking".
// Keeping the reading in TypeScript means the patterns can be tuned (and tested)
// without recompiling the helper. NO FALLBACK: without the Accessibility
// permission the helper exits with a message, and the caller shows it.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface SpeakerSnapshot {
  /** Everyone the app lists on the call, the local user excluded. */
  participants: string[];
  /** Participants currently lit up as the active speaker. */
  speaking: string[];
}

const CONTROL_WORD =
  /^(start|stop|begin|end|turn on|turn off|mute|unmute|join|leave|share|open|close)(\s|$)/i;

/** "Priya (Host)", "Priya (Guest)" → "Priya". Null for the local user. */
function cleanName(raw: string): string | null {
  let name = raw.trim();
  if (/\((me|you)\)/i.test(name) || /^(you|me)$/i.test(name)) return null;
  // Button and menu text from the call UI ("Start speaking"), not a person.
  if (CONTROL_WORD.test(name)) return null;
  name = name.replace(
    /\s*\((host|co-host|guest|organizer|presenter|external|unverified)\)\s*$/i,
    '',
  );
  name = name.replace(/\s+/g, ' ').trim();
  return name.length > 0 && name.length <= 80 ? name : null;
}

// "Priya is speaking", "Priya, speaking", "Priya (speaking)", "Priya - Active speaker"
const SPEAKING_AFTER =
  /^(.+?)\s*(?:,|\(|-|–|—|\s)\s*(?:is\s+)?(?:currently\s+)?(?:speaking|talking|active speaker)\)?\.?$/i;
// "Active speaker: Priya", "Speaking: Priya"
const SPEAKING_BEFORE = /^(?:active speaker|speaking|now speaking)\s*[:\-–—]\s*(.+)$/i;
// "Priya, Muted", "Priya, Unmuted", "Priya, video on", "Priya, microphone on"
const PARTICIPANT =
  /^(.+?),\s*(?:muted|unmuted|mic(?:rophone)? (?:on|off)|video (?:on|off)|camera (?:on|off)|computer audio (?:connected|muted)|raised hand|hand raised)\b/i;

/** Which labels name a participant and which name a speaker. */
export function classifyLabels(labels: readonly string[]): SpeakerSnapshot {
  const participants = new Set<string>();
  const speaking = new Set<string>();
  for (const label of labels) {
    const text = label.trim();
    if (!text) continue;
    const speak = SPEAKING_BEFORE.exec(text) ?? SPEAKING_AFTER.exec(text);
    if (speak) {
      const name = cleanName(speak[1] as string);
      if (name) {
        speaking.add(name);
        participants.add(name);
      }
      continue;
    }
    const part = PARTICIPANT.exec(text);
    if (part) {
      const name = cleanName(part[1] as string);
      if (name) participants.add(name);
    }
  }
  return { participants: [...participants].sort(), speaking: [...speaking].sort() };
}

export function sameSnapshot(a: SpeakerSnapshot, b: SpeakerSnapshot): boolean {
  return (
    a.participants.join('\n') === b.participants.join('\n') &&
    a.speaking.join('\n') === b.speaking.join('\n')
  );
}

type Spawn = (cmd: string, args: string[]) => ChildProcessWithoutNullStreams;

export interface SpeakerHandlers {
  /** Called when the participants or the lit-up speakers change. */
  onSnapshot(snapshot: SpeakerSnapshot): void;
  /** The helper stopped without being asked to (e.g. Accessibility not allowed). */
  onFailed(message: string): void;
}

/** Runs `patch-audio speakers`: one JSON line `{labels: string[]}` per poll with a change. */
export function watchSpeakers(
  binary: string,
  handlers: SpeakerHandlers,
  spawnFn: Spawn = (cmd, args) => spawn(cmd, args),
): () => void {
  const child = spawnFn(binary, ['speakers']);
  let buffer = '';
  let stderr = '';
  let stopped = false;
  let last: SpeakerSnapshot = { participants: [], speaking: [] };
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { labels: string[] };
        if (!Array.isArray(parsed.labels)) throw new Error('no labels array');
        const next = classifyLabels(parsed.labels);
        if (sameSnapshot(last, next)) continue;
        last = next;
        handlers.onSnapshot(next);
      } catch (err) {
        handlers.onFailed(`unreadable speakers output: ${(err as Error).message}`);
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.on('error', (err) => handlers.onFailed(err.message));
  child.on('exit', (code, signal) => {
    if (!stopped) handlers.onFailed(stderr.trim() || `speakers exited (${signal ?? code})`);
  });
  return () => {
    stopped = true;
    child.kill('SIGTERM');
  };
}
