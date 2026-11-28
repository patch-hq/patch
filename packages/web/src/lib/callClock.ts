// The clock a call keeps time by on the web and desktop app (spec/07 § A call
// keeps going in the background): its line's heartbeat watchdog, answer timeout
// and redial backoff, and Pause when quiet.
//
// A page's own timers are not trustworthy once its tab is in the background or
// its window hidden: browsers align them to a second at best and, after a few
// minutes hidden, to a minute — long enough for a dropped call to sit dead
// instead of redialling. A dedicated worker's timers are not throttled that
// way, so the call's timers are kept there and only their firing comes back to
// the page, as a message the page handles at once. (The socket's own messages,
// heartbeats included, are answered in their handler and never waited on a
// timer.) The desktop app runs this same code with background throttling off
// as well.
//
// NO FALLBACK: a browser with no Worker cannot keep a call's time, and says so.

import type { CallLineClock } from '@patch/wire/call-line';

const WORKER_SOURCE = `
const timers = new Map();
onmessage = (e) => {
  const m = e.data;
  if (m.op === 'set') {
    timers.set(m.id, setTimeout(() => { timers.delete(m.id); postMessage(m.id); }, m.ms));
  } else {
    clearTimeout(timers.get(m.id));
    timers.delete(m.id);
  }
};
`;

let worker: Worker | null = null;
const pending = new Map<number, () => void>();
let nextId = 1;

function clockWorker(): Worker {
  if (worker) return worker;
  if (typeof Worker === 'undefined') {
    throw new Error('this browser has no Worker, so a call cannot keep time in the background');
  }
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  w.onmessage = (e: MessageEvent<number>): void => {
    const fn = pending.get(e.data);
    if (fn === undefined) return;
    pending.delete(e.data);
    fn();
  };
  w.onerror = (e): void => {
    console.error(`[patch-voice] call clock worker failed: ${e.message}`);
  };
  worker = w;
  return w;
}

export const callClock: CallLineClock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const w = clockWorker();
    const id = nextId++;
    pending.set(id, fn);
    w.postMessage({ op: 'set', id, ms });
    return id;
  },
  clearTimeout(handle) {
    const id = handle as number;
    if (!pending.delete(id)) return;
    clockWorker().postMessage({ op: 'clear', id });
  },
};
