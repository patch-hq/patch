// Opt-in raw recording of a meeting, to check by ear and by level what the mic,
// the echo-cancelled mic and the system tap actually carried. One WAV per lane
// (16 kHz mono PCM16) in a folder per meeting. Streamed to disk as it arrives,
// so an hour of audio is not held in memory. NO FALLBACK: a write failure throws.

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const RECORDING_LANES = ['mic-raw', 'mic-clean', 'system'] as const;
export type RecordingLane = (typeof RECORDING_LANES)[number];

const SAMPLE_RATE = 16000;

function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

export class MeetingRecorder {
  private files = new Map<RecordingLane, { fd: number; bytes: number }>();

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  append(lane: string, pcm: Buffer): void {
    if (!(RECORDING_LANES as readonly string[]).includes(lane)) {
      throw new Error(`unknown recording lane ${lane}`);
    }
    const name = lane as RecordingLane;
    let f = this.files.get(name);
    if (!f) {
      f = { fd: openSync(join(this.dir, `${name}.wav`), 'w'), bytes: 0 };
      writeSync(f.fd, wavHeader(0));
      this.files.set(name, f);
    }
    const whole = pcm.subarray(0, pcm.length - (pcm.length % 2));
    writeSync(f.fd, whole);
    f.bytes += whole.length;
  }

  /** Fixes up each header's length and closes the files. */
  end(): void {
    for (const f of this.files.values()) {
      writeSync(f.fd, wavHeader(f.bytes), 0, 44, 0);
      closeSync(f.fd);
    }
    this.files.clear();
  }
}
